import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { ago, api, usd } from "../api";
import type { AppState, Transaction } from "../types";

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  backgroundColor: "#021a3f",
  foregroundColor: "#eaf4ff",
  headerBackgroundColor: "#03244f",
  headerTextColor: "#8fb7e6",
  accentColor: "#33c6ff",
  borderColor: "rgba(64, 160, 255, 0.18)",
  oddRowBackgroundColor: "#021d45",
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12,
  rowHoverColor: "#06306a",
});

function RiskCell({ data }: ICellRendererParams<Transaction>) {
  const r = data?.risk;
  if (!r) return <span className="muted">not scored</span>;
  return (
    <div className="riskcell">
      <div className="riskbar">
        <div className={`riskfill risk-${r.level}`} style={{ width: `${r.score}%` }} />
      </div>
      <b>{r.score}</b>
      <span className={`lvl risk-${r.level}`}>{r.level}</span>
    </div>
  );
}

function StatusCell({ value }: ICellRendererParams<Transaction, string>) {
  return <span className={`status status-${String(value).toLowerCase()}`}>{String(value).replace("_", " ").toLowerCase()}</span>;
}

export function Transactions({ state }: { state: AppState }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = state.transactions.find((t) => t.id === selectedId) ?? null;

  const cols = useMemo<ColDef<Transaction>[]>(
    () => [
      { headerName: "When", field: "createdAt", width: 100, valueFormatter: (p) => ago(p.value), sort: "desc" },
      { headerName: "ID", field: "id", width: 120, cellClass: "mono" },
      { headerName: "Buyer", valueGetter: (p) => p.data?.buyer.email, flex: 1.4, minWidth: 200 },
      { headerName: "Acct age", valueGetter: (p) => p.data?.buyer.accountAgeDays, width: 100, valueFormatter: (p) => `${p.value}d` },
      { headerName: "Geo (acct→IP→ship)", valueGetter: (p) => p.data && `${p.data.buyer.country} → ${p.data.ipCountry} → ${p.data.shipping.country}`, width: 170 },
      { headerName: "Amount", field: "amount", width: 110, valueFormatter: (p) => usd(p.value), type: "numericColumn" },
      { headerName: "Status", field: "status", width: 130, cellRenderer: StatusCell },
      { headerName: "Risk", valueGetter: (p) => p.data?.risk?.score ?? -1, width: 210, cellRenderer: RiskCell },
      { headerName: "Verdict", valueGetter: (p) => p.data?.risk?.action ?? "", width: 95 },
      { headerName: "By", valueGetter: (p) => (p.data?.risk ? (p.data.risk.decidedBy === "ai" ? "🤖 AI" : "📐 rules") : ""), width: 90 },
      { headerName: "Source", field: "source", width: 120 },
    ],
    [],
  );

  return (
    <div className="tx-layout">
      <div className="grid-wrap">
        <AgGridReact<Transaction>
          theme={gridTheme}
          rowData={state.transactions}
          columnDefs={cols}
          getRowId={(p) => p.data.id}
          rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
          onRowClicked={(e) => setSelectedId(e.data?.id ?? null)}
          animateRows
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
        />
      </div>
      {selected && <TxDetail tx={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function TxDetail({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  return (
    <aside className="detail">
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <h2 className="mono">{tx.id}</h2>
      <div className="muted">{new Date(tx.createdAt).toLocaleString()} · {tx.source}</div>
      <dl>
        <dt>Buyer</dt>
        <dd>{tx.buyer.name} · {tx.buyer.email}<br /><small>PayPal account {tx.buyer.accountAgeDays} days old · {tx.buyer.country}</small></dd>
        <dt>Items</dt>
        <dd>{tx.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")} · <b>{usd(tx.amount)}</b></dd>
        <dt>Shipping</dt>
        <dd>{tx.shipping.city}, {tx.shipping.country} · {tx.shipping.method}</dd>
        <dt>Checkout</dt>
        <dd>IP {tx.ipCountry} · {tx.device}</dd>
        <dt>PayPal</dt>
        <dd className="mono small">order {tx.orderId}<br />capture {tx.captureId}</dd>
      </dl>
      {tx.risk ? (
        <div className={`verdict verdict-${tx.risk.level}`}>
          <div className="verdict-head">
            <b>{tx.risk.score}</b> {tx.risk.level} risk → <b>{tx.risk.action}</b>
            <span className="muted"> · {tx.risk.decidedBy === "ai" ? "AI analyst" : "rules engine"}</span>
          </div>
          <p>{tx.risk.summary}</p>
          <ul>{tx.risk.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      ) : (
        <p className="muted">Not analysed yet.</p>
      )}
      <MlExplain tx={tx} />
      <button className="primary" onClick={() => api(`/transactions/${tx.id}/analyse`, {})}>
        {tx.risk ? "Re-analyse with Risk Watch" : "Analyse with Risk Watch"}
      </button>
    </aside>
  );
}

interface Explanation {
  probability: number;
  version: number;
  contributions: { feature: string; label: string; value: number; contribution: number }[];
}

/** The ML model's second opinion, with exact per-feature attributions. */
function MlExplain({ tx }: { tx: Transaction }) {
  const [e, setE] = useState<Explanation | null>(null);
  useEffect(() => {
    api<Explanation>(`/ml/explain/${tx.id}`).then(setE).catch(() => setE(null));
  }, [tx.id, tx.risk?.score]);
  if (!e) return null;
  const top = e.contributions.filter((c) => Math.abs(c.contribution) > 0.05).slice(0, 6);
  const max = Math.max(0.01, ...top.map((c) => Math.abs(c.contribution)));
  const pct = Math.round(e.probability * 100);
  return (
    <div className="mlx">
      <div className="verdict-head">
        📈 ML second opinion: <b>{pct}%</b> fraud <span className="muted small">· model v{e.version}</span>
      </div>
      <div className="mlbars">
        {top.map((c) => (
          <Fragment key={c.feature}>
            <span title={`value ${c.value}`}>{c.label} <span className="muted">({c.value})</span></span>
            <span className="mlbar"><span className={c.contribution >= 0 ? "pos" : "neg"} style={{ width: `${(Math.abs(c.contribution) / max) * 50}%` }} /></span>
            <span className="mono">{c.contribution >= 0 ? "+" : ""}{c.contribution.toFixed(2)}</span>
          </Fragment>
        ))}
      </div>
      <div className="small muted">Bars are exact log-odds contributions vs. the average order.</div>
    </div>
  );
}
