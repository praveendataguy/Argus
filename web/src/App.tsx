import { useState } from "react";
import { api, useArgus } from "./api";
import type { Autonomy } from "./types";
import { Billing } from "./views/Billing";
import { CommandCenter } from "./views/CommandCenter";
import { Disputes } from "./views/Disputes";
import { Network } from "./views/Network";
import { Storefront } from "./views/Storefront";
import { Transactions } from "./views/Transactions";

const TABS = ["Command Center", "Transactions", "Fraud Rings", "Disputes", "Billing", "Storefront"] as const;
type Tab = (typeof TABS)[number];

const AUTONOMY: { value: Autonomy; label: string; hint: string }[] = [
  { value: "observe", label: "Observe", hint: "Agents only propose" },
  { value: "guarded", label: "Guarded", hint: "Small actions run, the rest wait for you" },
  { value: "autopilot", label: "Autopilot", hint: "Agents act up to a hard ceiling" },
];

export function App() {
  const { config, state, connected } = useArgus();
  const [tab, setTab] = useState<Tab>("Command Center");

  if (!config || !state) return <div className="boot">Starting Argus…</div>;

  const pending = state.approvals.filter((a) => a.status === "PENDING").length;
  const openDisputes = state.disputes.filter((d) => d.status !== "RESOLVED").length;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">👁️</span>
          <div>
            <div className="brand-name">Argus</div>
            <div className="brand-sub">guarding {config.merchant.name}</div>
          </div>
        </div>
        <div className="status-pills">
          <span className={`pill ${config.paypalMode === "sandbox" ? "pill-blue" : "pill-muted"}`}>
            PayPal {config.paypalMode === "sandbox" ? "Sandbox" : "Simulator"}
          </span>
          <span className={`pill ${config.aiOnline ? "pill-green" : "pill-amber"}`}>
            {config.aiOnline ? `AI · ${config.model}` : "AI offline · rules engine"}
          </span>
          <span className={`dot ${connected ? "dot-on" : ""}`} title={connected ? "Live" : "Reconnecting"} />
        </div>
        <div className="autonomy" role="radiogroup" aria-label="Agent autonomy">
          {AUTONOMY.map((a) => (
            <button
              key={a.value}
              role="radio"
              aria-checked={state.autonomy === a.value}
              className={state.autonomy === a.value ? "on" : ""}
              title={a.hint}
              onClick={() => api("/settings", { autonomy: a.value })}
            >
              {a.label}
            </button>
          ))}
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t}
            {t === "Command Center" && pending > 0 && <span className="badge">{pending}</span>}
            {t === "Disputes" && openDisputes > 0 && <span className="badge">{openDisputes}</span>}
          </button>
        ))}
      </nav>

      <main>
        {tab === "Command Center" && <CommandCenter config={config} state={state} />}
        {tab === "Transactions" && <Transactions state={state} />}
        {tab === "Fraud Rings" && <Network state={state} />}
        {tab === "Disputes" && <Disputes state={state} />}
        {tab === "Billing" && <Billing config={config} state={state} />}
        {tab === "Storefront" && <Storefront config={config} />}
      </main>
    </div>
  );
}
