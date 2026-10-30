import { useState } from "react";
import { api, useArgus } from "./api";
import type { Autonomy } from "./types";
import { Billing } from "./views/Billing";
import { CommandCenter } from "./views/CommandCenter";
import { Disputes } from "./views/Disputes";
import { Firewall } from "./views/Firewall";
import { Network } from "./views/Network";
import { Observability } from "./views/Observability";
import { Storefront } from "./views/Storefront";
import { Transactions } from "./views/Transactions";
import { TrustCenter } from "./views/TrustCenter";
import { Voice } from "./Voice";
import { WarGame } from "./views/WarGame";

const TABS = ["Command Center", "Transactions", "Fraud Rings", "War Game", "Agent Firewall", "Trust Center", "Disputes", "Billing", "Storefront", "Observability"] as const;
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
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 40 40">
              <defs>
                <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#3b8cff" />
                  <stop offset="0.6" stopColor="#0070e0" />
                  <stop offset="1" stopColor="#14d3a0" />
                </linearGradient>
              </defs>
              <path d="M20 2 35 8v11c0 9.5-6.3 16.6-15 19C11.3 35.6 5 28.5 5 19V8z" fill="url(#lg)" />
              <path d="M10.5 20c2.6-4.2 5.8-6.3 9.5-6.3s6.9 2.1 9.5 6.3c-2.6 4.2-5.8 6.3-9.5 6.3s-6.9-2.1-9.5-6.3z" fill="#050a16" opacity="0.9" />
              <circle cx="20" cy="20" r="3.6" fill="#fff" />
              <circle cx="20" cy="20" r="1.6" fill="#0070e0" />
            </svg>
          </span>
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
        <Voice go={(t) => setTab(t as Tab)} aiOnline={config.aiOnline} />
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
        {tab === "War Game" && <WarGame state={state} />}
        {tab === "Agent Firewall" && <Firewall config={config} state={state} />}
        {tab === "Trust Center" && <TrustCenter state={state} />}
        {tab === "Disputes" && <Disputes state={state} />}
        {tab === "Billing" && <Billing config={config} state={state} />}
        {tab === "Storefront" && <Storefront config={config} />}
        {tab === "Observability" && <Observability state={state} />}
      </main>
    </div>
  );
}
