import { buildGraph } from "./graph.js";
import { store, type Transaction } from "./store.js";
import { game } from "./wargame.js";

/**
 * A small, fully explainable fraud model that sits beside the rules: L2
 * logistic regression over interpretable features, trained in-process. It
 * retrains after every war-game round on the labelled orders the red team
 * just sent, so it learns from attacks it has never seen. Because the model
 * is linear, each feature's contribution (weight × standardised value) is an
 * exact attribution of the log-odds, so every score comes with its reasons.
 */

export const ML_FEATURES = [
  { key: "amountLog", label: "Order size (log $)" },
  { key: "units", label: "Units in cart" },
  { key: "newAccount", label: "Account ≤ 3 days old" },
  { key: "accountAgeLog", label: "Account age (log days)" },
  { key: "emailDigits", label: "Digits in email" },
  { key: "disposableEmail", label: "Disposable email domain" },
  { key: "ipMismatch", label: "IP country ≠ account" },
  { key: "shipMismatch", label: "Ship country ≠ account" },
  { key: "express", label: "Express shipping" },
  { key: "automation", label: "Headless / automation browser" },
  { key: "linkedAccounts", label: "Accounts sharing device/IP/address" },
  { key: "velocity", label: "Orders from this email in 1h" },
  { key: "reshipper", label: "Suite/unit drop address" },
  { key: "premiumSku", label: "High-resale product ($200+)" },
] as const;

type Key = (typeof ML_FEATURES)[number]["key"];
const K = ML_FEATURES.length;
const DISPOSABLE = /mailinator|tempmail|guerrillamail|10minutemail|trashmail|yopmail/;

interface Context {
  ringSize: Map<string, number>;
  byEmail: Map<string, number[]>;
}

function context(pool: Transaction[]): Context {
  const ringSize = new Map<string, number>();
  for (const r of buildGraph(pool).rings) for (const a of r.accounts) ringSize.set(a, r.accounts.length - 1);
  const byEmail = new Map<string, number[]>();
  for (const t of pool) {
    const e = t.buyer.email.toLowerCase();
    byEmail.set(e, [...(byEmail.get(e) ?? []), Date.parse(t.createdAt)]);
  }
  return { ringSize, byEmail };
}

function vector(t: Transaction, ctx: Context): number[] {
  const email = t.buyer.email.toLowerCase();
  const [local, domain = ""] = email.split("@");
  const at = Date.parse(t.createdAt);
  const v: Record<Key, number> = {
    amountLog: Math.log(Math.max(1, t.amount)),
    units: t.items.reduce((s, i) => s + i.quantity, 0),
    newAccount: t.buyer.accountAgeDays <= 3 ? 1 : 0,
    accountAgeLog: Math.log1p(t.buyer.accountAgeDays),
    emailDigits: (local.match(/\d/g) ?? []).length,
    disposableEmail: DISPOSABLE.test(domain) ? 1 : 0,
    ipMismatch: t.ipCountry !== t.buyer.country ? 1 : 0,
    shipMismatch: t.shipping.country !== t.buyer.country ? 1 : 0,
    express: t.shipping.method === "express" ? 1 : 0,
    automation: /headless|selenium|phantom|puppeteer/i.test(t.device) ? 1 : 0,
    linkedAccounts: ctx.ringSize.get(email) ?? 0,
    velocity: (ctx.byEmail.get(email) ?? []).filter((x) => Math.abs(x - at) <= 3_600_000).length,
    reshipper: /\b(ste|suite|unit)\b|freight|forwarder/i.test(`${t.fingerprint.address} ${t.shipping.city}`) ? 1 : 0,
    premiumSku: t.items.some((i) => i.unitAmount >= 200) ? 1 : 0,
  };
  return ML_FEATURES.map((f) => v[f.key]);
}

/* ----------------------------------- labels ----------------------------------- */

// Ground truth for the seeded history: the card-tester, the ring and the account takeover.
const KNOWN_FRAUD = new Set(["deals4u.8812@tempmail.dev", "emily.rhodes.92@gmail.com", "mwebb.audio@outlook.com", "chloepark.music@yahoo.com", "ryan.cole.sf@gmail.com"]);
const seedLabel = (t: Transaction) => (KNOWN_FRAUD.has(t.buyer.email.toLowerCase()) || (t.buyer.name === "Hannah Kim" && t.ipCountry !== t.buyer.country) ? 1 : 0);

function dataset(upToRound = Infinity) {
  const seeded = [...store.transactions.values()].filter((t) => t.source === "seed");
  const wg = game.orders.filter((t) => Number(t.id.match(/^WG(\d+)-/)?.[1]) <= upToRound);
  const pool = [...store.transactions.values(), ...game.orders];
  const ctx = context(pool);
  return {
    X: [...seeded, ...wg].map((t) => vector(t, ctx)),
    y: [...seeded.map(seedLabel), ...wg.map((t) => (t.id.includes("-A") ? 1 : 0))],
    ids: [...seeded, ...wg].map((t) => t.id),
  };
}

