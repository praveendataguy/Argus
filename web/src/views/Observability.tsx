import { useEffect, useState } from "react";
import { ago, api } from "../api";
import type { AppState } from "../types";

interface RunTrace {
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
  tools: { name: string; ms: number; ok: boolean }[];
  status: string;
  outcome?: string;
}

interface Snapshot {
  totals: {
    runs: number;
    aiRuns: number;
    costUsd: number;
    tokens: number;
    paypalCalls: number;
    paypalErrors: number;
    approvals: { pending: number; auto: number; human: number; rejected: number; failed: number };
  };
  perAgent: { agent: string; runs: number; errors: number; avgMs: number; p95Ms: number; tokens: number; costUsd: number; toolCalls: number }[];
  paypal: { key: string; calls: number; errors: number; avgMs: number; p95Ms: number }[];
  runs: RunTrace[];
  audit: { seq: number; hash: string; file: string; elastic: string | null };
}

interface AuditEntry {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  runId?: string;
  message: string;
  hash: string;
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const ms = (n?: number) => (n === undefined ? "…" : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);

export function Observability({ state }: { state: AppState }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [log, setLog] = useState<AuditEntry[]>([]);
  const [verify, setVerify] = useState<{ ok: boolean; entries: number; brokenAt?: number; reason?: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api<Snapshot>("/observability").then(setSnap);
    api<AuditEntry[]>("/audit?limit=200").then(setLog);
  }, [state.events.length, state.approvals]);

