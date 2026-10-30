import { createHash } from "node:crypto";
import { catalog } from "./catalog.js";
import { computeSignals, heuristicScore, levelFor } from "./risk.js";
import { store, type Buyer, type Dispute, type LineItem, type Transaction } from "./store.js";

// Small deterministic PRNG so every fresh start shows the same story.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const regulars: (Buyer & { city: string; device: string })[] = [
  { name: "Maya Chen", email: "maya.chen@gmail.com", country: "US", accountAgeDays: 2140, city: "Portland", device: "iPhone / Safari" },
  { name: "Arjun Mehta", email: "arjun.mehta@outlook.com", country: "IN", accountAgeDays: 1310, city: "Bengaluru", device: "Pixel / Chrome" },
  { name: "Sophie Laurent", email: "sophie.l@orange.fr", country: "FR", accountAgeDays: 980, city: "Lyon", device: "Mac / Safari" },
  { name: "Tom Becker", email: "tbecker@web.de", country: "DE", accountAgeDays: 1720, city: "Hamburg", device: "Windows / Edge" },
  { name: "Priya Nair", email: "priya.nair@yahoo.com", country: "GB", accountAgeDays: 640, city: "Leeds", device: "Android / Chrome" },
  { name: "Lucas Silva", email: "lucas.silva@gmail.com", country: "BR", accountAgeDays: 410, city: "Curitiba", device: "Windows / Chrome" },
  { name: "Hannah Kim", email: "hannah.kim@icloud.com", country: "US", accountAgeDays: 2900, city: "Austin", device: "Mac / Safari" },
  { name: "Daniel Ortiz", email: "d.ortiz@proton.me", country: "ES", accountAgeDays: 860, city: "Valencia", device: "Linux / Firefox" },
  { name: "Grace Okafor", email: "grace.okafor@gmail.com", country: "CA", accountAgeDays: 1500, city: "Toronto", device: "iPad / Safari" },
];

const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
let seq = 0;
const nextId = () => `TX-${String(1001 + seq++)}`;
const ppId = (p: string) => p + Math.floor(rand() * 1e16).toString(36).toUpperCase().padStart(12, "0").slice(0, 12);

function makeTx(
  buyer: Buyer,
  items: LineItem[],
  at: number,
  extra: Partial<Pick<Transaction, "ipCountry" | "device" | "shipping" | "fingerprint">> & { city?: string } = {},
): Transaction {
  const amount = items.reduce((s, i) => s + i.unitAmount * i.quantity, 0);
  const device = extra.device ?? "Unknown";
  const ipCountry = extra.ipCountry ?? buyer.country;
  return {
    id: nextId(),
    orderId: ppId("5O"),
    captureId: ppId("3C"),
    createdAt: minutesAgo(at),
    amount,
    currency: "USD",
    items,
    buyer,
    shipping: extra.shipping ?? { country: buyer.country, city: extra.city ?? "", method: amount > 300 ? "tracked-signature" : "tracked", trackingNumber: ppId("1Z"), delivered: at > 60 * 24 * 3 },
    ipCountry,
    device,
    fingerprint: extra.fingerprint ?? fingerprintFor(buyer.email, device, ipCountry, extra.city ?? extra.shipping?.city ?? ""),
    status: "COMPLETED",
    refundedAmount: 0,
    source: "seed",
  };
}

const h = (s: string, n = 6) => createHash("sha1").update(s).digest("hex").slice(0, n);

/** Stable per-person identity signals, so honest buyers never collide with each other. */
export function fingerprintFor(email: string, device: string, ipCountry: string, city: string) {
  const ipHash = parseInt(h(email + ipCountry, 4), 16);
  return {
    ip: `${(ipHash % 200) + 20}.${(ipHash >> 3) % 250}.${(ipHash >> 5) % 250}.${(ipHash % 97) + 2}`,
    deviceId: `dev-${h(email + device)}`,
    address: `${(parseInt(h(email, 3), 16) % 900) + 10} ${h(email + "st", 4).toUpperCase()} St, ${city || "?"}`,
  };
}

/** The shared identity behind the fraud ring: one phone farm, one drop address. */
export const RING = {
  deviceId: "dev-7f3a91",
  address: "41 Larkin St Apt 3, San Francisco",
  ip: (n: number) => `185.220.101.${30 + n}`,
};