/* ---------------------------------- training ---------------------------------- */

interface Fit {
  w: number[];
  b: number;
  mean: number[];
  std: number[];
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function fit(X: number[][], y: number[]): Fit {
  const n = X.length;
  const mean = Array.from({ length: K }, (_, j) => X.reduce((s, x) => s + x[j], 0) / n);
  const std = Array.from({ length: K }, (_, j) => Math.sqrt(X.reduce((s, x) => s + (x[j] - mean[j]) ** 2, 0) / n) || 1);
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
  const pos = y.filter(Boolean).length;
  // Balance classes so a handful of frauds aren't drowned out.
  const cw = y.map((l) => (l ? n / (2 * Math.max(1, pos)) : n / (2 * Math.max(1, n - pos))));
  const w = new Array(K).fill(0);
  let b = 0;
  const lr = 0.2;
  const l2 = 0.01;
  for (let epoch = 0; epoch < 800; epoch++) {
    const gw = new Array(K).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const err = (sigmoid(b + Z[i].reduce((s, z, j) => s + z * w[j], 0)) - y[i]) * cw[i];
      for (let j = 0; j < K; j++) gw[j] += err * Z[i][j];
      gb += err;
    }
    for (let j = 0; j < K; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= (lr * gb) / n;
  }
  return { w, b, mean, std };
}

const predict = (m: Fit, x: number[]) => sigmoid(m.b + x.reduce((s, v, j) => s + ((v - m.mean[j]) / m.std[j]) * m.w[j], 0));

function auc(scores: number[], y: number[]) {
  const pos = scores.filter((_, i) => y[i]);
  const neg = scores.filter((_, i) => !y[i]);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function metrics(scores: number[], y: number[]) {
  const tp = scores.filter((s, i) => s >= 0.5 && y[i]).length;
  const fp = scores.filter((s, i) => s >= 0.5 && !y[i]).length;
  const fn = scores.filter((s, i) => s < 0.5 && y[i]).length;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return { auc: auc(scores, y), precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

export interface ModelVersion {
  version: number;
  trainedAt: string;
  reason: string;
  samples: number;
  positives: number;
  /** Held-out metrics (every 4th sample), measured before the final fit on everything. */
  holdout: ReturnType<typeof metrics>;
  weights: { feature: string; label: string; weight: number }[];
}

let model: Fit | null = null;
export const history: ModelVersion[] = [];

export function train(reason: string, upToRound = Infinity) {
  const { X, y } = dataset(upToRound);
  const test = X.map((_, i) => i % 4 === 3);
  const trial = fit(X.filter((_, i) => !test[i]), y.filter((_, i) => !test[i]));
  const holdout = metrics(X.filter((_, i) => test[i]).map((x) => predict(trial, x)), y.filter((_, i) => test[i]));
  model = fit(X, y);
  const v: ModelVersion = {
    version: history.length + 1,
    trainedAt: new Date().toISOString(),
    reason,
    samples: X.length,
    positives: y.filter(Boolean).length,
    holdout,
    weights: ML_FEATURES.map((f, j) => ({ feature: f.key, label: f.label, weight: model!.w[j] })),
  };
  history.unshift(v);
  store.log({
    agent: "ml-model",
    kind: "action",
    message: `Trained risk model v${v.version} on ${v.samples} labelled orders (${v.positives} fraud): holdout AUC ${v.holdout.auc?.toFixed(3) ?? "n/a"}, recall ${(v.holdout.recall * 100).toFixed(0)}%. ${reason}`,
  });
  return v;
}

export const ensure = () => model ?? (train("Initial fit on seeded history."), model!);

/** Probability of fraud plus exact per-feature log-odds contributions. */
export function explain(t: Transaction) {
  const m = ensure();
  const x = vector(t, context([...store.transactions.values(), ...game.orders]));
  const contributions = ML_FEATURES.map((f, j) => ({ feature: f.key, label: f.label, value: Number(x[j].toFixed(2)), contribution: ((x[j] - m.mean[j]) / m.std[j]) * m.w[j] }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return { probability: predict(m, x), baseLogOdds: m.b, version: history[0]?.version ?? 1, contributions };
}

export const modelVersion = () => (ensure(), history[0].version);

export const scoreTx = (t: Transaction) => explain(t).probability;

export function modelState() {
  ensure();
  return { current: history[0], history: history.map(({ weights: _w, ...rest }) => rest), features: ML_FEATURES };
}

export function resetModel() {
  model = null;
  history.splice(0);
}
