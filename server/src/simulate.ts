import { productBySku } from "./catalog.js";
import { config } from "./config.js";
import { simulator } from "./paypal/index.js";
import { newId, store, type Buyer, type LineItem, type Transaction } from "./store.js";

export type Scenario = "normal" | "card-testing" | "account-takeover" | "reseller";

const line = (sku: string, quantity = 1): LineItem => {
  const p = productBySku(sku)!;
  return { name: p.name, quantity, unitAmount: p.price };
};

const scenarios: Record<Scenario, () => { buyer: Buyer; items: LineItem[]; ip: string; device: string; ship: Transaction["shipping"] }> = {
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
  const s = make();
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
    status: "COMPLETED",
    refundedAmount: 0,
    source: "simulator",
  };
  store.upsertTransaction(tx);
  store.log({ agent: "paypal", kind: "webhook", message: `PAYMENT.CAPTURE.COMPLETED ${tx.id} · $${amount.toFixed(2)} from ${tx.buyer.email} (simulated ${scenario})` });
  return tx;
}
