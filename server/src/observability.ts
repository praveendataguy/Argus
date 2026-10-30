import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { store, type AgentEvent } from "./store.js";

/* ================================ audit log ================================ */

export interface AuditEntry {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  runId?: string;
  message: string;
  data?: unknown;
  prevHash: string;
  hash: string;
}

const AUDIT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/audit.jsonl");
const GENESIS = "0".repeat(64);

const digest = (e: Omit<AuditEntry, "hash">) =>
  createHash("sha256")
    .update(JSON.stringify([e.seq, e.ts, e.type, e.actor, e.runId ?? null, e.message, e.data ?? null, e.prevHash]))
    .digest("hex");

/**
 * Append-only, hash-chained audit log. Each entry commits to the previous
 * entry's hash, so editing or deleting any past line breaks verification
 * from that point on. Persisted as JSONL under data/.
 */
class AuditLog {
  private head = { seq: 0, hash: GENESIS };
  private recent: AuditEntry[] = [];

  constructor() {
    mkdirSync(dirname(AUDIT_FILE), { recursive: true });
    if (existsSync(AUDIT_FILE)) {
      const lines = readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean);
      const last = lines.at(-1);
      if (last) {
        const e = JSON.parse(last) as AuditEntry;
        this.head = { seq: e.seq, hash: e.hash };
      }
      this.recent = lines.slice(-500).map((l) => JSON.parse(l));
    }
  }

  append(type: string, actor: string, message: string, extra: { runId?: string; data?: unknown } = {}) {
    const base = { seq: this.head.seq + 1, ts: new Date().toISOString(), type, actor, runId: extra.runId, message, data: extra.data, prevHash: this.head.hash };
    const entry: AuditEntry = { ...base, hash: digest(base) };
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
    this.head = { seq: entry.seq, hash: entry.hash };
    this.recent.push(entry);
    if (this.recent.length > 500) this.recent.shift();
    elastic.push(entry);
    return entry;
  }

  tail(limit = 200) {
    return this.recent.slice(-limit).reverse();
  }

  get headInfo() {
    return { ...this.head, file: "data/audit.jsonl" };
  }

  /** Re-reads the whole file and recomputes every link in the chain. */
  verify() {
    if (!existsSync(AUDIT_FILE)) return { ok: true, entries: 0 };
    const lines = readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean);
    let prev = GENESIS;
    for (const [i, line] of lines.entries()) {
      let e: AuditEntry;
      try {
        e = JSON.parse(line);
      } catch {
        return { ok: false, entries: lines.length, brokenAt: i + 1, reason: "Unparseable line" };
      }
      const { hash, ...rest } = e;
      if (e.prevHash !== prev) return { ok: false, entries: lines.length, brokenAt: e.seq, reason: "Link to previous entry does not match" };
      if (digest(rest) !== hash) return { ok: false, entries: lines.length, brokenAt: e.seq, reason: "Entry contents were modified" };
      prev = hash;
    }
    return { ok: true, entries: lines.length, head: prev };
  }

  file() {
    return existsSync(AUDIT_FILE) ? readFileSync(AUDIT_FILE, "utf8") : "";
  }
}

/* ============================ optional Elastic sink ============================ */

/** Ships audit entries to Elastic in small batches when ELASTIC_URL and ELASTIC_API_KEY are set. */
const elastic = {
  queue: [] as AuditEntry[],
  timer: undefined as NodeJS.Timeout | undefined,
  enabled: Boolean(process.env.ELASTIC_URL && process.env.ELASTIC_API_KEY),
  index: process.env.ELASTIC_INDEX ?? "argus-audit",
  push(e: AuditEntry) {
    if (!this.enabled) return;
    this.queue.push(e);
    this.timer ??= setTimeout(() => this.flush(), 2000);
  },
  async flush() {
    this.timer = undefined;
    const batch = this.queue.splice(0);
    if (!batch.length) return;
    const body = batch.map((e) => `${JSON.stringify({ index: { _index: this.index, _id: e.hash } })}\n${JSON.stringify({ ...e, "@timestamp": e.ts })}\n`).join("");
    try {
      const res = await fetch(`${process.env.ELASTIC_URL}/_bulk`, {
        method: "POST",
        headers: { Authorization: `ApiKey ${process.env.ELASTIC_API_KEY}`, "Content-Type": "application/x-ndjson" },
        body,
      });
      if (!res.ok) console.warn(`Elastic bulk failed: ${res.status}`);
    } catch (err) {
      console.warn("Elastic unreachable:", err instanceof Error ? err.message : err);
    }
  },
};

export const audit = new AuditLog();

/* ================================ run traces ================================= */

export interface ToolSpan {
  name: string;
  ms: number;
  ok: boolean;
}

export interface RunTrace {
  runId: string;
  agent: string;
  engine: "ai" | "rules-engine";
  model: string;
  task: string;
  startedAt: string;
  ms?: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  tools: ToolSpan[];
  status: "running" | "ok" | "error" | "refused";
  outcome?: string;
}

// USD per million tokens. Override with MODEL_PRICE_IN / MODEL_PRICE_OUT if you switch models.
const PRICE = {
  input: Number(process.env.MODEL_PRICE_IN ?? 4),
  output: Number(process.env.MODEL_PRICE_OUT ?? 20),
  cacheRead: Number(process.env.MODEL_PRICE_CACHE_READ ?? 0.2),
};

export const runs: RunTrace[] = [];
const byId = new Map<string, RunTrace>();

