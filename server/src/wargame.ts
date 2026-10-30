import { z } from "zod";
import { aiOnline } from "./agents/index.js";
import { defineTool, runAgent, type AgentSpec } from "./agents/llm.js";
import { catalog, merchant, productBySku } from "./catalog.js";
import { computeSignals, heuristicScore } from "./risk.js";
import { describeRule, features, FEATURES, learnedRules, matches, type Condition, type Feature, type LearnedRule } from "./rules.js";
import { ensure as ensureModel, modelVersion, resetModel, scoreTx, train } from "./ml.js";
import { fingerprintFor } from "./seed.js";
import { newId, store, type Transaction } from "./store.js";

/** Orders scoring at or above this would be held before shipping. */
export const CATCH_SCORE = 60;
const MAX_RULES_PER_ROUND = 3;
const MAX_BENIGN_HIT_RATE = 0.03;

export interface GameOrder {
  id: string;
  attacker: boolean;
  tactic: string;
  score: number;
  caught: boolean;
  signals: string[];
  summary: string;
  tx: Transaction;
}

export interface Round {
  n: number;
  at: string;
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
  /** The ML model's out-of-sample score on this wave, before it retrains on it. */
  ml?: { version: number; caught: number; falsePositives: number; caughtAfterRetrain?: number; version2?: number };
}

export const game = { rounds: [] as Round[], running: false, orders: [] as Transaction[] };

const pool = () => [...store.transactions.values(), ...game.orders];

/* ------------------------------ order factory ------------------------------ */

const orderSpec = z.object({
  buyerName: z.string(),
  email: z.string(),
  accountAgeDays: z.number().int().min(0).max(8000),
  buyerCountry: z.string().length(2),
  ipCountry: z.string().length(2),
  ip: z.string().describe("Checkout IPv4 address"),
  device: z.string().describe('e.g. "iPhone / Safari"'),
  shipCountry: z.string().length(2),
  shipCity: z.string(),
  shipAddress: z.string(),
  shipMethod: z.enum(["tracked", "express", "tracked-signature"]),
  deviceId: z.string().optional().describe("Device fingerprint; reuse one across orders only if the crew shares a phone"),
  items: z.array(z.object({ sku: z.enum(catalog.map((p) => p.sku) as [string, ...string[]]), quantity: z.number().int().min(1).max(10) })).min(1),
});
type OrderSpec = z.infer<typeof orderSpec>;

function toTx(spec: OrderSpec, round: number, i: number, attacker: boolean): Transaction {
  const items = spec.items.map(({ sku, quantity }) => {
    const p = productBySku(sku)!;
    return { name: p.name, quantity, unitAmount: p.price };
  });
  return {
    id: `WG${round}-${attacker ? "A" : "B"}${i + 1}`,
    orderId: newId("WGO"),
    captureId: newId("WGC"),
    createdAt: new Date(Date.now() + i * 7 * 60_000).toISOString(),
    amount: items.reduce((s, x) => s + x.quantity * x.unitAmount, 0),
    currency: "USD",
    items,
    buyer: { name: spec.buyerName, email: spec.email, country: spec.buyerCountry, accountAgeDays: spec.accountAgeDays },
    shipping: { country: spec.shipCountry, city: spec.shipCity, method: spec.shipMethod },
    ipCountry: spec.ipCountry,
    device: spec.device,
    fingerprint: { ip: spec.ip, deviceId: spec.deviceId ?? fingerprintFor(spec.email, spec.device, spec.ipCountry, spec.shipCity).deviceId, address: spec.shipAddress },
    status: "COMPLETED",
    refundedAmount: 0,
    source: "simulator",
  };
}

function score(tx: Transaction) {
  const signals = computeSignals(tx, pool());
  const s = heuristicScore(signals);
  return { score: s, caught: s >= CATCH_SCORE, signals: signals.filter((x) => x.weight > 0).map((x) => x.label) };
}

/* ------------------------------- benign traffic ------------------------------ */

