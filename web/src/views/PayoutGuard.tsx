import { useEffect, useState } from "react";
import { ago, api, usd } from "../api";
import type { AppState } from "../types";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
  severity: "block" | "hold" | "info";
}

interface Payee {
  id: string;
  name: string;
  role: string;
  paypalEmail: string;
  usualAmount: number;
  payoutsSent: number;
  changedAt?: string;
  changedVia?: string;
  previousEmail?: string;
}

interface Screening {
  id: string;
  at: string;
  receiverEmail: string;
  amount: number;
  note: string;
  context: string;
  flagged: boolean;
  checks: Check[];
  payeeName?: string;
  outcome: "paid" | "held" | "rejected";
}

interface Guard {
  payees: Payee[];
  screenings: Screening[];
  scenarios: { id: string; label: string }[];
}

const OUTCOME = { paid: "✅ Paid via PayPal", held: "⏸ Waiting for a human", rejected: "⛔ Rejected" };

/** Payment redirection (business email compromise): payouts are checked against the payee book. */
export function PayoutGuard({ state }: { state: AppState }) {
  const [g, setG] = useState<Guard | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const version = `${state.events.filter((e) => e.agent === "payout-guard").length}:${state.approvals.filter((a) => a.kind === "PAYOUT" && a.status !== "PENDING").length}`;

  useEffect(() => {
    api<Guard>("/payout-guard").then(setG);
  }, [version]);

  if (!g) return null;

  const run = async (id: string) => {
    setBusy(id);
    try {
      await api(`/payout-guard/scenario/${id}`, {});
      setG(await api<Guard>("/payout-guard"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fw-grid payout-guard">
      <section className="panel">
        <h2>Payout guard</h2>
        <p className="small muted">
          The most expensive scam for small businesses is an email that says "we changed our PayPal, pay this account instead". Argus checks every
          payout against the payee book. A payout to a new, look-alike or recently changed address never runs on its own, whatever the autonomy
          level, and approving it needs your passkey.
        </p>
        <h3>Payee book</h3>
        {g.payees.map((p) => (
          <div key={p.id} className="mandate">
            <div className="row-between">
              <b>{p.name}</b>
              <span className="small muted">{p.role}</span>
            </div>
            <div className="small mono">{p.paypalEmail}</div>
            <div className="small muted">
              {p.payoutsSent} payouts · usually {usd(p.usualAmount)}
              {p.changedAt && (
                <span className="bad"> · details changed {ago(p.changedAt)} by {p.changedVia} (was {p.previousEmail})</span>
              )}
            </div>
          </div>
        ))}
        <h3>Try it</h3>
        <div className="fw-scenarios">
          {g.scenarios.map((s) => (
            <button key={s.id} className={s.id === "bec" ? "primary" : ""} disabled={busy !== null} onClick={() => run(s.id)}>
              {busy === s.id ? "Checking…" : s.label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Payout requests</h2>
        {g.screenings.length === 0 && <p className="empty">No payouts requested yet. Try a scenario.</p>}
        {g.screenings.map((s) => (
          <article key={s.id} className={`fw-pay ${s.outcome === "paid" ? "fw-approved" : s.outcome === "rejected" || s.flagged ? "fw-blocked" : "fw-held"}`}>
            <div className="row-between">
              <div>
                <b>{usd(s.amount)}</b> → <b className="mono">{s.receiverEmail}</b>
                <div className="small muted">{s.note}</div>
              </div>
              <div className="fw-verdict">
                {s.flagged && s.outcome === "held" ? "🚩 Held: confirm the payee" : OUTCOME[s.outcome]}
                <div className="small muted">{ago(s.at)}</div>
              </div>
            </div>
            <ul className="checks">
              {s.checks.map((c) => (
                <li key={c.name} className={c.pass ? "ok" : c.severity === "hold" ? "warn" : "bad"}>
                  <span>{c.pass ? "✓" : "!"}</span> <b>{c.name}</b> <span className="muted">{c.detail}</span>
                </li>
              ))}
            </ul>
            {s.flagged && s.outcome === "held" && (
              <div className="small">Before approving, call the payee on the number you already have, not one from the email. Approve or reject it in the Command Center.</div>
            )}
            {s.context && (
              <details>
                <summary className="small">The message that asked for this payout</summary>
                <pre className="code">{s.context}</pre>
              </details>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}
