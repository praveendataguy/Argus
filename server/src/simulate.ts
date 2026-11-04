import { productBySku } from "./catalog.js";
import { config } from "./config.js";
import { simulator } from "./paypal/index.js";
import { computeSignals, heuristicScore, levelFor } from "./risk.js";
import { fingerprintFor, RING } from "./seed.js";
import { newId, store, type Buyer, type LineItem, type Transaction } from "./store.js";

export type Scenario = "normal" | "card-testing" | "account-takeover" | "reseller";

const line = (sku: string, quantity = 1): LineItem => {
  const p = productBySku(sku)!;
  return { name: p.name, quantity, unitAmount: p.price };
};

type Made = { buyer: Buyer; items: LineItem[]; ip: string; device: string; ship: Transaction["shipping"]; fingerprint?: Transaction["fingerprint"] };

const scenarios: Record<Scenario, () => Made> = {
  normal: () => ({
    buyer: { name: "Grace Okafor", email: "grace.okafor@gmail.com", country: "CA", accountAgeDays: 1500 },
    items: [line("NA-PEBBLE"), line("NA-CABLE")],
    ip: "CA",
    device: "iPad / Safari",
    ship: { country: "CA", city: "Toronto", method: "tracked" },
  }),
  "card-testing": () => ({
    buyer: { name: "Alex R", email: `quickbuy.${Math.floor(Math.random() * 9000 + 1000)}@mailinator.com`, country: "US", accountAgeDays: 0 },
    items: [line("NA-ORBIT", 3)],
    ip: "BR",
    device: "Linux / Headless Chrome",
    ship: { country: "US", city: "Doral (freight forwarder)", method: "express" },
    // Same phone farm as the seeded ring, so the network view lights up live.
    fingerprint: { ip: RING.ip(40 + Math.floor(Math.random() * 50)), deviceId: RING.deviceId, address: "8400 NW 25th St, Doral" },
  }),
  "account-takeover": () => ({
    buyer: { name: "Arjun Mehta", email: "arjun.mehta@outlook.com", country: "IN", accountAgeDays: 1310 },
    items: [line("NA-MONO", 2), line("NA-ORBIT")],
    ip: "RU",
    device: "Windows / Firefox ESR",
    ship: { country: "AE", city: "Dubai", method: "express" },
  }),
  reseller: () => ({
    buyer: { name: "K. Tran", email: "ktran.store@gmail.com", country: "US", accountAgeDays: 25 },
    items: [line("NA-DAC", 6)],
    ip: "US",
    device: "Mac / Chrome",
    ship: { country: "US", city: "Newark", method: "tracked" },
  }),
};

/**
 * Creates a realistic order through the PayPal simulator so a demo can show
 * fraud patterns that are hard to produce with a single sandbox buyer.
 */
export async function simulateOrder(scenario: Scenario): Promise<Transaction> {
  const make = scenarios[scenario];
  if (!make) throw new Error(`Unknown scenario ${scenario}`);
  return captureMade(make(), `simulated ${scenario}`);
}

async function captureMade(s: Made, label: string): Promise<Transaction> {
  const amount = s.items.reduce((sum, i) => sum + i.quantity * i.unitAmount, 0);
  const order = await simulator.createOrder({ amount, currency: config.policy.currency, items: s.items });
  const capture = await simulator.captureOrder(order.id);
  const tx: Transaction = {
    id: newId("TX"),
    orderId: capture.orderId,
    captureId: capture.captureId,
    createdAt: new Date().toISOString(),
    amount,
    currency: config.policy.currency,
    items: s.items,
    buyer: s.buyer,
    shipping: s.ship,
    ipCountry: s.ip,
    device: s.device,
    fingerprint: s.fingerprint ?? fingerprintFor(s.buyer.email, s.device, s.ip, s.ship.city),
    status: "COMPLETED",
    refundedAmount: 0,
    source: "simulator",
  };
  store.upsertTransaction(tx);
  store.log({ agent: "paypal", kind: "webhook", message: `PAYMENT.CAPTURE.COMPLETED ${tx.id} · $${amount.toFixed(2)} from ${tx.buyer.email} (${label})` });
  return tx;
}

/* ------------------------------ attack storm ------------------------------ */