const FIRST = ["Olivia", "Noah", "Aisha", "Kenji", "Elena", "Mateo", "Zara", "Liam", "Ines", "Omar", "Freya", "Ravi"];
const LAST = ["Brooks", "Tanaka", "Haddad", "Novak", "Reyes", "Okoro", "Lindqvist", "Shah", "Moreau", "Kowalski"];
const CITIES: [string, string][] = [["US", "Denver"], ["US", "Chicago"], ["GB", "Bristol"], ["DE", "Munich"], ["IN", "Pune"], ["CA", "Calgary"], ["FR", "Nantes"], ["AU", "Perth"]];
const DOMAINS = ["gmail.com", "outlook.com", "yahoo.com", "icloud.com", "proton.me"];
const DEVICES = ["iPhone / Safari", "Pixel / Chrome", "Mac / Safari", "Windows / Edge", "Android / Chrome"];

function benignSpec(seed: number): OrderSpec {
  const r = (k: number) => Math.abs(Math.sin(seed * 97.13 + k * 13.7)) % 1;
  const pickR = <T,>(xs: T[], k: number) => xs[Math.floor(r(k) * xs.length)];
  const first = pickR(FIRST, 1);
  const last = pickR(LAST, 2);
  const [country, city] = pickR(CITIES, 3);
  const device = pickR(DEVICES, 4);
  const email = `${first}.${last}${r(5) > 0.6 ? Math.floor(r(6) * 99) : ""}@${pickR(DOMAINS, 7)}`.toLowerCase();
  const fp = fingerprintFor(email, device, country, city);
  const sku = pickR(catalog, 8).sku;
  return {
    buyerName: `${first} ${last}`,
    email,
    // Real new customers exist too, so "new account" alone must not be enough to block.
    accountAgeDays: r(9) > 0.7 ? Math.floor(r(10) * 20) : 200 + Math.floor(r(11) * 3000),
    buyerCountry: country,
    ipCountry: country,
    ip: fp.ip,
    device,
    shipCountry: country,
    shipCity: city,
    shipAddress: fp.address,
    shipMethod: r(12) > 0.8 ? "express" : "tracked",
    items: [{ sku, quantity: r(13) > 0.85 ? 2 : 1 }],
  };
}

/* ------------------------------ scripted red team ----------------------------- */

