import { useEffect, useState } from "react";
import { ago, api, usd } from "../api";
import type { AppConfig, AppState } from "../types";

interface Mandate {
  agentId: string;
  name: string;
  owner: string;
  purpose: string;
  perTxLimit: number;
  monthlyBudget: number;
  humanAbove: number;
  allowedPayees: string[];
  spent: number;
  token: string;
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
  severity: "block" | "hold" | "info";
}

interface Payment {
  id: string;
  at: string;
  agentId: string;
  payee: string;
  payeeName?: string;
  amount: number;
  purpose: string;
  context: string;
  checks: Check[];
  verdict: "approved" | "held" | "blocked";
  reference?: string;
  scenario?: string;
  mandateHash?: string;
  receipt?: string;
  nonce?: string;
}

interface Firewall {
  mandates: Mandate[];
  payees: { id: string; name: string; paypalEmail: string; category: string }[];
  payments: Payment[];
  scenarios: { id: string; label: string }[];
  mcpUrl: string;
  keys: { owner: string; argus: string };
}

function Receipt({ token }: { token: string }) {
  const [v, setV] = useState<{ valid: boolean; kid?: string; reason?: string } | null>(null);
  return (
    <div className="receipt small">
      🧾 Signed receipt <span className="mono muted">{token.slice(0, 28)}…</span>
      <button className="small-btn" onClick={() => api<typeof v>("/credentials/verify", { token }).then(setV)}>Verify</button>
      {v && <span className={v.valid ? "good" : "bad"}>{v.valid ? `✓ signed by ${v.kid}` : `✗ ${v.reason}`}</span>}
    </div>
  );
}

const VERDICT = { approved: "✅ Paid via PayPal", held: "⏸ Waiting for a human", blocked: "⛔ Blocked" };

export function Firewall({ config, state }: { config: AppConfig; state: AppState }) {
  const [fw, setFw] = useState<Firewall | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const version = `${state.events.filter((e) => e.agent === "argus-firewall" || e.agent === "office-bot").length}:${state.approvals.length}:${state.approvals.filter((a) => a.status === "PENDING").length}`;

  useEffect(() => {
    api<Firewall>("/firewall").then(setFw);
  }, [version]);

  if (!fw) return <p className="muted">Loading firewall…</p>;

  const run = async (id: string, path: string) => {
    setBusy(id);
    try {
      await api(path, {});
      setFw(await api<Firewall>("/firewall"));
    } finally {
      setBusy(null);
    }
  };

  const mcpConfig = JSON.stringify({ mcpServers: { "argus-pay": { type: "http", url: fw.mcpUrl } } }, null, 2);

  return (
    <div className="firewall">
      <section className="wg-head">
        <div>
          <h2>Agent payment firewall</h2>
          <p className="muted">
            AI agents never hold PayPal credentials. They pay through Argus over MCP, and every payment is checked against the owner's mandate, scanned for
            prompt injection and judged by an independent model before PayPal settles it. Mandates are owner-signed credentials, every request
            carries a single-use nonce, and every settled payment gets a receipt signed by Argus.
          </p>
        </div>
      </section>

      <div className="fw-grid">
        <section className="panel">
          <h2>Mandates</h2>
          {fw.mandates.map((m) => {
            const pct = Math.min(100, (m.spent / m.monthlyBudget) * 100);
            return (
              <div key={m.agentId} className="mandate">
                <div className="row-between">
                  <b>🤖 {m.name}</b>
                  <span className="mono small muted">{m.agentId}</span>
                </div>
                <div className="small muted">{m.purpose}</div>
                <details className="small">
                  <summary>🔏 Signed mandate · {fw.keys.owner} (Ed25519)</summary>
                  <pre className="code tokenwrap">{m.token}</pre>
                </details>
                <div className="budget">
                  <div className="budgetbar"><span style={{ width: `${pct}%` }} className={pct > 85 ? "hot" : ""} /></div>
                  <span className="small">{usd(m.spent)} of {usd(m.monthlyBudget)}</span>
                </div>
                <div className="small muted">
                  ≤ {usd(m.perTxLimit)} per payment · human above {usd(m.humanAbove)} · payees: {m.allowedPayees.map((id) => fw.payees.find((p) => p.id === id)?.name ?? id).join(", ")}
                </div>
              </div>
            );
          })}

          <h3>Try it</h3>
          <div className="fw-scenarios">
            {fw.scenarios.map((s) => (
              <button key={s.id} disabled={busy !== null} onClick={() => run(s.id, `/firewall/scenario/${s.id}`)}>
                {busy === s.id ? "Checking…" : s.label}
              </button>
            ))}
            <button className="primary" disabled={busy !== null || !config.aiOnline} onClick={() => run("live", "/firewall/live-agent")} title={config.aiOnline ? "" : "Needs GROQ_API_KEY"}>
              🧪 Run a live Claude agent on a poisoned page
            </button>
          </div>

          <h3>Connect any MCP agent</h3>
          <pre className="code">{mcpConfig}</pre>
          <p className="small muted">Tools: <code>argus_get_mandate</code>, <code>argus_pay</code>. Works with Claude Code, Claude Desktop and any MCP client.</p>
        </section>

        <section className="panel">
          <h2>Payment requests</h2>
          {fw.payments.length === 0 && <p className="empty">No agent has asked to pay yet. Try a scenario.</p>}
          {fw.payments.map((p) => (
            <article key={p.id} className={`fw-pay fw-${p.verdict}`}>
              <div className="row-between">
                <div>
                  <b>{p.agentId}</b> → <b>{p.payeeName ?? p.payee}</b> · {usd(p.amount)}
                  <div className="small muted">{p.purpose}</div>
                </div>
                <div className="fw-verdict">
                  {VERDICT[p.verdict]}
                  <div className="small muted">{ago(p.at)}</div>
                </div>
              </div>
              <ul className="checks">
                {p.checks.map((c) => (
                  <li key={c.name} className={c.pass ? "ok" : c.severity === "hold" ? "warn" : "bad"}>
                    <span>{c.pass ? "✓" : c.severity === "hold" ? "!" : "✗"}</span> <b>{c.name}</b> <span className="muted">{c.detail}</span>
                  </li>
                ))}
              </ul>
              {p.reference && <div className="small mono muted">{p.reference}</div>}
              {p.receipt && <Receipt token={p.receipt} />}
              {p.context && (
                <details>
                  <summary className="small">What the agent was reading</summary>
                  <pre className="code">{p.context}</pre>
                </details>
              )}
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