type Geo = { country: string; city: string };
const HONEST: (Buyer & { city: string; device: string })[] = [
  { name: "Aiko Tanaka", email: "aiko.tanaka@gmail.com", country: "JP", accountAgeDays: 1900, city: "Osaka", device: "iPhone / Safari" },
  { name: "Liam Walsh", email: "liam.walsh@outlook.com", country: "AU", accountAgeDays: 1240, city: "Melbourne", device: "Mac / Chrome" },
  { name: "Sofia Rossi", email: "sofia.rossi@libero.it", country: "IT", accountAgeDays: 770, city: "Milan", device: "Android / Chrome" },
  { name: "Noah Jensen", email: "noah.j@gmail.com", country: "US", accountAgeDays: 2600, city: "Seattle", device: "Pixel / Chrome" },
  { name: "Emma de Vries", email: "emma.devries@ziggo.nl", country: "NL", accountAgeDays: 1500, city: "Utrecht", device: "Windows / Edge" },
  { name: "Carlos Mendoza", email: "c.mendoza@gmail.com", country: "MX", accountAgeDays: 980, city: "Guadalajara", device: "iPhone / Safari" },
  { name: "Ji-woo Park", email: "jiwoo.park@naver.com", country: "KR", accountAgeDays: 1320, city: "Busan", device: "Galaxy / Chrome" },
  { name: "Ama Mensah", email: "ama.mensah@gmail.com", country: "GH", accountAgeDays: 840, city: "Accra", device: "Android / Chrome" },
];
/** Attack origins and the drop points they ship to. */
const ATTACKS: { ip: string; ship: Geo; label: string; device: string }[] = [
  { ip: "RU", ship: { country: "AE", city: "Dubai (reshipper)" }, label: "account takeover", device: "Windows / Firefox ESR" },
  { ip: "NG", ship: { country: "US", city: "Doral (freight forwarder)" }, label: "stolen card", device: "Linux / Headless Chrome" },
  { ip: "VN", ship: { country: "US", city: "Miami (freight forwarder)" }, label: "card testing", device: "Linux / Headless Chrome" },
  { ip: "CN", ship: { country: "GB", city: "London (parcel locker)" }, label: "bot checkout", device: "Android / Emulator" },
  { ip: "RO", ship: { country: "NG", city: "Lagos" }, label: "burner account", device: "Linux / Headless Chrome" },
  { ip: "UA", ship: { country: "DE", city: "Frankfurt (drop)" }, label: "residential proxy", device: "Windows / Chrome" },
  { ip: "ID", ship: { country: "SG", city: "Singapore (reshipper)" }, label: "mule account", device: "Android / Chrome" },
];
const SKUS = ["NA-PEBBLE", "NA-ORBIT", "NA-MONO", "NA-DAC", "NA-CABLE"];

export let stormRunning = false;

/**
 * A burst of global traffic: honest buyers from around the world mixed with
 * attacks from fraud hubs, captured a few hundred milliseconds apart so the
 * threat globe lights up, then a risk sweep over everything new.
 */
export async function runStorm(size = 14, after?: (ids: string[]) => Promise<unknown>) {
  if (stormRunning) throw new Error("A storm is already running");
  stormRunning = true;
  store.log({ agent: "system", kind: "info", message: `🌪️ Attack storm: ${size} payments incoming from ${new Set([...HONEST.map((h) => h.country), ...ATTACKS.map((a) => a.ip)]).size} countries.` });
  const ids: string[] = [];
  try {
    for (let i = 0; i < size; i++) {
      const bad = i % 2 === 1 || Math.random() < 0.15;
      const sku = SKUS[Math.floor(Math.random() * SKUS.length)];
      let made: Made;
      let label = "storm order";
      if (bad) {
        const a = ATTACKS[Math.floor(Math.random() * ATTACKS.length)];
        const n = Math.floor(Math.random() * 9000 + 1000);
        label = `storm: ${a.label} from ${a.ip}`;
        made = {
          // The stolen account belongs to someone in one country, the order ships to another.
          buyer: { name: `Buyer ${n}`, email: `fastdeals.${n}@mailinator.com`, country: a.ship.country === "US" ? "GB" : "US", accountAgeDays: Math.floor(Math.random() * 4) },
          items: [line(sku, 1 + Math.floor(Math.random() * 4))],
          ip: a.ip,
          device: a.device,
          ship: { country: a.ship.country, city: a.ship.city, method: "express" },
        };
      } else {
        const h = HONEST[Math.floor(Math.random() * HONEST.length)];
        made = {
          buyer: { name: h.name, email: h.email, country: h.country, accountAgeDays: h.accountAgeDays },
          items: [line(sku)],
          ip: h.country,
          device: h.device,
          ship: { country: h.country, city: h.city, method: "tracked" },
        };
      }
      const tx = await captureMade(made, label);
      edgeScreen(tx);
      ids.push(tx.id);
      await new Promise((r) => setTimeout(r, 350 + Math.random() * 400));
    }
  } finally {
    stormRunning = false;
  }
  store.log({ agent: "system", kind: "info", message: `🌪️ Storm landed: ${ids.length} payments. Risk Watch is sweeping them now.` });
  await after?.(ids);
  return ids;
}

/**
 * Millisecond pre-screen with the deterministic signal engine, so a storm is
 * triaged the instant it lands. It only labels the order; Risk Watch's full
 * review follows and has the final word (and is what requests any action).
 */
function edgeScreen(tx: Transaction) {
  const signals = computeSignals(tx);
  const score = heuristicScore(signals);
  const action = score >= 85 ? "refund" : score >= config.policy.holdThreshold ? "hold" : score >= 30 ? "review" : "allow";
  tx.risk = {
    score,
    level: levelFor(score),
    action,
    reasons: signals.filter((x) => x.weight > 0).map((x) => x.detail),
    summary: `Edge pre-screen: ${signals.length} signal(s), score ${score}. Full agent review queued.`,
    decidedBy: "heuristic",
    at: new Date().toISOString(),
  };
  store.upsertTransaction(tx);
  if (score >= 60) store.log({ agent: "rules-engine", kind: "decision", message: `⚡ Edge pre-screen ${tx.id}: ${tx.ipCountry} → ${tx.shipping.country}, score ${score} → ${action}. Escalated to Risk Watch.` });
}