const line = (sku: string, quantity = 1): LineItem => {
  const p = catalog.find((c) => c.sku === sku)!;
  return { name: p.name, quantity, unitAmount: p.price };
};

export function seedDemoData() {
  const txs: Transaction[] = [];

  // ~3 weeks of normal, repeat-customer traffic.
  for (let i = 0; i < 34; i++) {
    const b = pick(regulars);
    const { city, device, ...buyer } = b;
    const items = [line(pick(catalog).sku, rand() > 0.85 ? 2 : 1)];
    if (rand() > 0.7) items.push(line(pick(["NA-CABLE", "NA-STAND"])));
    txs.push(makeTx(buyer, items, 60 * 24 * 21 - i * 60 * 14 - Math.floor(rand() * 300), { device, city }));
  }

  // Story 1: card-testing / reseller burst from a brand-new account.
  const burner: Buyer = { name: "J. Smith", email: "deals4u.8812@tempmail.dev", country: "US", accountAgeDays: 1 };
  const burnerShip = { country: "NG", city: "Lagos", method: "express", trackingNumber: ppId("1Z"), delivered: false };
  const burnerFp = { ip: RING.ip(9), deviceId: RING.deviceId, address: "12 Adeola Odeku St, Lagos" };
  txs.push(makeTx(burner, [line("NA-PEBBLE")], 52, { ipCountry: "RO", device: "Linux / Headless Chrome", shipping: burnerShip, fingerprint: burnerFp }));
  txs.push(makeTx(burner, [line("NA-ORBIT", 2)], 41, { ipCountry: "RO", device: "Linux / Headless Chrome", shipping: burnerShip, fingerprint: burnerFp }));
  txs.push(makeTx(burner, [line("NA-MONO", 4)], 33, { ipCountry: "RO", device: "Linux / Headless Chrome", shipping: burnerShip, fingerprint: burnerFp }));

  // Story 3: a quiet fraud ring. Each account places one modest, plausible order,
  // but they share a device fingerprint, a drop address and an exit-node IP range.
  const ring: [Buyer, string, number][] = [
    [{ name: "Emily Rhodes", email: "emily.rhodes.92@gmail.com", country: "US", accountAgeDays: 19 }, "NA-DAC", 60 * 24 * 6],
    [{ name: "Marcus Webb", email: "mwebb.audio@outlook.com", country: "US", accountAgeDays: 14 }, "NA-ORBIT", 60 * 24 * 4 + 200],
    [{ name: "Chloe Park", email: "chloepark.music@yahoo.com", country: "US", accountAgeDays: 11 }, "NA-DAC", 60 * 24 * 2 + 90],
    [{ name: "Ryan Cole", email: "ryan.cole.sf@gmail.com", country: "US", accountAgeDays: 8 }, "NA-ORBIT", 60 * 26],
  ];
  ring.forEach(([buyer, sku, at], n) =>
    txs.push(
      makeTx(buyer, [line(sku)], at, {
        device: "iPhone / Safari",
        shipping: { country: "US", city: "San Francisco", method: "tracked", trackingNumber: ppId("1Z"), delivered: at > 60 * 24 * 3 },
        fingerprint: { ip: RING.ip(n), deviceId: RING.deviceId, address: n === 3 ? "41 Larkin Street #3, San Francisco" : RING.address },
      }),
    ),
  );

  // Story 2: a loyal customer's account suddenly used from a new device and country.
  const hannah = regulars.find((r) => r.name === "Hannah Kim")!;
  const { city: _c, device: _d, ...hannahBuyer } = hannah;
  txs.push(
    makeTx(hannahBuyer, [line("NA-MONO", 2), line("NA-DAC")], 18, {
      ipCountry: "VN",
      device: "Android / Opera",
      shipping: { country: "US", city: "Miami (freight forwarder)", method: "express", trackingNumber: ppId("1Z"), delivered: false },
    }),
  );

  // A couple of fresh, ordinary orders so the live feed looks alive.
  const maya = regulars[0];
  txs.push(makeTx({ ...maya, accountAgeDays: maya.accountAgeDays }, [line("NA-STAND")], 9, { device: maya.device, city: maya.city }));

  txs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const tx of txs) store.transactions.set(tx.id, tx);

  // Score the historical backlog with the heuristic so the grid isn't empty;
  // the newest orders are left for the AI risk agent to analyse live.
  const unscored = new Set(txs.slice(-6).map((t) => t.id));
  for (const tx of txs) {
    if (unscored.has(tx.id)) continue;
    const signals = computeSignals(tx);
    const score = heuristicScore(signals);
    tx.risk = {
      score,
      level: levelFor(score),
      action: "allow",
      reasons: signals.map((s) => s.detail),
      summary: "Scored at import by the rules engine.",
      decidedBy: "heuristic",
      at: tx.createdAt,
    };
  }

  // Each dispute is on the buyer's largest order, which is what tends to get disputed.
  const byBuyer = (email: string) => txs.filter((t) => t.buyer.email === email).sort((a, b) => b.amount - a.amount)[0];

  const disputes: Dispute[] = [
    {
      id: "PP-D-27403",
      transactionId: byBuyer("tbecker@web.de").id,
      createdAt: minutesAgo(60 * 26),
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      amount: byBuyer("tbecker@web.de").amount,
      currency: "USD",
      status: "WAITING_FOR_SELLER_RESPONSE",
      buyerMessage: "I never got my package. Tracking says delivered but nothing was at my door. I want a full refund.",
      source: "seed",
    },
    {
      id: "PP-D-27419",
      transactionId: byBuyer("priya.nair@yahoo.com").id,
      createdAt: minutesAgo(60 * 11),
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      amount: byBuyer("priya.nair@yahoo.com").amount,
      currency: "USD",
      status: "WAITING_FOR_SELLER_RESPONSE",
      buyerMessage:
        "Left earcup crackles and cuts out at any volume above 50%. Photos and a video attached. I emailed support twice and got no reply.",
      source: "seed",
    },
    {
      id: "PP-D-27431",
      transactionId: byBuyer("lucas.silva@gmail.com").id,
      createdAt: minutesAgo(60 * 3),
      reason: "UNAUTHORISED",
      amount: byBuyer("lucas.silva@gmail.com").amount,
      currency: "USD",
      status: "OPEN",
      buyerMessage: "I don't recognise this purchase.",
      source: "seed",
    },
  ];
  // Make story details concrete for the dispute agent.
  const tom = byBuyer("tbecker@web.de");
  tom.shipping = { ...tom.shipping, delivered: true, method: "tracked-signature" };
  // Priya's complaint is about headphones from the faulty Orbit batch.
  const priya = byBuyer("priya.nair@yahoo.com");
  if (!priya.items.some((i) => i.name.startsWith("Orbit"))) {
    priya.items = [line("NA-ORBIT")];
    priya.amount = 249;
  }
  disputes[1].amount = priya.amount;
  for (const d of disputes) store.disputes.set(d.id, d);

  store.log({ agent: "system", kind: "info", message: `Loaded ${txs.length} transactions and ${disputes.length} open disputes for Nimbus Audio.` });
}

/** Courier and support facts the dispute agent can "look up". */
export const fulfillmentRecords: Record<string, { courierEvents: string[]; supportTickets: string[]; batchNote?: string }> = {
  "tbecker@web.de": {
    courierEvents: [
      "Label created, Portland OR",
      "Departed US international hub",
      "Arrived Hamburg DE",
      "Out for delivery",
      "Delivered — signed by 'T. BECKER' — GPS matches shipping address — photo on file",
    ],
    supportTickets: [],
  },
  "priya.nair@yahoo.com": {
    courierEvents: ["Delivered to front desk, Leeds GB"],
    supportTickets: [
      "Ticket #4471 (6 days ago): 'Left earcup crackling' — unanswered",
      "Ticket #4502 (3 days ago): 'Still waiting, please help' — unanswered",
    ],
    batchNote: "QA flagged Orbit batch ORB-2209 for a loose left-driver connector; 14 units shipped before the hold.",
  },
  "lucas.silva@gmail.com": {
    courierEvents: ["Delivered, Curitiba BR — left with doorman"],
    supportTickets: ["Ticket #3920 (2 weeks ago): buyer asked about the delivery date for this exact order"],
  },
};
