import { useEffect, useRef, useState } from "react";
import { ago, api, usd } from "../api";
import { approve, type PasskeyStatus } from "../security";
import type { AgentEvent, AppConfig, AppState, Approval } from "../types";
import { ThreatGlobePanel } from "./ThreatGlobe";
import { HeroArt } from "../HeroArt";

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
        <HeroArt />
      </section>

      <Wire events={state.events} />

      <section className="kpis">
        <Kpi icon="volume" label="Gross volume" value={gross} format={usd} sub={`${txs.length} PayPal captures`} spark={daily(txs, (t) => t.amount)} />
        <Kpi icon="shield" label="Fraud stopped" value={blocked} format={usd} sub="held or cancelled before shipping" tone="green" spark={txs.filter((t) => t.risk).map((t) => t.risk!.score)} />
        <Kpi icon="scale" label="Dispute exposure" value={exposure} format={usd} sub={`${state.disputes.filter((d) => d.status !== "RESOLVED").length} open cases`} tone="amber" spark={daily(txs, (t) => (t.buyer.accountAgeDays < 30 ? t.amount : 0))} />
        <Kpi icon="bell" label="Awaiting you" value={pending.length} format={(n) => String(Math.round(n))} sub={`auto-approve ≤ ${usd(config.autoApproveLimit)} in Guarded`} tone={pending.length ? "red" : undefined} spark={cumulative(state.approvals.map((a) => a.createdAt))} />
      </section>

      <ThreatGlobePanel txs={txs} />

      <section className="panel copilot-panel">
        <h2>Ask Argus</h2>
        <Copilot enabled={config.aiOnline} />
      </section>

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
        <section className="panel queue-panel">
          <h2>
            Approval queue {pending.length > 0 && <span className="muted small">{pending.length} waiting</span>}
          </h2>
          <div className="queue-scroll">
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
          </div>
        </section>

        <div className="cc-side">
          <section className="panel feed-panel">
            <h2>
              Agent activity <span className="live">● live</span>
            </h2>
            <Feed events={state.events} />
          </section>
          <RiskiestPayments txs={txs} />
          <AgentTeam events={state.events} />
        </div>
      </div>
    </div>
  );
}

const TONE: Record<string, string> = { green: "#2ee59d", amber: "#ffc439", red: "#ff4d6d", blue: "#33c6ff" };

const ICONS: Record<string, string> = {
  volume: "M3 17l5-5 4 4 8-8M15 8h5v5",
  shield: "M12 3l8 3v6c0 5-3.5 8.5-8 9.5C7.5 20.5 4 17 4 12V6zM8.5 12l2.5 2.5 4.5-5",
  scale: "M12 4v16M6 20h12M5 8h14M7 8l-3 6a3 3 0 0 0 6 0zM17 8l-3 6a3 3 0 0 0 6 0z",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
};

/** Eases a number from its last value to the new one, so KPIs count up live. */
function useCountUp(target: number, ms = 900) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const v = a + (target - a) * (1 - Math.pow(1 - k, 3));
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      from.current = target;
    };
  }, [target, ms]);
  return shown;
}

/** A scrolling wire of the latest agent decisions, like a trading-floor ticker. */
function Wire({ events }: { events: AgentEvent[] }) {
  const items = events.filter((e) => e.kind === "decision" || e.kind === "action" || e.kind === "error").slice(-14).reverse();
  if (items.length === 0) return null;
  // Rendered twice back to back so the scroll loops seamlessly.
  const row = (copy: string) => items.map((e) => (
    <span key={e.id + copy} className={`wire-item wire-${e.kind}`} aria-hidden={copy === "b" || undefined}>
      <b>{e.agent}</b> {e.message.length > 110 ? e.message.slice(0, 107) + "…" : e.message}
    </span>
  ));
  return (
    <section className="wire" aria-label="Latest agent decisions">
      <span className="wire-tag">
        <i /> Live agent wire
      </span>
      <div className="wire-track">
        <div className="wire-run">
          {row("a")}
          {row("b")}
        </div>
      </div>
    </section>
  );
}

