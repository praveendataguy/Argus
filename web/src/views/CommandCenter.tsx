import { useEffect, useRef, useState } from "react";
import { ago, api, usd } from "../api";
import { approve, type PasskeyStatus } from "../security";
import type { AgentEvent, AppConfig, AppState, Approval } from "../types";
import { ThreatGlobePanel } from "./ThreatGlobe";

export function CommandCenter({ config, state }: { config: AppConfig; state: AppState }) {
  const txs = state.transactions;
  const gross = txs.reduce((s, t) => s + t.amount, 0);
  const blocked = txs
    .filter((t) => t.risk && (t.risk.action === "hold" || t.risk.action === "refund"))
    .reduce((s, t) => s + t.amount, 0);
  const exposure = state.disputes.filter((d) => d.status !== "RESOLVED").reduce((s, d) => s + d.amount, 0);
  const pending = state.approvals.filter((a) => a.status === "PENDING");
  const recent = state.approvals.filter((a) => a.status !== "PENDING").slice(0, 6);
  const unscored = txs.filter((t) => !t.risk).length;
  const [passkeys, setPasskeys] = useState<PasskeyStatus | null>(null);
  useEffect(() => {
    api<PasskeyStatus>("/passkey").then(setPasskeys).catch(() => undefined);
  }, [state.approvals.length]);

  return (
    <div className="cc">
      <section className="panel hero">
        <Radar txs={txs} />
        <div>
          <h1>
            Argus is guarding <em>{usd(gross)}</em> in PayPal payments
          </h1>
          <p>Every capture is scored, linked and watched by AI agents. Money only moves inside the policy you set, and every decision is signed and logged.</p>
          <div className="hero-stats">
            <div><b>{txs.filter((t) => t.risk).length}</b><span>payments scored</span></div>
            <div><b>{txs.filter((t) => (t.risk?.score ?? 0) >= 60).length}</b><span>high-risk caught</span></div>
            <div><b>{state.approvals.filter((a) => a.status === "EXECUTED").length}</b><span>actions executed</span></div>
            <div><b>{state.events.length}</b><span>agent events</span></div>
          </div>
        </div>
      </section>

      <section className="kpis">
        <Kpi label="Gross volume" value={usd(gross)} sub={`${txs.length} PayPal captures`} spark={daily(txs, (t) => t.amount)} />
        <Kpi label="Fraud stopped" value={usd(blocked)} sub="held or cancelled before shipping" tone="green" spark={txs.filter((t) => t.risk).map((t) => t.risk!.score)} />
        <Kpi label="Dispute exposure" value={usd(exposure)} sub={`${state.disputes.filter((d) => d.status !== "RESOLVED").length} open cases`} tone="amber" spark={daily(txs, (t) => (t.buyer.accountAgeDays < 30 ? t.amount : 0))} />
        <Kpi label="Awaiting you" value={String(pending.length)} sub={`auto-approve ≤ ${usd(config.autoApproveLimit)} in Guarded`} tone={pending.length ? "red" : undefined} spark={cumulative(state.approvals.map((a) => a.createdAt))} />
      </section>

      <ThreatGlobePanel txs={txs} />

      <section className="sim">
        <span className="sim-label">Live traffic</span>
        <button onClick={() => api("/simulate/normal", {})}>＋ Normal order</button>
        <button onClick={() => api("/simulate/card-testing", {})}>⚡ Card-testing attack</button>
        <button onClick={() => api("/simulate/account-takeover", {})}>🕵️ Account takeover</button>
        <button onClick={() => api("/simulate/reseller", {})}>📦 Bulk reseller</button>
        <button className="storm-mini" onClick={() => api("/simulate/storm", { size: 14 }).catch(() => undefined)}>🌪️ Global storm</button>
        <span className="spacer" />
        <button className="primary" disabled={!unscored} onClick={() => api("/transactions/analyse-unscored", {})}>
          Run risk sweep {unscored ? `(${unscored})` : ""}
        </button>
      </section>

      <div className="cc-grid">
        <section className="panel">
          <h2>Approval queue</h2>
          {pending.length === 0 && <p className="empty">Nothing needs you right now. Agents are within policy.</p>}
          {pending.map((a) => (
            <ApprovalCard key={a.id} a={a} stepUpAbove={passkeys?.enrolled.length ? passkeys.stepUpAbove : undefined} />
          ))}
          {recent.length > 0 && <h3>Recently decided</h3>}
          {recent.map((a) => (
            <div key={a.id} className={`decided decided-${a.status.toLowerCase()}`}>
              <span>{a.autoApproved ? "⚙️" : a.status === "REJECTED" ? "✋" : a.status === "FAILED" ? "⚠️" : "✅"}</span>
              <div>
                <div>{a.title}</div>
                <small>{a.result ?? a.status.toLowerCase()} · {a.autoApproved ? "auto by policy" : a.stepUp ? `by you · 🔑 passkey ${a.stepUp}` : "by you"}</small>
              </div>
            </div>
          ))}
        </section>

        <section className="panel feed-panel">
          <h2>
            Agent activity <span className="live">● live</span>
          </h2>
          <Feed events={state.events} />
          <Copilot enabled={config.aiOnline} />
        </section>
      </div>
    </div>
  );
}