const SCRIPTED: { tactic: string; rationale: string; make: (i: number) => OrderSpec }[] = [
  {
    tactic: "Blitz with throwaway accounts",
    rationale: "Fresh disposable-email accounts, big carts of resellable headphones, rushed to a forwarder.",
    make: (i) => ({
      buyerName: `Jay ${i}`, email: `jay.deals${4000 + i}@mailinator.com`, accountAgeDays: 0, buyerCountry: "US", ipCountry: "BR", ip: `177.54.${i}.9`,
      device: "Linux / Headless Chrome", shipCountry: "US", shipCity: "Doral", shipAddress: "8400 NW 25th St Ste 110, Doral", shipMethod: "express",
      items: [{ sku: "NA-ORBIT", quantity: 3 }],
    }),
  },
  {
    tactic: "Aged accounts, quiet carts",
    rationale: "Bought aged PayPal accounts, matching IP country, one item each, still routed to the same freight forwarder.",
    make: (i) => ({
      buyerName: ["Megan Ford", "Chris Dale", "Paula Ng", "Sean Ortiz", "Rita Vance"][i], email: `${["megan.ford", "chris.dale", "paula.ng", "sean.ortiz", "rita.vance"][i]}${81 + i}@gmail.com`,
      accountAgeDays: 400 + i * 130, buyerCountry: "US", ipCountry: "US", ip: `104.28.${10 + i}.${40 + i}`, device: "Android / Chrome",
      shipCountry: "US", shipCity: "Doral", shipAddress: `8400 NW 25th St Ste ${110 + i}, Doral`, shipMethod: "tracked",
      items: [{ sku: "NA-MONO", quantity: 1 }],
    }),
  },
  {
    tactic: "Rotate the drop address",
    rationale: "Forwarder addresses now trip a rule, so spread drops across Miami-area reshippers and switch to DACs.",
    make: (i) => ({
      buyerName: ["Ava Bell", "Leo Grant", "Mia Cruz", "Ben Hale", "Ivy Ross"][i], email: `${["ava.bell", "leo.grant", "mia.cruz", "ben.hale", "ivy.ross"][i]}${92 + i}@outlook.com`,
      accountAgeDays: 350 + i * 90, buyerCountry: "US", ipCountry: "US", ip: `104.28.${30 + i}.${12 + i}`, device: "Android / Chrome",
      shipCountry: "US", shipCity: ["Miami", "Hialeah", "Medley", "Miami Gardens", "Sweetwater"][i], shipAddress: `${7200 + i * 11} NW 41st St Unit ${3 + i}, Miami`, shipMethod: "tracked",
      items: [{ sku: "NA-DAC", quantity: 2 }],
    }),
  },
  {
    tactic: "Residential proxies, mixed products",
    rationale: "Swap the proxy range and device strings, mix products to look like normal shoppers.",
    make: (i) => ({
      buyerName: ["Nora Kim", "Eli Park", "Tess Wu", "Max Hill", "Joy Lane"][i], email: `${["nora.kim", "eli.park", "tess.wu", "max.hill", "joy.lane"][i]}${70 + i}@yahoo.com`,
      accountAgeDays: 500 + i * 60, buyerCountry: "US", ipCountry: "US", ip: `172.58.${60 + i}.${7 + i}`, device: ["iPhone / Safari", "Mac / Chrome", "Windows / Edge", "iPad / Safari", "Pixel / Chrome"][i],
      shipCountry: "US", shipCity: "Miami", shipAddress: `${7300 + i * 9} NW 41st St Unit ${9 + i}, Miami`, shipMethod: "tracked",
      items: [{ sku: ["NA-MONO", "NA-ORBIT", "NA-DAC", "NA-MONO", "NA-ORBIT"][i], quantity: 1 }],
    }),
  },
];

/* --------------------------------- AI red team -------------------------------- */

let launched: { tactic: string; rationale: string; orders: OrderSpec[] } | null = null;

const BASE_DEFENSES = `Base signals (weights add up to a 0-99 score; orders scoring ${CATCH_SCORE}+ are held):
- order velocity (3+ orders from one email within an hour), brand-new account (<=3 days, +18) or young (<=30 days, +7)
- IP country != account country (+14), shipping country != account country (+10)
- disposable email domains (mailinator, tempmail, guerrillamail, 10minutemail, trashmail) (+16)
- order amount > 2 standard deviations above the shop average (up to +20), 4+ units (+8)
- express shipping on $300+ orders (+9), account-takeover pattern on established buyers (+22)
- accounts linked by shared device fingerprint, IP /24 or normalised shipping address (+16 or more)`;

const getBriefing = defineTool({
  name: "get_defense_briefing",
  description: "What Argus is known to check, the rules it has learned so far, and how your previous waves fared.",
  inputSchema: z.object({}),
  run: async () => ({
    baseDefenses: BASE_DEFENSES,
    learnedRules: learnedRules.filter((r) => r.enabled).map((r) => `${r.name}: ${describeRule(r)} (+${r.weight})`),
    previousWaves: game.rounds.map((r) => ({
      round: r.n,
      tactic: r.tactic,
      caught: `${r.caught}/${r.attacks}`,
      caughtBy: [...new Set(r.orders.filter((o) => o.attacker && o.caught).flatMap((o) => o.signals))],
    })),
    catalog: catalog.map((p) => `${p.sku} ${p.name} $${p.price}`),
  }),
});

const launchAttack = defineTool({
  name: "launch_attack",
  description: "Launch one wave of 4-5 fraudulent orders against the shop. Each order must be internally consistent.",
  inputSchema: z.object({
    tactic: z.string().describe("Short name for this wave's tactic"),
    rationale: z.string().describe("Why this should slip past the current defenses"),
    orders: z.array(orderSpec).min(3).max(6),
  }),
  run: async (input) => {
    launched = input;
    return `Wave queued: ${input.orders.length} orders.`;
  },
});