export function startRun(runId: string, agent: string, task: string, engine: RunTrace["engine"] = "ai") {
  const r: RunTrace = {
    runId,
    agent,
    engine,
    model: engine === "ai" ? config.anthropic.model : "rules-engine",
    task: task.slice(0, 200),
    startedAt: new Date().toISOString(),
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    tools: [],
    status: "running",
  };
  runs.unshift(r);
  byId.set(runId, r);
  if (runs.length > 300) byId.delete(runs.pop()!.runId);
  audit.append("run.start", agent, task.slice(0, 200), { runId, data: { engine, model: r.model } });
  return r;
}

export function recordUsage(runId: string, usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null } | undefined) {
  const r = byId.get(runId);
  if (!r || !usage) return;
  r.steps++;
  r.inputTokens += usage.input_tokens ?? 0;
  r.outputTokens += usage.output_tokens ?? 0;
  r.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  r.costUsd = (r.inputTokens * PRICE.input + r.outputTokens * PRICE.output + r.cacheReadTokens * PRICE.cacheRead) / 1e6;
}

export function recordTool(runId: string, span: ToolSpan) {
  byId.get(runId)?.tools.push(span);
}

export function endRun(runId: string, status: RunTrace["status"], outcome?: string) {
  const r = byId.get(runId);
  if (!r) return;
  r.status = status;
  r.outcome = outcome?.slice(0, 400);
  r.ms = Date.now() - Date.parse(r.startedAt);
  audit.append("run.end", r.agent, `${status} in ${r.ms}ms`, {
    runId,
    data: { tokens: { in: r.inputTokens, out: r.outputTokens, cacheRead: r.cacheReadTokens }, costUsd: Number(r.costUsd.toFixed(5)), tools: r.tools.length, outcome: r.outcome },
  });
  store.changed("observability");
}

/* ============================== PayPal API calls ============================== */

export interface ApiCall {
  ts: string;
  gateway: string;
  method: string;
  ms: number;
  ok: boolean;
  error?: string;
}

export const apiCalls: ApiCall[] = [];

/** Wraps a gateway so every PayPal call is timed, counted and written to the audit log. */
export function instrument<T extends object>(gateway: T, name: string): T {
  return new Proxy(gateway, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const t0 = Date.now();
        try {
          const out = await value.apply(target, args);
          log(String(prop), Date.now() - t0, true);
          return out;
        } catch (err) {
          log(String(prop), Date.now() - t0, false, err instanceof Error ? err.message : String(err));
          throw err;
        }
      };
    },
  });

  function log(method: string, ms: number, ok: boolean, error?: string) {
    apiCalls.unshift({ ts: new Date().toISOString(), gateway: name, method, ms, ok, error });
    if (apiCalls.length > 500) apiCalls.pop();
    audit.append("paypal.call", `paypal-${name}`, `${method} ${ok ? "ok" : "failed"} (${ms}ms)`, { data: error ? { error } : undefined });
  }
}

/* ============================== metrics snapshot ============================== */

const p95 = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};

export function snapshot() {
  const agents = new Map<string, RunTrace[]>();
  for (const r of runs) agents.set(r.agent, [...(agents.get(r.agent) ?? []), r]);
  const perAgent = [...agents].map(([agent, rs]) => {
    const done = rs.filter((r) => r.ms !== undefined);
    return {
      agent,
      runs: rs.length,
      errors: rs.filter((r) => r.status === "error" || r.status === "refused").length,
      avgMs: done.length ? Math.round(done.reduce((s, r) => s + r.ms!, 0) / done.length) : 0,
      p95Ms: p95(done.map((r) => r.ms!)),
      tokens: rs.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0),
      costUsd: rs.reduce((s, r) => s + r.costUsd, 0),
      toolCalls: rs.reduce((s, r) => s + r.tools.length, 0),
    };
  });
  const methods = new Map<string, ApiCall[]>();
  for (const c of apiCalls) methods.set(`${c.gateway}:${c.method}`, [...(methods.get(`${c.gateway}:${c.method}`) ?? []), c]);
  const paypal = [...methods].map(([key, cs]) => ({
    key,
    calls: cs.length,
    errors: cs.filter((c) => !c.ok).length,
    avgMs: Math.round(cs.reduce((s, c) => s + c.ms, 0) / cs.length),
    p95Ms: p95(cs.map((c) => c.ms)),
  }));
  const approvals = [...store.approvals.values()];
  return {
    totals: {
      runs: runs.length,
      aiRuns: runs.filter((r) => r.engine === "ai").length,
      costUsd: runs.reduce((s, r) => s + r.costUsd, 0),
      tokens: runs.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0),
      paypalCalls: apiCalls.length,
      paypalErrors: apiCalls.filter((c) => !c.ok).length,
      approvals: {
        pending: approvals.filter((a) => a.status === "PENDING").length,
        auto: approvals.filter((a) => a.autoApproved).length,
        human: approvals.filter((a) => !a.autoApproved && (a.status === "EXECUTED" || a.status === "REJECTED")).length,
        rejected: approvals.filter((a) => a.status === "REJECTED").length,
        failed: approvals.filter((a) => a.status === "FAILED").length,
      },
    },
    perAgent,
    paypal,
    runs: runs.slice(0, 60),
    audit: { ...audit.headInfo, elastic: elastic.enabled ? elastic.index : null },
  };
}

/** Mirror every feed event into the audit log. */
export function attachAudit() {
  store.on("event", (e: AgentEvent) => audit.append(`agent.${e.kind}`, e.agent, e.message, { runId: e.runId }));
}