const TONE: Record<string, string> = { green: "#2ee59d", amber: "#ffc439", red: "#ff4d6d" };

function Kpi({ label, value, sub, tone, spark }: { label: string; value: string; sub: string; tone?: string; spark?: number[] }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
      {spark && spark.length > 1 && <Spark values={spark} color={TONE[tone ?? ""] ?? "#ffc439"} />}
    </div>
  );
}

/** Daily totals over the last 14 days. */
function daily<T extends { createdAt: string }>(xs: T[], f: (x: T) => number) {
  const days = Array(14).fill(0);
  const now = Date.now();
  for (const x of xs) {
    const d = Math.floor((now - Date.parse(x.createdAt)) / 86_400_000);
    if (d >= 0 && d < 14) days[13 - d] += f(x);
  }
  return days;
}

const cumulative = (isos: string[]) => {
  const s = [...isos].sort();
  return s.map((_, i) => i + 1);
};

function Spark({ values, color }: { values: number[]; color: string }) {
  const W = 200;
  const H = 34;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 3 - ((v - min) / (max - min || 1)) * (H - 6)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const id = `sg${color.slice(1)}`;
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
    </svg>
  );
}

/** Live threat radar: each payment is a blip; riskier ones sit closer to the centre. */
function Radar({ txs }: { txs: AppState["transactions"] }) {
  const C = 110;
  const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const blips = txs.slice(-40).map((t, i) => {
    const score = t.risk?.score ?? 20;
    const a = i * 2.39996; // golden angle spreads blips evenly
    const r = 16 + (1 - score / 100) * 70 + (hash(t.id) % 14);
    return { id: t.id, x: C + r * Math.cos(a), y: C + r * Math.sin(a), score, delay: ((hash(t.id) % 360) / 360) * 3.2, scored: Boolean(t.risk) };
  });
  return (
    <svg className="radar" viewBox="0 0 220 220" role="img" aria-label="Threat radar of recent payments">
      <defs>
        <radialGradient id="rbg">
          <stop offset="0" stopColor="#ffc439" stopOpacity="0.12" />
          <stop offset="1" stopColor="#ffc439" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffc439" stopOpacity="0" />
          <stop offset="1" stopColor="#ffc439" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <circle cx={C} cy={C} r={104} fill="url(#rbg)" stroke="rgba(255,196,57,0.35)" />
      {[78, 52, 26].map((r) => <circle key={r} cx={C} cy={C} r={r} fill="none" stroke="rgba(255,255,255,0.08)" />)}
      <line x1={C - 104} y1={C} x2={C + 104} y2={C} stroke="rgba(255,255,255,0.06)" />
      <line x1={C} y1={C - 104} x2={C} y2={C + 104} stroke="rgba(255,255,255,0.06)" />
      <g className="radar-sweep">
        <path d={`M${C},${C} L${C + 104},${C} A104,104 0 0,0 ${C + 104 * Math.cos(-0.6)},${C + 104 * Math.sin(-0.6)} Z`} fill="url(#beam)" />
        <line x1={C} y1={C} x2={C + 104} y2={C} stroke="#ffc439" strokeWidth="1.5" style={{ filter: "drop-shadow(0 0 6px #ffc439)" }} />
      </g>
      {blips.map((b) => {
        const color = b.score >= 60 ? "#ff4d6d" : b.score >= 30 ? "#ffc439" : "#2ee59d";
        return (
          <circle key={b.id} className="blip" cx={b.x} cy={b.y} r={b.score >= 60 ? 4.5 : 3} fill={color} style={{ animationDelay: `${b.delay}s`, filter: `drop-shadow(0 0 5px ${color})` }}>
            <title>{`${b.id}: ${b.scored ? `risk ${b.score}` : "not scored yet"}`}</title>
          </circle>
        );
      })}
      <circle cx={C} cy={C} r={4} fill="#ffc439" />
    </svg>
  );
}