  if (!snap) return <p className="muted">Loading telemetry…</p>;
  const t = snap.totals;
  const shown = log.filter((e) => !filter || `${e.type} ${e.actor} ${e.message}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="obs">
      <section className="kpis">
        <div className="kpi"><div className="kpi-label">Agent runs</div><div className="kpi-value">{t.runs}</div><div className="kpi-sub">{t.aiRuns} on Claude · {t.runs - t.aiRuns} rules engine</div></div>
        <div className="kpi"><div className="kpi-label">AI spend</div><div className="kpi-value">{money(t.costUsd)}</div><div className="kpi-sub">{t.tokens.toLocaleString()} tokens</div></div>
        <div className={`kpi ${t.paypalErrors ? "kpi-red" : ""}`}><div className="kpi-label">PayPal API calls</div><div className="kpi-value">{t.paypalCalls}</div><div className="kpi-sub">{t.paypalErrors} failed</div></div>
        <div className="kpi"><div className="kpi-label">Money decisions</div><div className="kpi-value">{t.approvals.auto + t.approvals.human}</div><div className="kpi-sub">{t.approvals.auto} by policy · {t.approvals.human} by a human · {t.approvals.pending} pending</div></div>
      </section>

      <div className="obs-grid">
        <section className="panel">
          <h2>Agents</h2>
          <table className="table">
            <thead><tr><th>Agent</th><th>Runs</th><th>Avg</th><th>p95</th><th>Tool calls</th><th>Tokens</th><th>Cost</th><th>Errors</th></tr></thead>
            <tbody>
              {snap.perAgent.map((a) => (
                <tr key={a.agent}>
                  <td>{a.agent}</td><td>{a.runs}</td><td>{ms(a.avgMs)}</td><td>{ms(a.p95Ms)}</td><td>{a.toolCalls}</td><td>{a.tokens.toLocaleString()}</td><td>{money(a.costUsd)}</td>
                  <td className={a.errors ? "bad" : ""}>{a.errors}</td>
                </tr>
              ))}
              {snap.perAgent.length === 0 && <tr><td colSpan={8} className="muted">No runs yet.</td></tr>}
            </tbody>
          </table>

          <h2 className="mt">PayPal APIs</h2>
          <table className="table">
            <thead><tr><th>Gateway · call</th><th>Calls</th><th>Avg</th><th>p95</th><th>Errors</th></tr></thead>
            <tbody>
              {snap.paypal.map((p) => (
                <tr key={p.key}><td className="mono small">{p.key}</td><td>{p.calls}</td><td>{ms(p.avgMs)}</td><td>{ms(p.p95Ms)}</td><td className={p.errors ? "bad" : ""}>{p.errors}</td></tr>
              ))}
              {snap.paypal.length === 0 && <tr><td colSpan={5} className="muted">No PayPal calls yet.</td></tr>}
            </tbody>
          </table>

          <h2 className="mt">Run traces</h2>
          <div className="traces">
            {snap.runs.map((r) => {
              const max = Math.max(1, ...r.tools.map((x) => x.ms), r.ms ?? 1);
              return (
                <div key={r.runId} className={`trace trace-${r.status}`}>
                  <button className="trace-head" onClick={() => setOpen(open === r.runId ? null : r.runId)}>
                    <span className="mono small">{r.runId}</span>
                    <b>{r.agent}</b>
                    <span className="muted small trace-task">{r.task}</span>
                    <span className="small">{ms(r.ms)}</span>
                    <span className="small muted">{r.engine === "ai" ? `${(r.inputTokens + r.outputTokens).toLocaleString()} tok · ${money(r.costUsd)}` : "rules"}</span>
                    <span className={`status status-${r.status === "ok" ? "completed" : r.status === "running" ? "open" : "held"}`}>{r.status}</span>
                  </button>
                  {open === r.runId && (
                    <div className="trace-body">
                      <div className="small muted">
                        {r.model} · {r.steps} model step(s) · in {r.inputTokens} / out {r.outputTokens} / cache {r.cacheReadTokens} · started {ago(r.startedAt)}
                      </div>
                      {r.tools.map((x, i) => (
                        <div key={i} className="span">
                          <span className="mono small">{x.name}</span>
                          <span className="spanbar"><span style={{ width: `${(x.ms / max) * 100}%` }} className={x.ok ? "" : "fail"} /></span>
                          <span className="small">{ms(x.ms)}</span>
                        </div>
                      ))}
                      {r.outcome && <p className="small">{r.outcome}</p>}
                    </div>
                  )}
                </div>
              );
            })}
            {snap.runs.length === 0 && <p className="empty">Run an agent anywhere in the app and its trace appears here.</p>}
          </div>
        </section>

        <section className="panel">
          <div className="row-between">
            <h2>Audit log</h2>
            <div className="row-gap">
              <button onClick={() => api<typeof verify>("/audit/verify").then(setVerify)}>🔗 Verify chain</button>
              <a className="btnlink" href="/api/audit/export" download>Export</a>
            </div>
          </div>
          <p className="small muted">
            Append-only and hash-chained ({snap.audit.file}). Each entry commits to the one before it, so editing any past record breaks verification.
            {snap.audit.elastic && <> Streaming to Elastic index <code>{snap.audit.elastic}</code>.</>}
          </p>
          <div className="small mono muted">head #{snap.audit.seq} · {snap.audit.hash.slice(0, 24)}…</div>
          {verify && (
            <div className={`answer ${verify.ok ? "verdict-benign" : "verdict-fraud"}`}>
              {verify.ok ? `✅ Chain intact: all ${verify.entries} entries verified.` : `🚨 Chain broken at entry #${verify.brokenAt}: ${verify.reason}`}
            </div>
          )}
          <input placeholder="Filter (e.g. paypal, refund, firewall)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="auditlog">
            {shown.map((e) => (
              <div key={e.seq} className="arow">
                <span className="mono muted">#{e.seq}</span>
                <span className="mono muted">{new Date(e.ts).toLocaleTimeString([], { hourCycle: "h23" })}</span>
                <span className="atype">{e.type}</span>
                <span className="aactor">{e.actor}</span>
                <span className="amsg">{e.message}</span>
                <span className="mono muted ahash" title={e.hash}>{e.hash.slice(0, 8)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