const redTeam: AgentSpec = {
  name: "red-team",
  effort: "medium",
  system: `You are the red team in a sanctioned fraud-defense exercise for ${merchant.name}, an online audio shop protected by Argus. Your orders are synthetic and only ever run inside this test harness; their purpose is to find blind spots so the defense can learn.
Play a realistic, financially motivated fraud crew: you want to receive resellable goods without paying for them, so every order must still ship to an address you control and should carry real value.
Read get_defense_briefing, then call launch_attack once with a wave designed to evade what you know about. Adapt to rules learned in earlier rounds — don't repeat a tactic that was caught. Use invented names and example email addresses, never real people.`,
  tools: [getBriefing, launchAttack],
};

/* --------------------------------- blue team ---------------------------------- */

function backtest(conditions: Condition[], attacks: Transaction[]) {
  const benign = [...store.transactions.values(), ...game.orders.filter((o) => o.id.includes("-B"))];
  const benignHits = benign.filter((t) => matches({ conditions }, t) && !t.risk?.action?.match(/hold|refund/)).length;
  return { benignHits, benignTotal: benign.length, attackHits: attacks.filter((t) => matches({ conditions }, t)).length, attackTotal: attacks.length };
}

function addRule(round: number, author: LearnedRule["author"], input: { name: string; conditions: Condition[]; weight: number; rationale: string }, attacks: Transaction[]) {
  const bt = backtest(input.conditions, attacks);
  if (bt.attackHits === 0) return { accepted: false as const, reason: "Rule matches none of this round's missed attacks.", backtest: bt };
  if (bt.benignHits / Math.max(1, bt.benignTotal) > MAX_BENIGN_HIT_RATE)
    return { accepted: false as const, reason: `Too broad: it would flag ${bt.benignHits} of ${bt.benignTotal} legitimate orders.`, backtest: bt };
  const rule: LearnedRule = { id: newId("RULE"), ...input, createdRound: round, author, enabled: true, hits: 0, backtest: bt };
  learnedRules.push(rule);
  store.log({ agent: author === "ai" ? "blue-team" : "rules-engine", kind: "action", message: `New rule "${rule.name}": ${describeRule(rule)} (+${rule.weight}). Backtest: ${bt.attackHits}/${bt.attackTotal} attacks, ${bt.benignHits}/${bt.benignTotal} legit orders.` });
  return { accepted: true as const, rule, backtest: bt };
}

const conditionSchema = z.object({
  feature: z.enum(Object.keys(FEATURES) as [Feature, ...Feature[]]),
  op: z.enum(["gt", "gte", "lt", "lte", "eq", "neq", "contains", "in"]),
  value: z.union([z.string(), z.number(), z.array(z.string())]),
});

function blueTools(round: Round, missed: () => Transaction[]) {
  const report = defineTool({
    name: "get_round_report",
    description: "The attacks that slipped through this round (with their features and the signals that fired), any legitimate orders wrongly flagged, and the current learned rules.",
    inputSchema: z.object({}),
    run: async () => ({
      catchThreshold: CATCH_SCORE,
      missedAttacks: round.orders.filter((o) => o.attacker && !o.caught).map((o) => ({ id: o.id, score: o.score, signals: o.signals, features: features(o.tx) })),
      caughtAttacks: round.orders.filter((o) => o.attacker && o.caught).length,
      falsePositives: round.orders.filter((o) => !o.attacker && o.caught).map((o) => ({ id: o.id, score: o.score, signals: o.signals, features: features(o.tx) })),
      featureGlossary: FEATURES,
      existingRules: learnedRules.map((r) => `${r.name}: ${describeRule(r)} (+${r.weight})`),
    }),
  });
  const propose = defineTool({
    name: "propose_rule",
    description: `Propose a detection rule (all conditions must hold). It is backtested immediately and rejected if it matches no missed attack or flags more than ${MAX_BENIGN_HIT_RATE * 100}% of legitimate orders. Prefer combinations of features over single broad ones.`,
    inputSchema: z.object({
      name: z.string(),
      conditions: z.array(conditionSchema).min(1).max(4),
      weight: z.number().int().min(10).max(60),
      rationale: z.string(),
    }),
    run: async (input) => {
      if (round.newRules.length >= MAX_RULES_PER_ROUND) return "Rule budget for this round is used up.";
      const res = addRule(round.n, "ai", input, missed());
      if (res.accepted) round.newRules.push(res.rule.name);
      return res.accepted ? { accepted: true, backtest: res.backtest } : res;
    },
  });
  return [report, propose];
}

