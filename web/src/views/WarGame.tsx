import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import type { AppState } from "../types";

interface GameOrder {
  id: string;
  attacker: boolean;
  tactic: string;
  score: number;
  caught: boolean;
  signals: string[];
  summary: string;
}

interface Round {
  n: number;
  tactic: string;
  redRationale: string;
  redBy: "ai" | "scripted";
  blueBy: "ai" | "rules-engine";
  orders: GameOrder[];
  caught: number;
  attacks: number;
  falsePositives: number;
  benign: number;
  detectionRate: number;
  newRules: string[];
  caughtAfterLearning: number;
  blueSummary: string;
  ml?: { version: number; caught: number; falsePositives: number; caughtAfterRetrain?: number; version2?: number };
}

interface ModelState {
  current: {
    version: number;
    samples: number;
    positives: number;
    trainedAt: string;
    holdout: { auc: number | null; precision: number; recall: number; f1: number };
    weights: { feature: string; label: string; weight: number }[];
  };
  history: { version: number; samples: number; positives: number; reason: string; holdout: { auc: number | null; recall: number } }[];
}

interface Rule {
  id: string;
  name: string;
  description: string;
  weight: number;
  createdRound: number;
  author: string;
  rationale: string;
  enabled: boolean;
  hits: number;
  backtest: { benignHits: number; benignTotal: number; attackHits: number; attackTotal: number };
}

interface Game {
  running: boolean;
  catchScore: number;
  rounds: Round[];
  rules: Rule[];
}

// Two-series palette on the dark surface: first contact (coral) vs. after learning (PayPal yellow).
const BEFORE = "#ff4d6d";
const AFTER = "#ffc439";

export function WarGame({ state }: { state: AppState }) {
  const [game, setGame] = useState<Game | null>(null);
  const [autoLeft, setAutoLeft] = useState(0);
  const version = state.events.filter((e) => e.agent === "red-team" || e.agent === "blue-team" || e.agent === "ml-model").length;
  const [model, setModel] = useState<ModelState | null>(null);
  useEffect(() => {
    api<ModelState>("/ml").then(setModel);
  }, [version]);

  useEffect(() => {
    api<Game>("/wargame").then(setGame);
  }, [version]);

  // Auto-play: start the next round when the previous one finishes.
  useEffect(() => {
    if (!game || game.running || autoLeft <= 0) return;
    const t = window.setTimeout(() => {
      setAutoLeft((n) => n - 1);
      api("/wargame/round", {}).catch(() => setAutoLeft(0));
    }, 900);
    return () => window.clearTimeout(t);
  }, [game, autoLeft]);

  if (!game) return <p className="muted">Loading war game…</p>;

  const attacks = game.rounds.reduce((s, r) => s + r.attacks, 0);
  const firstContact = game.rounds.reduce((s, r) => s + r.caught, 0);
  const fp = game.rounds.reduce((s, r) => s + r.falsePositives, 0);
  const benign = game.rounds.reduce((s, r) => s + r.benign, 0);
  const busy = game.running || autoLeft > 0;

  return (
    <div className="wargame">
      <section className="wg-head">
        <div>
          <h2>AI vs AI fraud war game</h2>
          <p className="muted">
            A red-team AI invents fraud waves against the shop. Argus scores them like real orders; anything it misses, the blue-team AI turns into a new
            rule, backtested against real customers before it goes live.
          </p>
        </div>
        <div className="wg-actions">
          <button className="primary" disabled={busy} onClick={() => api("/wargame/round", {})}>
            {game.running ? "Round in progress…" : "▶ Play round"}
          </button>
          <button disabled={busy} onClick={() => setAutoLeft(4)}>⏩ Auto-play 4</button>
          <button disabled={busy} onClick={() => api("/wargame/reset", {}).then(() => api<Game>("/wargame").then(setGame))}>Reset</button>
        </div>
      </section>

      <section className="kpis">
        <div className="kpi"><div className="kpi-label">Rounds</div><div className="kpi-value">{game.rounds.length}</div><div className="kpi-sub">{attacks} synthetic attacks</div></div>
        <div className="kpi"><div className="kpi-label">Caught on first contact</div><div className="kpi-value">{attacks ? Math.round((firstContact / attacks) * 100) : 0}%</div><div className="kpi-sub">{firstContact} of {attacks} by rules · ML model {game.rounds.reduce((s, r) => s + (r.ml?.caught ?? 0), 0)} of {attacks} unseen</div></div>
        <div className="kpi kpi-green"><div className="kpi-label">Rules learned</div><div className="kpi-value">{game.rules.length}</div><div className="kpi-sub">each backtested on real orders</div></div>
        <div className={`kpi ${fp ? "kpi-red" : ""}`}><div className="kpi-label">Honest customers blocked</div><div className="kpi-value">{fp}</div><div className="kpi-sub">of {benign} legit orders mixed in</div></div>
      </section>

      <div className="wg-grid">
        <section className="panel">
          <h2>Detection by round</h2>
          <RoundChart rounds={game.rounds} />
          <div className="wg-rounds">
            {[...game.rounds].reverse().map((r) => (
              <RoundCard key={r.n} r={r} />
            ))}
            {game.rounds.length === 0 && <p className="empty">Press Play round to send the first wave.</p>}
          </div>
        </section>

        <section className="panel">
          <h2>Learned rules</h2>
          {game.rules.length === 0 && <p className="empty">None yet. Argus writes these itself after it gets fooled.</p>}
          {game.rules.map((r) => (
            <div key={r.id} className={`rule ${r.enabled ? "" : "rule-off"}`}>
              <div className="row-between">
                <b>{r.name}</b>
                <label className="switch">
                  <input type="checkbox" checked={r.enabled} onChange={(e) => api(`/wargame/rules/${r.id}`, { enabled: e.target.checked }).then(() => api<Game>("/wargame").then(setGame))} />
                  <span>{r.enabled ? "on" : "off"}</span>
                </label>
              </div>
              <code>{r.description}</code>
              <div className="muted small">
                +{r.weight} · round {r.createdRound} · {r.author === "ai" ? "🤖 blue-team AI" : "📐 rules engine"} · stopped {r.hits} attack(s)
              </div>
              <div className="muted small">
                Backtest: {r.backtest.attackHits}/{r.backtest.attackTotal} missed attacks, {r.backtest.benignHits}/{r.backtest.benignTotal} legit orders
              </div>
              {r.author === "ai" && <p className="small">{r.rationale}</p>}
            </div>
          ))}
          {model && <ModelPanel m={model} />}
        </section>
      </div>
    </div>
  );
}

