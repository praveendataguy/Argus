import { useEffect, useRef, useState } from "react";
import { ago, api, usd } from "../api";
import type { AgentEvent, AppConfig, AppState, Approval } from "../types";

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

  return (
    <div className="cc">
      <section className="kpis">
        <Kpi label="Gross volume" value={usd(gross)} sub={`${txs.length} PayPal captures`} />
        <Kpi label="Fraud stopped" value={usd(blocked)} sub="held or cancelled before shipping" tone="green" />
        <Kpi label="Dispute exposure" value={usd(exposure)} sub={`${state.disputes.filter((d) => d.status !== "RESOLVED").length} open cases`} tone="amber" />
        <Kpi label="Awaiting you" value={String(pending.length)} sub={`auto-approve ≤ ${usd(config.autoApproveLimit)} in Guarded`} tone={pending.length ? "red" : undefined} />
      </section>

      <section className="sim">
        <span className="sim-label">Live traffic</span>
        <button onClick={() => api("/simulate/normal", {})}>＋ Normal order</button>
        <button onClick={() => api("/simulate/card-testing", {})}>⚡ Card-testing attack</button>
        <button onClick={() => api("/simulate/account-takeover", {})}>🕵️ Account takeover</button>
        <button onClick={() => api("/simulate/reseller", {})}>📦 Bulk reseller</button>
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
            <ApprovalCard key={a.id} a={a} />
          ))}
          {recent.length > 0 && <h3>Recently decided</h3>}
          {recent.map((a) => (
            <div key={a.id} className={`decided decided-${a.status.toLowerCase()}`}>
              <span>{a.autoApproved ? "⚙️" : a.status === "REJECTED" ? "✋" : a.status === "FAILED" ? "⚠️" : "✅"}</span>
              <div>
                <div>{a.title}</div>
                <small>{a.result ?? a.status.toLowerCase()} · {a.autoApproved ? "auto by policy" : "by you"}</small>
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

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  REFUND: "Refund",
  PAYOUT: "Payout",
  DISPUTE_RESPONSE: "Dispute evidence",
  DISPUTE_ACCEPT: "Accept claim",
  INVOICE_SEND: "Send invoice",
  RELEASE_HOLD: "Release hold",
};

function ApprovalCard({ a }: { a: Approval }) {
  const [busy, setBusy] = useState(false);
  const act = async (verb: "approve" | "reject") => {
    setBusy(true);
    try {
      await api(`/approvals/${a.id}/${verb}`, {});
    } finally {
      setBusy(false);
    }
  };
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
          Approve{a.kind === "REFUND" || a.kind === "PAYOUT" || a.kind === "DISPUTE_ACCEPT" ? " & move money" : ""}
        </button>
        <button disabled={busy} onClick={() => act("reject")}>
          Reject
        </button>
      </div>
    </div>
  );
}

const AGENT_ICON: Record<string, string> = {
  "risk-watch": "🛡️",
  "dispute-agent": "⚖️",
  "billing-agent": "🧾",
  "argus-copilot": "💬",
  "policy-engine": "⚙️",
  "rules-engine": "📐",
  paypal: "🅿️",
  human: "🧑",
  system: "•",
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
          placeholder={enabled ? "Ask Argus or tell it what to do…" : "Copilot needs ANTHROPIC_API_KEY"}
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
