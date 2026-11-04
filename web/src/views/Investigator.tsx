import { geoNaturalEarth1, geoPath, geoInterpolate } from "d3-geo";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import landTopo from "world-atlas/land-110m.json";
import { useEffect, useMemo, useState } from "react";
import { ago, api, usd } from "../api";
import { CENTROID } from "../geo";
import type { AppState, Investigation, Transaction } from "../types";

const MW = 440;
const MH = 230;
const projection = geoNaturalEarth1().fitExtent([[6, 6], [MW - 6, MH - 6]], { type: "Sphere" });
const path = geoPath(projection);
const topo = landTopo as unknown as Topology<{ land: GeometryCollection }>;
const LAND = path(feature(topo, topo.objects.land)) ?? "";

const ROLE_LABEL = { account: "Account", ip: "Checkout IP", ship: "Parcel" } as const;
const VERDICT_LABEL = { fraud: "Fraud", legitimate: "Legitimate", unsure: "Needs a human" } as const;

/** Flat map of the case geography: account → checkout IP → parcel, plus every country the ring touches. */
function CaseMap({ inv }: { inv: Investigation }) {
  const pts = (inv.trail ?? []).map((p) => ({ ...p, xy: CENTROID[p.country] && projection(CENTROID[p.country]) })).filter((p) => p.xy) as { role: keyof typeof ROLE_LABEL; country: string; xy: [number, number] }[];
  const ring = (inv.ring?.countries ?? []).map((c) => CENTROID[c] && projection(CENTROID[c])).filter(Boolean) as [number, number][];
  const arcs: string[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = CENTROID[pts[i].country];
    const b = CENTROID[pts[i + 1].country];
    if (pts[i].country === pts[i + 1].country) continue;
    const interp = geoInterpolate(a, b);
    arcs.push(path({ type: "LineString", coordinates: Array.from({ length: 33 }, (_, k) => interp(k / 32)) }) ?? "");
  }
  return (
    <svg className="inv-map" viewBox={`0 0 ${MW} ${MH}`} role="img" aria-label="Map of the case geography">
      <path d={path({ type: "Sphere" }) ?? ""} className="inv-sphere" />
      <path d={LAND} className="inv-land" />
      {ring.map(([x, y], i) => (
        <circle key={`r${i}`} cx={x} cy={y} r="9" className="inv-ring-dot" />
      ))}
      {arcs.map((d, i) => (
        <path key={`a${i}`} d={d} className="inv-arc" />
      ))}
      {pts.map((p, i) => {
        // Label away from the map edge, and stagger labels that share a country.
        const right = p.xy[0] < MW * 0.35 || (p.xy[0] < MW * 0.65 && i === 1);
        const dup = pts.findIndex((q) => q.country === p.country) !== i;
        return (
        <g key={p.role} transform={`translate(${p.xy[0]} ${p.xy[1]})`}>
          <circle r="4.5" className={`inv-pt inv-pt-${p.role}`} />
          <text y={dup ? 16 : -9} x={right ? 8 : -8} textAnchor={right ? "start" : "end"} className="inv-pt-label">
            {ROLE_LABEL[p.role]} · {p.country}
          </text>
        </g>
        );
      })}
    </svg>
  );
}

function StepIcon({ status }: { status: Investigation["steps"][number]["status"] }) {
  if (status === "done") return <span className="inv-ic inv-ic-done">✓</span>;
  if (status === "running") return <span className="inv-ic inv-ic-run" />;
  if (status === "failed") return <span className="inv-ic inv-ic-fail">!</span>;
  return <span className="inv-ic" />;
}

