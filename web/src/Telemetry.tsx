import { useEffect, useState } from "react";
import { api } from "./api";
import type { AppConfig, AppState } from "./types";

interface Obs { totals: { runs: number; tokens: number; paypalCalls: number; paypalErrors: number } }
interface AuditEntry { seq: number; hash: string }

/**
 * A console-style status bar pinned to the bottom of the screen: link state,
 * PayPal mode, model, event throughput, agent runs, PayPal API calls and the
 * current head of the hash-chained audit log, all live.
 */
export function Telemetry({ config, state, connected }: { config: AppConfig; state: AppState; connected: boolean }) {
  const [obs, setObs] = useState<Obs | null>(null);
  const [head, setHead] = useState<AuditEntry | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const load = () => {
      api<Obs>("/observability").then(setObs).catch(() => undefined);
      api<AuditEntry[]>("/audit?limit=1").then((a) => setHead(a[0] ?? null)).catch(() => undefined);
    };
    load();
    const poll = window.setInterval(load, 4000);
    const tick = window.setInterval(() => setNow(new Date()), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, []);

  const perMin = state.events.filter((e) => now.getTime() - Date.parse(e.ts) < 60_000).length;
  const scored = state.transactions.filter((t) => t.risk).length;
  const cells: [string, string, string?][] = [
    ["LINK", connected ? "SSE·LIVE" : "RECONNECTING", connected ? "ok" : "bad"],
    ["PAYPAL", config.paypalMode === "sandbox" ? "SANDBOX·REST" : "SIMULATOR", "ok"],
    ["MODEL", config.aiOnline ? config.model : "RULES·ENGINE", config.aiOnline ? "ok" : "warn"],
    ["EVT/MIN", String(perMin).padStart(3, "0")],
    ["SCORED", `${scored}/${state.transactions.length}`],
    ["AGENT RUNS", String(obs?.totals.runs ?? 0)],
    ["TOKENS", (obs?.totals.tokens ?? 0).toLocaleString("en-US")],
    ["PAYPAL API", `${obs?.totals.paypalCalls ?? 0}${obs?.totals.paypalErrors ? ` · ${obs.totals.paypalErrors} err` : ""}`],
    ["AUDIT HEAD", head ? `#${head.seq} ${head.hash.slice(0, 10)}…` : "genesis"],
  ];

  return (
    <footer className="telemetry" aria-label="System telemetry">
      <span className="tm-core">
        <i className={connected ? "on" : ""} /> ARGUS/CORE
      </span>
      {cells.map(([k, v, tone]) => (
        <span key={k} className="tm-cell">
          <b>{k}</b> <span className={tone ? `tm-${tone}` : ""}>{v}</span>
        </span>
      ))}
      <span className="spacer" />
      <span className="tm-cell tm-clock">{now.toISOString().slice(11, 19)} UTC</span>
    </footer>
  );
}
