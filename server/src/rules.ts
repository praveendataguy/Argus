import type { Transaction } from "./store.js";

/** Features a learned rule can test. Kept small and explicit so rules stay auditable. */
export const FEATURES = {
  amount: "Order total in USD",
  quantity: "Total units in the order",
  accountAgeDays: "Age of the buyer's PayPal account in days",
  emailDomain: "Domain of the buyer's email",
  emailDigits: "Count of digits in the email local part",
  buyerCountry: "Country of the buyer's PayPal account",
  ipCountry: "Country of the checkout IP",
  shipCountry: "Shipping country",
  shipCity: "Shipping city / address line",
  shipMethod: "Shipping method (tracked, express, tracked-signature)",
  device: "Browser / device string",
  ipPrefix: "First two octets of the checkout IP, e.g. 185.220",
  geoMismatch: "Number of distinct countries among account, IP and shipping (1-3)",
  topSku: "Most expensive product name in the order",
} as const;

export type Feature = keyof typeof FEATURES;
export type Op = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "contains" | "in";

export interface Condition {
  feature: Feature;
  op: Op;
  value: string | number | string[];
}

export interface LearnedRule {
  id: string;
  name: string;
  conditions: Condition[];
  weight: number;
  createdRound: number;
  author: "ai" | "rules-engine";
  rationale: string;
  enabled: boolean;
  hits: number;
  backtest: { benignHits: number; benignTotal: number; attackHits: number; attackTotal: number };
}

export const learnedRules: LearnedRule[] = [];
export const activeRules = () => learnedRules.filter((r) => r.enabled);

export function features(t: Transaction): Record<Feature, string | number> {
  const [local, domain = ""] = t.buyer.email.toLowerCase().split("@");
  const top = [...t.items].sort((a, b) => b.unitAmount - a.unitAmount)[0];
  return {
    amount: t.amount,
    quantity: t.items.reduce((s, i) => s + i.quantity, 0),
    accountAgeDays: t.buyer.accountAgeDays,
    emailDomain: domain,
    emailDigits: (local.match(/\d/g) ?? []).length,
    buyerCountry: t.buyer.country,
    ipCountry: t.ipCountry,
    shipCountry: t.shipping.country,
    shipCity: `${t.shipping.city} ${t.fingerprint.address}`.toLowerCase(),
    shipMethod: t.shipping.method,
    device: t.device.toLowerCase(),
    ipPrefix: t.fingerprint.ip.split(".").slice(0, 2).join("."),
    geoMismatch: new Set([t.buyer.country, t.ipCountry, t.shipping.country]).size,
    topSku: top?.name ?? "",
  };
}

export function matches(rule: Pick<LearnedRule, "conditions">, t: Transaction) {
  const f = features(t);
  return rule.conditions.every(({ feature, op, value }) => {
    const v = f[feature];
    const lower = (x: unknown) => String(x).toLowerCase();
    switch (op) {
      case "gt": return Number(v) > Number(value);
      case "gte": return Number(v) >= Number(value);
      case "lt": return Number(v) < Number(value);
      case "lte": return Number(v) <= Number(value);
      case "eq": return lower(v) === lower(value);
      case "neq": return lower(v) !== lower(value);
      case "contains": return lower(v).includes(lower(value));
      case "in": return (Array.isArray(value) ? value : String(value).split(",")).map(lower).includes(lower(v));
    }
  });
}

export const describeRule = (r: Pick<LearnedRule, "conditions">) =>
  r.conditions.map((c) => `${c.feature} ${c.op} ${Array.isArray(c.value) ? c.value.join("|") : c.value}`).join(" AND ");