function CaseView({ inv, tx }: { inv: Investigation; tx?: Transaction }) {
  const done = inv.steps.filter((s) => s.status === "done").length;
  return (
    <div className="inv-case">
      <div className="inv-head">
        <div>
          <div className="muted small mono">{inv.id} · {inv.by === "ai" ? "AI investigator" : "Rules engine"} · opened {ago(inv.startedAt)}</div>
          <h2>
            {inv.transactionId} {tx && <span className="muted">· {usd(tx.amount)} from {tx.buyer.name}</span>}
          </h2>
        </div>
        {inv.verdict ? (
          <div className={`inv-verdict inv-v-${inv.verdict.verdict}`}>
            <b>{VERDICT_LABEL[inv.verdict.verdict]}</b>
            <span>{Math.round(inv.verdict.confidence * 100)}% confident</span>
          </div>
        ) : (
          <div className="inv-verdict inv-v-running">
            <b>{inv.status === "failed" ? "Failed" : "Investigating"}</b>
            <span>{done} of {inv.steps.length} steps</span>
          </div>
        )}
      </div>
      <div className="inv-progress"><i style={{ width: `${(done / inv.steps.length) * 100}%` }} /></div>

      {inv.verdict && (
        <div className="inv-why">
          <div className="inv-why-h">Why Argus decided this</div>
          <p className="inv-headline">{inv.verdict.headline}</p>
          <p>{inv.verdict.narrative}</p>
        </div>
      )}

      <div className="inv-body">
        <ol className="inv-steps">
          {inv.steps.map((s) => (
            <li key={s.key} className={`inv-step inv-s-${s.status}`}>
              <StepIcon status={s.status} />
              <div>
                <div className="row-between">
                  <b>{s.title}</b>
                  <span className="mono small muted">{s.tool}{s.ms !== undefined && ` · ${s.ms}ms`}</span>
                </div>
                {s.summary && <div className="inv-sum">{s.summary}</div>}
                {s.findings.length > 0 && (
                  <ul className="inv-find">
                    {s.findings.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div className="inv-side">
          {inv.trail ? <CaseMap inv={inv} /> : <div className="inv-map inv-map-empty muted small">Tracing the geography…</div>}
          {inv.ring && (
            <div className="inv-ring">
              <div className="row-between">
                <b>Fraud network {inv.ring.id}</b>
                <span className="mono">{usd(inv.ring.exposure)} exposed</span>
              </div>
              <div className="muted small">{inv.ring.accounts.length} accounts · {inv.ring.orders} orders · {inv.ring.countries.join(" · ")}</div>
              <ul className="inv-find">
                {inv.ring.accounts.slice(0, 6).map((a) => (
                  <li key={a} className="mono small">{a}</li>
                ))}
              </ul>
            </div>
          )}
          {inv.actions.length > 0 && (
            <div className="inv-actions">
              <b>Actions</b>
              {inv.actions.map((a, i) => (
                <div key={i} className="inv-act">
                  <span className={`pill inv-a-${a.status}`}>{a.status === "waiting" ? "Waiting for you" : a.status}</span>
                  <span>{a.label}</span>
                </div>
              ))}
              {inv.actions.some((a) => a.status === "waiting") && <div className="muted small">Approve or reject these in the Command Center queue. Money only moves inside your autonomy policy.</div>}
            </div>
          )}
          {inv.error && <div className="inv-actions">Failed: {inv.error}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * The autonomous investigator: Argus opens a case on a suspicious payment,
 * works it step by step with real tools, reaches a verdict and acts on it.
 */
export function Investigator({ state }: { state: AppState }) {
  const cases = state.investigations ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const txById = useMemo(() => new Map(state.transactions.map((t) => [t.id, t])), [state.transactions]);
  const investigated = new Set(cases.flatMap((c) => [c.transactionId, ...(c.verdict?.verdict === "fraud" ? (c.ring?.orderIds ?? []) : [])]));
  const queue = state.transactions
    .filter((t) => !investigated.has(t.id) && (t.status === "HELD" || (t.risk?.score ?? 0) >= 45))
    .sort((a, b) => (b.risk?.score ?? 0) - (a.risk?.score ?? 0))
    .slice(0, 8);

  // Follow the newest running case unless the user picked one.
  const live = cases.find((c) => c.status === "running");
  useEffect(() => {
    if (live && (!selected || cases.find((c) => c.id === selected)?.status !== "running")) setSelected(live.id);
  }, [live?.id]);
  const current = cases.find((c) => c.id === selected) ?? live ?? cases[0];

  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  const fraud = cases.filter((c) => c.verdict?.verdict === "fraud").length;
  const saved = cases.filter((c) => c.verdict?.verdict === "fraud").reduce((s, c) => s + (txById.get(c.transactionId)?.amount ?? 0), 0);

  return (
    <div className="inv">
      <section className="panel inv-intro">
        <div>
          <h1>Autonomous Investigator</h1>
          <p className="muted">
            Argus works each suspicious payment like an analyst: it opens the PayPal order, pulls the buyer's history, scores the signals, sweeps the identity network for linked accounts, traces the
            geography, reasons to a verdict and acts. The AI decides the verdict; what it may do is fixed in code and runs through your approval policy.
          </p>
        </div>
        <div className="inv-stats">
          <div><b>{cases.length}</b><span>cases worked</span></div>
          <div><b>{fraud}</b><span>fraud confirmed</span></div>
          <div><b>{usd(saved)}</b><span>stopped</span></div>
        </div>
        <button className="primary" disabled={queue.length === 0 || Boolean(live)} onClick={() => run(api("/investigations/all", {}))}>
          {live ? "Investigating…" : `Investigate ${queue.length || ""} suspicious`.trim()}
        </button>
      </section>
      {error && <div className="panel inv-err">{error}</div>}

      <div className="inv-grid">
        <aside className="panel inv-list">
          <div className="inv-list-h">Suspicious payments</div>
          {queue.length === 0 && <div className="muted small">Nothing waiting. Run a fraud storm from the Command Center to create some.</div>}
          {queue.map((t) => (
            <div key={t.id} className="inv-row">
              <div>
                <b className="mono">{t.id}</b> <span className={`inv-score s${(t.risk?.score ?? 0) >= 60 ? "h" : "m"}`}>{t.risk?.score ?? "–"}</span>
                <div className="muted small">{usd(t.amount)} · {t.buyer.name} · {t.status.toLowerCase()}</div>
              </div>
              <button disabled={Boolean(live)} onClick={() => run(api(`/transactions/${t.id}/investigate`, {}))}>
                Investigate
              </button>
            </div>
          ))}
          {cases.length > 0 && <div className="inv-list-h">Case files</div>}
          {cases.map((c) => (
            <button key={c.id} className={`inv-row inv-case-row ${current?.id === c.id ? "on" : ""}`} onClick={() => setSelected(c.id)}>
              <div>
                <b className="mono">{c.transactionId}</b>
                <div className="muted small">{c.id} · {ago(c.startedAt)}</div>
              </div>
              <span className={`inv-tag inv-v-${c.verdict?.verdict ?? "running"}`}>{c.verdict ? VERDICT_LABEL[c.verdict.verdict] : c.status === "failed" ? "Failed" : "Live"}</span>
            </button>
          ))}
        </aside>
        <section className="panel">
          {current ? (
            <CaseView inv={current} tx={txById.get(current.transactionId)} />
          ) : (
            <div className="empty">Pick a suspicious payment, or press Investigate, and watch Argus work the case live.</div>
          )}
        </section>
      </div>
    </div>
  );
}
