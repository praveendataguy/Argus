import { linkedAccounts } from "./graph.js";
import { activeRules, matches } from "./rules.js";
import { store, type RiskLevel, type Transaction } from "./store.js";

export interface RiskSignal {
  id: string;
  label: string;
  weight: number;
  detail: string;
}

const DISPOSABLE_DOMAINS = ["mailinator.com", "tempmail.dev", "guerrillamail.com", "10minutemail.net", "trashmail.io"];

/**
 * Deterministic fraud signals. The AI risk agent reasons over these (plus raw
 * history) rather than guessing from scratch, and the heuristic fallback uses
 * them directly when no model is configured.
 */
export function computeSignals(tx: Transaction, pool: Transaction[] = [...store.transactions.values()]): RiskSignal[] {
  const signals: RiskSignal[] = [];
  const all = pool;
  const history = pool.filter((t) => t.id !== tx.id && t.buyer.email.toLowerCase() === tx.buyer.email.toLowerCase());
  const created = Date.parse(tx.createdAt);

  const lastHour = history.filter((t) => Math.abs(created - Date.parse(t.createdAt)) <= 3_600_000);
  if (lastHour.length >= 2)
    signals.push({ id: "velocity", label: "Order velocity", weight: 10 + lastHour.length * 8, detail: `${lastHour.length + 1} orders from this buyer within one hour` });

  if (tx.buyer.accountAgeDays <= 3)
    signals.push({ id: "new_account", label: "Brand-new PayPal account", weight: 18, detail: `Buyer account is ${tx.buyer.accountAgeDays} day(s) old` });
  else if (tx.buyer.accountAgeDays <= 30)
    signals.push({ id: "young_account", label: "Young account", weight: 7, detail: `Buyer account is ${tx.buyer.accountAgeDays} days old` });

  if (tx.ipCountry !== tx.buyer.country)
    signals.push({ id: "ip_mismatch", label: "IP / account country mismatch", weight: 14, detail: `Account in ${tx.buyer.country}, checkout IP in ${tx.ipCountry}` });

  if (tx.shipping.country !== tx.buyer.country)
    signals.push({ id: "ship_mismatch", label: "Ships outside account country", weight: 10, detail: `Account in ${tx.buyer.country}, shipping to ${tx.shipping.country}` });

  const domain = tx.buyer.email.split("@")[1]?.toLowerCase() ?? "";
  if (DISPOSABLE_DOMAINS.includes(domain))
    signals.push({ id: "disposable_email", label: "Disposable email domain", weight: 16, detail: domain });

  const amounts = all.map((t) => t.amount);
  const mean = amounts.reduce((a, b) => a + b, 0) / Math.max(amounts.length, 1);
  const sd = Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(amounts.length, 1)) || 1;
  const z = (tx.amount - mean) / sd;
  if (z > 2) signals.push({ id: "amount_outlier", label: "Unusually large order", weight: Math.min(20, Math.round(z * 6)), detail: `$${tx.amount.toFixed(2)} is ${z.toFixed(1)}σ above the shop average of $${mean.toFixed(2)}` });

  const qty = tx.items.reduce((s, i) => s + i.quantity, 0);
  if (qty >= 4) signals.push({ id: "bulk_qty", label: "Bulk quantity", weight: 8, detail: `${qty} units in one order (resale pattern)` });

  if (tx.shipping.method === "express" && tx.amount > 300)
    signals.push({ id: "rush_high_value", label: "Rush shipping on high-value order", weight: 9, detail: "Express shipping requested on a $300+ order" });

  const established = history.filter((t) => Date.parse(t.createdAt) < created - 86_400_000);
  if (established.length >= 2) {
    const usualDevices = new Set(established.map((t) => t.device));
    const usualIp = new Set(established.map((t) => t.ipCountry));
    if (!usualDevices.has(tx.device) && !usualIp.has(tx.ipCountry))
      signals.push({ id: "ato", label: "Possible account takeover", weight: 22, detail: `New device (${tx.device}) and new IP country (${tx.ipCountry}) for a buyer with ${established.length} prior orders` });
    else signals.push({ id: "loyal", label: "Established customer", weight: -12, detail: `${established.length} prior orders with consistent device and location` });
  }

  const priorDisputes = [...store.disputes.values()].filter((d) => history.some((h) => h.id === d.transactionId));
  if (priorDisputes.length) signals.push({ id: "prior_disputes", label: "Prior disputes", weight: 12 * priorDisputes.length, detail: `${priorDisputes.length} earlier dispute(s)` });

  const linked = linkedAccounts(tx.buyer.email, pool);
  if (linked)
    signals.push({
      id: "linked_accounts",
      label: "Linked to other accounts",
      weight: 10 + linked.others.length * 6,
      detail: `Shares ${linked.ring.sharedSignals.map((s) => s.kind).join(", ")} with ${linked.others.length} other account(s) (${linked.ring.id}, ${linked.ring.orders.length} orders)`,
    });

  for (const rule of activeRules()) {
    if (matches(rule, tx)) {
      signals.push({ id: `rule:${rule.id}`, label: `Learned rule: ${rule.name}`, weight: rule.weight, detail: `${rule.name} (learned in war game round ${rule.createdRound})` });
    }
  }

  return signals;
}

export function levelFor(score: number): RiskLevel {
  if (score >= 85) return "critical";
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}

export function heuristicScore(signals: RiskSignal[]) {
  const raw = signals.reduce((s, x) => s + x.weight, 4);
  return Math.max(1, Math.min(99, Math.round(raw)));
}
