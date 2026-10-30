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
      {d.tribunal && <Tribunal t={d.tribunal} />}
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
      {d.status !== "RESOLVED" && d.tribunal?.status !== "sitting" && (
        <button className="tribunal-btn" onClick={() => api(`/disputes/${d.id}/tribunal`, {})}>
          ⚖️ {d.tribunal ? "Re-argue" : "Convene AI tribunal"}: counsel vs advocate, independent judge
        </button>
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

const ROLE = {
  prosecutor: "👔 Merchant's counsel",
  defender: "🙋 Buyer's advocate",
  judge: "👩‍⚖️ Chief judge",
};

function Tribunal({ t }: { t: NonNullable<Dispute["tribunal"]> }) {
  const r = t.ruling;
  return (
    <div className="tribunal">
      <div className="tribunal-head">
        <b>⚖️ Tribunal {t.status === "sitting" ? "in session…" : "ruling"}</b>
        <span className="muted small">{t.by === "ai" ? "three independent Claude agents" : "rules engine (AI offline)"} · {ago(t.at)}</span>
      </div>
      <div className="bench">
        {t.transcript.map((turn, i) => (
          <div key={i} className={`turn turn-${turn.role}`}>
            <div className="turn-role">{ROLE[turn.role]} · {turn.stage}</div>
            <div>{turn.text}</div>
            {turn.points && turn.points.length > 0 && <ul className="small">{turn.points.map((p) => <li key={p}>{p}</li>)}</ul>}
          </div>
        ))}
      </div>
      {r && (
        <div className="small" style={{ marginTop: 8 }}>
          {r.misstatements.length > 0 && <div className="bad">Unsupported claims called out: {r.misstatements.join("; ")}</div>}
          <div className="muted">Dissent: {r.dissent}</div>
        </div>
      )}
    </div>
  );
}