const KIND_LABEL: Record<string, string> = {
  REFUND: "Refund",
  PAYOUT: "Payout",
  DISPUTE_RESPONSE: "Dispute evidence",
  DISPUTE_ACCEPT: "Accept claim",
  INVOICE_SEND: "Send invoice",
  RELEASE_HOLD: "Release hold",
  AGENT_PAYMENT: "Agent payment",
};

function ApprovalCard({ a, stepUpAbove }: { a: Approval; stepUpAbove?: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (verb: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      await (verb === "approve" ? approve(a.id) : api(`/approvals/${a.id}/reject`, {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const stepUp = stepUpAbove !== undefined && a.amount > stepUpAbove;
  return (
    <div className="approval">
      <div className="approval-head">
        <span className="tag">{KIND_LABEL[a.kind] ?? a.kind}</span>
        <span className="muted">{a.requestedBy} · {ago(a.createdAt)}</span>
      </div>
      <div className="approval-title">{a.title}</div>
      <p className="approval-why">{a.rationale}</p>
      <div className="approval-actions">
        <button className="primary" disabled={busy} onClick={() => act("approve")}>
          {stepUp ? "🔑 " : ""}Approve{["REFUND", "PAYOUT", "DISPUTE_ACCEPT", "AGENT_PAYMENT"].includes(a.kind) ? " & move money" : ""}
        </button>
        <button disabled={busy} onClick={() => act("reject")}>
          Reject
        </button>
      </div>
      {stepUp && <div className="small muted">Above {usd(stepUpAbove!)}: you'll sign this exact approval with your passkey.</div>}
      {error && <div className="small bad">{error}</div>}
    </div>
  );
}

const AGENT_ICON: Record<string, string> = {
  "risk-watch": "🛡️",
  "dispute-agent": "⚖️",
  "billing-agent": "🧾",
  "ring-hunter": "🕸️",
  "red-team": "🗡️",
  "argus-firewall": "🧱",
  "office-bot": "🤖",
  "blue-team": "🛡️",
  "argus-copilot": "💬",
  "policy-engine": "⚙️",
  "rules-engine": "📐",
  paypal: "🅿️",
  human: "🧑",
  system: "•",
  "merchant-counsel": "👔",
  "buyer-advocate": "🙋",
  "chief-judge": "👩‍⚖️",
  "ml-model": "📈",
  "intent-judge": "🔍",
  voice: "🎙️",
};

function Feed({ events }: { events: AgentEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);
  return (
    <div className="feed" ref={ref}>
      {events.slice(-150).map((e) => (
        <div key={e.id} className={`ev ev-${e.kind}`}>
          <span className="ev-time">{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })}</span>
          <span className="ev-agent">
            {AGENT_ICON[e.agent] ?? "🤖"} {e.agent}
          </span>
          <span className="ev-msg">{e.message}</span>
        </div>
      ))}
    </div>
  );
}

const SUGGESTIONS = [
  "Which orders today look riskiest and why?",
  "Refund $20 on TX-1039 as a goodwill gesture for the late delivery",
  "Pay our affiliate jamie@creator.example $40 commission for October",
  "How much revenue is at risk from open disputes?",
];

function Copilot({ enabled }: { enabled: boolean }) {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true);
    setAnswer(null);
    try {
      const r = await api<{ text: string }>("/copilot", { question });
      setAnswer(r.text);
    } catch (err) {
      setAnswer(`⚠️ ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="copilot">
      {answer && <div className="answer">{answer}</div>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={enabled ? "Ask Argus or tell it what to do…" : "Copilot needs GROQ_API_KEY"}
          disabled={!enabled || busy}
        />
        <button className="primary" disabled={!enabled || busy}>
          {busy ? "Working…" : "Send"}
        </button>
      </form>
      {enabled && (
        <div className="chips">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => { setQ(s); ask(s); }} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
