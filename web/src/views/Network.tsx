import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useEffect, useMemo, useState } from "react";
import { api, usd } from "../api";
import type { AppState } from "../types";

type Kind = "account" | "device" | "ip" | "address";

interface GNode extends SimulationNodeDatum {
  id: string;
  kind: Kind;
  label: string;
  ringId?: string;
  orders?: number;
  amount?: number;
  accountAgeDays?: number;
  maxRisk?: number;
}

interface Ring {
  id: string;
  accounts: string[];
  orders: string[];
  totalAmount: number;
  avgAccountAgeDays: number;
  sharedSignals: { kind: Kind; value: string; accounts: number }[];
  score: number;
  verdict: { verdict: "fraud" | "benign"; explanation: string; by: string } | null;
}

interface Graph {
  nodes: GNode[];
  links: { source: string; target: string }[];
  rings: Ring[];
}

const W = 900;
const H = 620;
const KIND_COLOR: Record<Kind, string> = { account: "#93c5fd", device: "#c084fc", ip: "#22d3ee", address: "#f7c55e" };
const KIND_ICON: Record<Kind, string> = { account: "👤", device: "📱", ip: "🌐", address: "📦" };

/** Lays the graph out once per change of shape, keeping positions of nodes that already exist. */
function useLayout(graph: Graph | null) {
  const [frame, setFrame] = useState<{ nodes: GNode[]; links: SimulationLinkDatum<GNode>[] } | null>(null);
  const shape = graph ? `${graph.nodes.length}:${graph.links.length}` : "";

  useEffect(() => {
    if (!graph) return;
    const prev = new Map(frame?.nodes.map((n) => [n.id, n]) ?? []);
    const nodes: GNode[] = graph.nodes.map((n) => ({ ...n, x: prev.get(n.id)?.x, y: prev.get(n.id)?.y }));
    const links = graph.links.map((l) => ({ source: l.source, target: l.target })) as SimulationLinkDatum<GNode>[];
    const sim = forceSimulation(nodes)
      .force("link", forceLink<GNode, SimulationLinkDatum<GNode>>(links).id((d) => d.id).distance((l) => ((l.target as GNode).ringId ? 85 : 34)).strength(0.9))
      .force("charge", forceManyBody().strength((d) => ((d as GNode).kind === "account" ? -260 : -60)))
      .force("collide", forceCollide<GNode>((d) => (d.kind === "account" ? 14 : 8)))
      .force("x", forceX(W / 2).strength(0.05))
      .force("y", forceY(H / 2).strength(0.06));
    sim.on("tick", () => setFrame({ nodes: [...nodes], links }));
    return () => {
      sim.stop();
    };
    // Re-layout only when the graph's shape changes.
  }, [shape]);

  // Refresh labels/risk without moving anything.
  useEffect(() => {
    if (!graph || !frame) return;
    const latest = new Map(graph.nodes.map((n) => [n.id, n]));
    setFrame((f) => f && { ...f, nodes: f.nodes.map((n) => ({ ...n, ...latest.get(n.id), x: n.x, y: n.y })) });
  }, [graph]);

  return frame;
}

