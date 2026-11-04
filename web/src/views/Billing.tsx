import { useState } from "react";
import { ago, api, usd } from "../api";
import type { AppConfig, AppState } from "../types";

const EXAMPLES = [
  "Invoice Riverside Studios (bookings@riverside.example) for 2 Monolith monitors and a setup visit, 3 hours at $60/hr. Net 30.",
  "Hey, can you bill Sam Patel sam.patel@example.com for the Orbit headphones he picked up in store plus a cable kit? Due Friday.",
];

export function Billing({ config, state }: { config: AppConfig; state: AppState }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setReply(null);
    try {
      const r = await api<{ text: string }>("/invoices/draft", { text });
      setReply(r.text);
      setText("");
    } catch (err) {
      setReply(`⚠️ ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="billing">
      <section className="panel">
        <h2>Invoice from anything</h2>
        <p className="muted">Paste an email, a note or a voice transcript. The billing agent creates a PayPal invoice and queues it for you to send.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Describe who to bill and for what…" />
        <div className="row-between">
          <div className="chips">
            {EXAMPLES.map((e) => (
              <button key={e} onClick={() => setText(e)}>
                {e.slice(0, 48)}…
              </button>
            ))}
          </div>
          <button className="primary" disabled={!config.aiOnline || busy || !text.trim()} onClick={submit}>
            {busy ? "Drafting…" : config.aiOnline ? "Create PayPal invoice" : "Needs GROQ_API_KEY"}
          </button>
        </div>
        {reply && <div className="answer">{reply}</div>}
      </section>

      <section className="panel">
        <h2>Invoices</h2>
        {state.invoices.length === 0 && <p className="empty">No invoices yet.</p>}
        <table className="table">
          <thead>
            <tr><th>#</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Created</th></tr>
          </thead>
          <tbody>
            {state.invoices.map((i) => (
              <tr key={i.id}>
                <td className="mono">{i.number}</td>
                <td>{i.recipientName}<br /><small className="muted">{i.recipientEmail}</small></td>
                <td>{i.items.map((x) => `${x.quantity}× ${x.name}`).join(", ")}</td>
                <td>{usd(i.total)}</td>
                <td>
                  <span className={`status status-${i.status.toLowerCase()}`}>{i.status.toLowerCase()}</span>
                  {i.paypalUrl && <> · <a href={i.paypalUrl} target="_blank" rel="noreferrer">view</a></>}
                </td>
                <td>{ago(i.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