const GENERIC_WORDS = new Set(["unit", "suite", "street", "avenue", "road", "apartment"]);

/** Offline blue team: find the most specific feature value the missed attacks share. */
function heuristicBlue(round: Round, missed: Transaction[]) {
  if (!missed.length) return "Nothing slipped through; no new rules needed.";
  const candidates: Condition[] = [];
  const counts = new Map<string, number>();
  for (const t of missed) {
    const f = features(t);
    const tokens = [
      ...String(f.shipCity)
        .split(/[\s,]+/)
        .filter((w) => w.length > 3 && !/^\d/.test(w) && !GENERIC_WORDS.has(w))
        .map((w) => `shipCity|contains|${w}`),
      `ipPrefix|eq|${f.ipPrefix}`,
      `device|eq|${f.device}`,
      `emailDomain|eq|${f.emailDomain}`,
    ];
    for (const k of new Set(tokens)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    if (n < Math.ceil(missed.length / 2)) break;
    const [feature, op, value] = k.split("|");
    candidates.push({ feature: feature as Feature, op: op as Condition["op"], value });
  }
  for (const c of candidates) {
    if (learnedRules.some((r) => describeRule(r) === describeRule({ conditions: [c] }))) continue;
    const res = addRule(round.n, "rules-engine", { name: `${c.feature} ${c.value}`, conditions: [c], weight: CATCH_SCORE - 4, rationale: "Shared by most missed attacks, rare in legitimate traffic." }, missed);
    if (res.accepted) {
      round.newRules.push(res.rule.name);
      if (round.newRules.length >= MAX_RULES_PER_ROUND) break;
    }
  }
  return round.newRules.length ? `Learned ${round.newRules.length} rule(s) from ${missed.length} missed attack(s).` : "No safe rule found; flagging for human review.";
}

const blueTeam = (n: number): AgentSpec => ({
  name: "blue-team",
  effort: "medium",
  system: `You are Argus's blue team. After each red-team wave you study the attacks that slipped through and write new detection rules so the next wave gets caught, without blocking honest customers (round ${n}).
Call get_round_report, find what the missed attacks have in common that legitimate orders don't, and call propose_rule (up to ${MAX_RULES_PER_ROUND} times). A rejected rule is feedback: tighten it with another condition. Generalise to the tactic, not the exact strings, where you can. End with two sentences for the merchant.`,
  tools: [],
});

/* ---------------------------------- a round ----------------------------------- */

export async function playRound(): Promise<Round> {
  if (game.running) throw new Error("A round is already running");
  game.running = true;
  try {
    const n = game.rounds.length + 1;
    store.log({ agent: "red-team", kind: "info", message: `War game round ${n}: red team is planning a wave…` });

    let specs: OrderSpec[];
    let tactic: string;
    let rationale: string;
    let redBy: Round["redBy"] = "scripted";
    launched = null;
    if (aiOnline()) {
      await runAgent(redTeam, `Plan wave ${n}.`).catch((e) => store.log({ agent: "red-team", kind: "error", message: String(e) }));
    }
    if (launched) {
      ({ tactic, rationale, orders: specs } = launched as { tactic: string; rationale: string; orders: OrderSpec[] });
      redBy = "ai";
    } else {
      const s = SCRIPTED[(n - 1) % SCRIPTED.length];
      tactic = s.tactic;
      rationale = s.rationale;
      specs = Array.from({ length: 5 }, (_, i) => s.make(i));
    }

    ensureModel(); // fit on past data before this wave exists, so its score is out-of-sample
    const attacks = specs.map((s, i) => toTx(s, n, i, true));
    const benign = Array.from({ length: 4 }, (_, i) => toTx(benignSpec(n * 10 + i), n, i, false));
    game.orders.push(...attacks, ...benign);

    const scored = (tx: Transaction, attacker: boolean): GameOrder => {
      const s = score(tx);
      return { id: tx.id, attacker, tactic: attacker ? tactic : "legitimate", ...s, summary: `${tx.buyer.email} · $${tx.amount} → ${tx.shipping.city}`, tx };
    };
    const orders = [...attacks.map((t) => scored(t, true)), ...benign.map((t) => scored(t, false))];
    const caught = orders.filter((o) => o.attacker && o.caught).length;
    const round: Round = {
      n,
      at: new Date().toISOString(),
      tactic,
      redRationale: rationale,
      redBy,
      blueBy: aiOnline() ? "ai" : "rules-engine",
      orders,
      caught,
      attacks: attacks.length,
      falsePositives: orders.filter((o) => !o.attacker && o.caught).length,
      benign: benign.length,
      detectionRate: caught / attacks.length,
      newRules: [],
      caughtAfterLearning: caught,
      blueSummary: "",
    };
    const mlVersion = modelVersion();
    round.ml = {
      version: mlVersion,
      caught: attacks.filter((t) => scoreTx(t) >= 0.5).length,
      falsePositives: benign.filter((t) => scoreTx(t) >= 0.5).length,
    };
    game.rounds.push(round);
    store.log({ agent: "ml-model", kind: "info", message: `Round ${n}: model v${mlVersion} flagged ${round.ml.caught}/${attacks.length} attacks it had never seen, ${round.ml.falsePositives} false positive(s).` });
    store.log({ agent: "red-team", kind: "decision", message: `Wave ${n} "${tactic}": ${rationale}` });
    store.log({ agent: "policy-engine", kind: "info", message: `Round ${n}: Argus caught ${caught}/${attacks.length} attacks, ${round.falsePositives} false positive(s).` });
    store.changed("wargame");

    const missed = () => orders.filter((o) => o.attacker && !o.caught).map((o) => o.tx);
    if (missed().length) {
      if (aiOnline()) {
        const spec = blueTeam(n);
        spec.tools = blueTools(round, missed);
        round.blueSummary = (await runAgent(spec, `Round ${n} report is ready. Close the gaps.`).catch((e) => ({ text: `Blue team failed: ${e}` }))).text;
      } else {
        round.blueSummary = heuristicBlue(round, missed());
      }
    } else round.blueSummary = "Clean sweep. No new rules needed.";

    for (const r of learnedRules) r.hits = game.orders.filter((t) => t.id.includes("-A") && matches(r, t)).length;
    round.caughtAfterLearning = orders.filter((o) => o.attacker && score(o.tx).caught).length;
    const v = train(`Retrained on round ${n}'s labelled wave.`);
    round.ml.version2 = v.version;
    round.ml.caughtAfterRetrain = attacks.filter((t) => scoreTx(t) >= 0.5).length;
    store.log({ agent: "blue-team", kind: "decision", message: `Round ${n}: ${round.blueSummary} Re-scored this wave: ${round.caughtAfterLearning}/${round.attacks} now caught.` });
    store.changed("wargame");
    return round;
  } finally {
    game.running = false;
  }
}

export function resetGame() {
  game.rounds = [];
  game.orders = [];
  learnedRules.splice(0);
  resetModel();
  store.changed("wargame");
}

export function toggleRule(id: string, enabled: boolean) {
  const r = learnedRules.find((x) => x.id === id);
  if (!r) throw new Error("No such rule");
  r.enabled = enabled;
  store.changed("wargame");
  return r;
}
