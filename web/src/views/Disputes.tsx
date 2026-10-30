import { useState } from "react";
import { ago, api, usd } from "../api";
import type { AppState, Dispute } from "../types";

const REASON: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorised transaction",
};

export function Disputes({ state }: { state: AppState }) {
  const [syncing, setSyncing] = useState(false);
  return (
    <div className="disputes">
      <div className="row-between">
        <p className="muted">
          The dispute agent reads the PayPal case, courier tracking, support tickets and QA notes, then recommends contesting or accepting with a
          ready-to-submit response.
        </p>
        <button
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            await api("/disputes/sync", {}).catch(() => undefined);
            setSyncing(false);
          }}
        >
          {syncing ? "Syncing…" : "Sync from PayPal"}
        </button>
      </div>
      {state.disputes.map((d) => (
        <DisputeCard key={d.id} d={d} tx={state.transactions.find((t) => t.id === d.transactionId)} />
      ))}
    </div>
  );
}

function DisputeCard({ d, tx }: { d: Dispute; tx?: AppState["transactions"][number] }) {
  const c = d.agentCase;
  return (
    <article className="dispute">
      <header>
        <div>
          <span className="mono">{d.id}</span> · <b>{REASON[d.reason] ?? d.reason}</b>
          <div className="muted">
            {tx ? `${tx.buyer.name} · ${tx.id} · ` : ""}
            opened {ago(d.createdAt)} · {d.source}
          </div>
        </div>
        <div className="dispute-amt">
          {usd(d.amount)}
          <span className={`status status-${d.status.toLowerCase()}`}>{d.outcome ?? d.status.replace(/_/g, " ").toLowerCase()}</span>
        </div>
      </header>
      <blockquote>“{d.buyerMessage || "No message from buyer"}”</blockquote>
      {c ? (
        <div className={`case case-${c.recommendation}`}>
          <div className="case-head">
            <span className="rec">{c.recommendation === "contest" ? "⚔️ Contest" : "🤝 Accept & refund"}</span>
            <WinMeter p={c.winProbability} />
            <span className="muted">confidence {Math.round(c.confidence * 100)}%</span>
          </div>
          <ul>{c.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
          <details>
            <summary>Drafted response</summary>
            <pre>{c.responseText}</pre>
          </details>
          <p className="muted small">Queued in the approval queue. Nothing is sent to PayPal or the buyer until you approve.</p>
        </div>
      ) : (
        d.status !== "RESOLVED" && (
          <button className="primary" onClick={() => api(`/disputes/${d.id}/analyse`, {})}>
            Build case with Dispute Agent
          </button>
        )
      )}
    </article>
  );
}

function WinMeter({ p }: { p: number }) {
  const pct = Math.round(p * 100);
  return (
    <span className="win">
      win chance
      <span className="winbar">
        <span style={{ width: `${pct}%` }} className={pct >= 60 ? "good" : pct >= 35 ? "mid" : "bad"} />
      </span>
      <b>{pct}%</b>
    </span>
  );
}