function Kpi({ icon, label, value, format, sub, tone, spark }: { icon: string; label: string; value: number; format: (n: number) => string; sub: string; tone?: string; spark?: number[] }) {
  const shown = useCountUp(value);
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <svg className="kpi-icon" viewBox="0 0 24 24" aria-hidden>
        <path d={ICONS[icon]} />
      </svg>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{format(shown)}</div>
      <div className="kpi-sub">{sub}</div>
      {spark && spark.length > 1 && <Spark values={spark} color={TONE[tone ?? ""] ?? "#33c6ff"} />}
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
          <stop offset="0" stopColor="#33c6ff" stopOpacity="0.12" />
          <stop offset="1" stopColor="#33c6ff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#33c6ff" stopOpacity="0" />
          <stop offset="1" stopColor="#33c6ff" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <circle cx={C} cy={C} r={104} fill="url(#rbg)" stroke="rgba(51,198,255,0.45)" />
      {[78, 52, 26].map((r) => <circle key={r} cx={C} cy={C} r={r} fill="none" stroke="rgba(255,255,255,0.08)" />)}
      <line x1={C - 104} y1={C} x2={C + 104} y2={C} stroke="rgba(255,255,255,0.06)" />
      <line x1={C} y1={C - 104} x2={C} y2={C + 104} stroke="rgba(255,255,255,0.06)" />
      <g className="radar-sweep">
        <path d={`M${C},${C} L${C + 104},${C} A104,104 0 0,0 ${C + 104 * Math.cos(-0.6)},${C + 104 * Math.sin(-0.6)} Z`} fill="url(#beam)" />
        <line x1={C} y1={C} x2={C + 104} y2={C} stroke="#33c6ff" strokeWidth="1.5" style={{ filter: "drop-shadow(0 0 6px #33c6ff)" }} />
      </g>
      {blips.map((b) => {
        const color = b.score >= 60 ? "#ff4d6d" : b.score >= 30 ? "#ffc439" : "#2ee59d";
        return (
          <circle key={b.id} className="blip" cx={b.x} cy={b.y} r={b.score >= 60 ? 4.5 : 3} fill={color} style={{ animationDelay: `${b.delay}s`, filter: `drop-shadow(0 0 5px ${color})` }}>
            <title>{`${b.id}: ${b.scored ? `risk ${b.score}` : "not scored yet"}`}</title>
          </circle>
        );
      })}
      <circle cx={C} cy={C} r={4} fill="#33c6ff" />
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
  const guard = a.payload?.payeeGuard as { flagged?: boolean; checks?: { name: string; pass: boolean; detail: string }[] } | undefined;
  const flagged = guard?.flagged === true;
  const stepUp = stepUpAbove !== undefined && (a.amount > stepUpAbove || flagged);
  return (
    <div className="approval">
      <div className="approval-head">
        <span className="tag">{KIND_LABEL[a.kind] ?? a.kind}</span>
        <span className="muted">{a.requestedBy} · {ago(a.createdAt)}</span>
      </div>
      <div className="approval-title">{a.title}</div>
      <p className="approval-why">{a.rationale}</p>
      {flagged && (
        <div className="payee-flag small">
          <b>🚩 Payout guard: possible payment redirection</b>
          <ul>
            {guard!.checks!.filter((c) => !c.pass).map((c) => (
              <li key={c.name}><b>{c.name}:</b> {c.detail}</li>
            ))}
          </ul>
          Call the payee on the number you already have before approving.
        </div>
      )}
      <div className="approval-actions">
        <button className="primary" disabled={busy} onClick={() => act("approve")}>
          {stepUp ? "🔑 " : ""}Approve{["REFUND", "PAYOUT", "DISPUTE_ACCEPT", "AGENT_PAYMENT"].includes(a.kind) ? " & move money" : ""}
        </button>
        <button disabled={busy} onClick={() => act("reject")}>
          Reject
        </button>
      </div>
      {stepUp && <div className="small muted">{flagged ? "Flagged payee" : `Above ${usd(stepUpAbove!)}`}: you'll sign this exact approval with your passkey.</div>}
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
  "payout-guard": "🚩",
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

const ACTION_LABEL: Record<string, string> = { allow: "allowed", review: "review", hold: "held", refund: "refunded" };

function RiskiestPayments({ txs }: { txs: AppState["transactions"] }) {
  const top = txs
    .filter((t) => t.risk)
    .sort((a, b) => b.risk!.score - a.risk!.score || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6);
  return (
    <section className="panel side-panel">
      <h2>Riskiest payments</h2>
      {top.length === 0 && <p className="empty">Nothing scored yet. Run a risk sweep.</p>}
      <div className="risk-list">
        {top.map((t) => {
          const score = t.risk!.score;
          const tone = score >= 70 ? "red" : score >= 40 ? "amber" : "green";
          return (
            <div key={t.id} className="risk-row">
              <span className={`risk-score risk-${tone}`}>{score}</span>
              <div className="risk-main">
                <div className="risk-top">
                  <b>{t.id}</b>
                  <span>{usd(t.amount)}</span>
                </div>
                <div className="risk-sub">
                  {t.ipCountry} → {t.shipping.country} · {t.buyer.email}
                </div>
                <div className="risk-why">{t.risk!.reasons[0] ?? t.risk!.summary}</div>
              </div>
              <span className={`risk-act act-${t.status === "REFUNDED" ? "refund" : t.status === "HELD" ? "hold" : t.risk!.action}`}>
                {t.status === "REFUNDED" ? "refunded" : t.status === "HELD" ? "held" : ACTION_LABEL[t.risk!.action]}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const HIDDEN_AGENTS = new Set(["system", "paypal", "human", "voice"]);

function AgentTeam({ events }: { events: AgentEvent[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  const byAgent = new Map<string, { count: number; last: AgentEvent; actions: number }>();
  for (const e of events) {
    if (HIDDEN_AGENTS.has(e.agent)) continue;
    const cur = byAgent.get(e.agent) ?? { count: 0, last: e, actions: 0 };
    cur.count++;
    if (e.kind === "decision" || e.kind === "action") cur.actions++;
    if (e.ts >= cur.last.ts) cur.last = e;
    byAgent.set(e.agent, cur);
  }
  const agents = [...byAgent.entries()].sort((a, b) => b[1].last.ts.localeCompare(a[1].last.ts)).slice(0, 8);
  return (
    <section className="panel side-panel">
      <h2>
        Agent team <span className="muted small">{byAgent.size} on duty</span>
      </h2>
      {agents.length === 0 && <p className="empty">Agents will appear here as they work.</p>}
      <div className="team-grid">
        {agents.map(([name, a]) => {
          const active = now - new Date(a.last.ts).getTime() < 60_000;
          return (
            <div key={name} className={`team-card ${active ? "team-active" : ""}`} title={a.last.message}>
              <div className="team-head">
                <span className="team-icon">{AGENT_ICON[name] ?? "🤖"}</span>
                <b>{name}</b>
                <span className={`team-dot ${active ? "on" : ""}`} aria-label={active ? "working" : "idle"} />
              </div>
              <div className="team-stats">
                {a.count} event{a.count === 1 ? "" : "s"} · {a.actions} decision{a.actions === 1 ? "" : "s"}
              </div>
              <div className="team-last">{active ? "working now" : `last seen ${ago(a.last.ts)}`}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

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