export function Network({ state }: { state: AppState }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  // The graph is derived from transactions, so refetch whenever they change.
  const txVersion = useMemo(() => state.transactions.map((t) => `${t.id}${t.status}${t.risk?.score ?? ""}`).join(), [state.transactions]);
  const verdictVersion = state.events.filter((e) => e.agent === "ring-hunter" || e.message.includes("RING-")).length;
  useEffect(() => {
    api<Graph>("/graph").then(setGraph);
  }, [txVersion, verdictVersion]);

  const frame = useLayout(graph);
  if (!graph || !frame) return <p className="muted">Building identity graph…</p>;

  const byId = new Map(frame.nodes.map((n) => [n.id, n]));
  const inFocus = (n: GNode) => !focus || n.ringId === focus;
  const focused = graph.rings.find((r) => r.id === focus);

  return (
    <div className="network">
      <section className="panel graph-panel">
        <div className="row-between">
          <h2>Identity graph</h2>
          <div className="legend">
            {(Object.keys(KIND_COLOR) as Kind[]).map((k) => (
              <span key={k}>
                <i style={{ background: KIND_COLOR[k] }} /> {k === "ip" ? "IP range" : k}
              </span>
            ))}
            <span><i style={{ background: "#ff5c72" }} /> ring</span>
          </div>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="graph" onClick={() => setFocus(null)}>
          {frame.links.map((l, i) => {
            const s = l.source as GNode;
            const t = l.target as GNode;
            if (s.x === undefined || t.x === undefined) return null;
            const ring = t.ringId && s.ringId === t.ringId;
            return (
              <line
                key={i}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                className={ring ? "edge edge-ring" : "edge"}
                opacity={inFocus(s) || inFocus(t) ? 1 : 0.15}
              />
            );
          })}
          {frame.nodes.map((n) => {
            if (n.x === undefined || n.y === undefined) return null;
            const dim = inFocus(n) ? 1 : 0.2;
            if (n.kind === "account") {
              const r = 6 + Math.min(12, Math.sqrt(n.amount ?? 0) / 4);
              const fill = n.ringId ? "#ff5c72" : (n.maxRisk ?? 0) >= 60 ? "#f97316" : KIND_COLOR.account;
              return (
                <g key={n.id} transform={`translate(${n.x},${n.y})`} opacity={dim} onClick={(e) => { e.stopPropagation(); setFocus(n.ringId ?? null); }} className="gnode">
                  {n.ringId && <circle r={r + 6} className="pulse" />}
                  <circle r={r} fill={fill} stroke="#050a16" strokeWidth={2} />
                  <text y={r + 12} textAnchor="middle" className="glabel">{n.label}</text>
                  <title>{`${n.label}\n${n.orders} order(s) · ${usd(n.amount ?? 0)}\naccount ${n.accountAgeDays}d old · max risk ${n.maxRisk}`}</title>
                </g>
              );
            }
            const shared = Boolean(n.ringId);
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} opacity={dim}>
                <rect x={-5} y={-5} width={10} height={10} rx={2} fill={KIND_COLOR[n.kind]} transform="rotate(45)" stroke={shared ? "#fff" : "none"} />
                {shared && <text y={-10} textAnchor="middle" className="glabel glabel-attr">{KIND_ICON[n.kind]} {n.label}</text>}
                <title>{`${n.kind}: ${n.label}`}</title>
              </g>
            );
          })}
        </svg>
        <p className="muted small">
          Each person is a circle. Diamonds are the devices, IP ranges and shipping addresses they used. Honest buyers sit alone; accounts that secretly share
          infrastructure collapse into a cluster. Addresses are normalised, so “Street #3” and “St Apt 3” still match.
        </p>
      </section>

      <section className="rings">
        <h2>Detected rings</h2>
        {graph.rings.length === 0 && <p className="empty">No linked accounts. Everyone looks independent.</p>}
        {graph.rings.map((r) => (
          <article key={r.id} className={`ring ${focus === r.id ? "ring-on" : ""}`} onClick={() => setFocus(r.id)}>
            <div className="row-between">
              <b className="mono">{r.id}</b>
              <span className={`lvl ${r.score >= 85 ? "risk-critical" : r.score >= 60 ? "risk-high" : "risk-medium"}`}>score {r.score}</span>
            </div>
            <div className="ring-stats">
              <span><b>{r.accounts.length}</b> accounts</span>
              <span><b>{r.orders.length}</b> orders</span>
              <span><b>{usd(r.totalAmount)}</b></span>
              <span>avg age <b>{r.avgAccountAgeDays}d</b></span>
            </div>
            <ul className="shared">
              {r.sharedSignals.map((s) => (
                <li key={s.kind + s.value}>
                  {KIND_ICON[s.kind]} <span className="mono small">{s.value}</span> <span className="muted">× {s.accounts}</span>
                </li>
              ))}
            </ul>
            {r.verdict ? (
              <div className={`answer verdict-${r.verdict.verdict}`}>
                <b>{r.verdict.verdict === "fraud" ? "🚨 Fraud ring" : "✅ Benign cluster"}</b> · {r.verdict.by}
                <div>{r.verdict.explanation}</div>
              </div>
            ) : (
              <button className="primary" onClick={(e) => { e.stopPropagation(); setFocus(r.id); api(`/rings/${r.id}/analyse`, {}); }}>
                Investigate with Ring Hunter
              </button>
            )}
          </article>
        ))}
        {focused && (
          <p className="muted small">
            Showing {focused.id}: {focused.accounts.join(", ")}. Click empty space to show everyone.
          </p>
        )}
      </section>
    </div>
  );
}