function RoundChart({ rounds }: { rounds: Round[] }) {
  const W = 640;
  const H = 200;
  const pad = { l: 36, r: 8, t: 18, b: 26 };
  const n = Math.max(rounds.length, 4);
  const slot = (W - pad.l - pad.r) / n;
  const bw = Math.min(26, slot / 3);
  const y = (v: number) => pad.t + (1 - v) * (H - pad.t - pad.b);
  const bar = (x: number, v: number, color: string, label: string) => {
    const top = y(v);
    const h = Math.max(0, y(0) - top);
    const r = Math.min(4, h);
    // Rounded data end at the top, square at the baseline.
    const d = `M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${y(0)} Z`;
    return (
      <g>
        <path d={d} fill={color}>
          <title>{label}</title>
        </path>
        <rect x={x - 2} y={pad.t} width={bw + 4} height={H - pad.t - pad.b} fill="transparent">
          <title>{label}</title>
        </rect>
      </g>
    );
  };
  return (
    <div>
      <div className="legend">
        <span><i style={{ background: BEFORE }} /> caught on first contact</span>
        <span><i style={{ background: AFTER }} /> caught after Argus learned</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Share of attacks caught per round, before and after learning">
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="gridline" />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="axis">{v * 100}%</text>
          </g>
        ))}
        {rounds.map((r, i) => {
          const x0 = pad.l + i * slot + slot / 2 - bw - 1;
          const after = r.caughtAfterLearning / r.attacks;
          return (
            <g key={r.n}>
              {bar(x0, r.detectionRate, BEFORE, `Round ${r.n}: ${r.caught}/${r.attacks} caught on first contact`)}
              {bar(x0 + bw + 2, after, AFTER, `Round ${r.n}: ${r.caughtAfterLearning}/${r.attacks} caught after learning`)}
              <text x={x0 + bw} y={H - 8} textAnchor="middle" className="axis">R{r.n}</text>
              {r.detectionRate < 1 && <text x={x0 + bw / 2} y={y(r.detectionRate) - 4} textAnchor="middle" className="axis val">{Math.round(r.detectionRate * 100)}%</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function RoundCard({ r }: { r: Round }) {
  return (
    <article className="wg-round">
      <div className="row-between">
        <div>
          <b>Round {r.n}</b> · {r.tactic} <span className="muted small">({r.redBy === "ai" ? "🤖 red-team AI" : "scripted attacker"})</span>
        </div>
        <span className={`lvl ${r.caught === r.attacks ? "risk-low" : r.caught === 0 ? "risk-critical" : "risk-medium"}`}>
          {r.caught}/{r.attacks} caught
        </span>
      </div>
      <p className="muted small">🗡️ {r.redRationale}</p>
      <div className="orders" aria-label="🛑 attack caught · 💸 attack slipped through · 🙂 legit order passed · ⚠️ legit order blocked">
        {r.orders.map((o) => (
          <span
            key={o.id}
            className={`chip ${o.attacker ? (o.caught ? "chip-caught" : "chip-missed") : o.caught ? "chip-fp" : "chip-ok"}`}
            title={`${o.id} · score ${o.score}\n${o.summary}\n${o.signals.join(", ") || "no signals"}`}
          >
            {o.attacker ? (o.caught ? "🛑" : "💸") : o.caught ? "⚠️" : "🙂"} {o.score}
          </span>
        ))}
      </div>
      {r.ml && (
        <p className="small">
          📈 ML model v{r.ml.version}, never trained on this wave: flagged <b>{r.ml.caught}/{r.attacks}</b>, {r.ml.falsePositives} false positive(s).
          {r.ml.version2 && <span className="muted"> Retrained as v{r.ml.version2}.</span>}
        </p>
      )}
      <p className="small">🛡️ {r.blueSummary || "Blue team is studying the misses…"}</p>
      {r.newRules.length > 0 && <p className="small muted">New rules: {r.newRules.join(" · ")}</p>}
    </article>
  );
}


function ModelPanel({ m }: { m: ModelState }) {
  const c = m.current;
  const max = Math.max(0.01, ...c.weights.map((w) => Math.abs(w.weight)));
  const ws = [...c.weights].sort((a, b) => b.weight - a.weight);
  return (
    <>
      <h2 className="mt">📈 Explainable ML model</h2>
      <p className="small muted">
        Logistic regression on {c.samples} labelled orders ({c.positives} fraud), retrained after every round on the wave it just saw. Linear, so every
        score splits exactly into per-feature contributions.
      </p>
      <div className="cp">
        <div><span className="muted small">Version</span> <b>v{c.version}</b></div>
        <div><span className="muted small">Holdout AUC</span> <b>{c.holdout.auc === null ? "n/a" : c.holdout.auc.toFixed(3)}</b></div>
        <div><span className="muted small">Precision</span> <b>{Math.round(c.holdout.precision * 100)}%</b></div>
        <div><span className="muted small">Recall</span> <b>{Math.round(c.holdout.recall * 100)}%</b></div>
      </div>
      <div className="legend">
        <span><i style={{ background: BEFORE }} /> pushes toward fraud</span>
        <span><i style={{ background: AFTER }} /> pushes toward legit</span>
      </div>
      <div className="mlbars">
        {ws.map((w) => (
          <Fragment key={w.feature}>
            <span>{w.label}</span>
            <span className="mlbar" title={`${w.label}: ${w.weight.toFixed(3)} log-odds per std. dev.`}>
              <span className={w.weight >= 0 ? "pos" : "neg"} style={{ width: `${(Math.abs(w.weight) / max) * 50}%` }} />
            </span>
            <span className="mono">{w.weight >= 0 ? "+" : ""}{w.weight.toFixed(2)}</span>
          </Fragment>
        ))}
      </div>
      {m.history.length > 1 && (
        <p className="small muted">
          History: {[...m.history].reverse().map((h) => `v${h.version} (${h.samples} samples)`).join(" → ")}
        </p>
      )}
    </>
  );
}
