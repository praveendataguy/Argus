import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo, useState } from "react";
import { ago, api, usd } from "../api";
import type { AppState, Transaction } from "../types";

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  backgroundColor: "#0f1626",
  foregroundColor: "#dbe4f3",
  headerBackgroundColor: "#121b2e",
  accentColor: "#3b82f6",
  borderColor: "#1f2a40",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 13,
  rowHoverColor: "#16223a",
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
      <button className="primary" onClick={() => api(`/transactions/${tx.id}/analyse`, {})}>
        {tx.risk ? "Re-analyse with Risk Watch" : "Analyse with Risk Watch"}
      </button>
    </aside>
  );
}
