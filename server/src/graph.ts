import { store, type Transaction } from "./store.js";

export type NodeKind = "account" | "device" | "ip" | "address";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  ringId?: string;
  // account-only
  orders?: number;
  amount?: number;
  accountAgeDays?: number;
  maxRisk?: number;
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface Ring {
  id: string;
  accounts: string[];
  orders: string[];
  totalAmount: number;
  avgAccountAgeDays: number;
  sharedSignals: { kind: NodeKind; value: string; accounts: number }[];
  score: number;
}

/** Collapses formatting differences so "41 Larkin Street #3" and "41 Larkin St Apt 3" match. */
export function normaliseAddress(a: string) {
  return a
    .toLowerCase()
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\b(apartment|apt|unit|suite|#)\s*/g, "#")
    .replace(/#\s*/g, "#")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** IPs in the same /24 usually mean the same proxy pool or exit node. */
const subnet = (ip: string) => ip.split(".").slice(0, 3).join(".") + ".0/24";

function attributes(t: Transaction): { kind: NodeKind; key: string; label: string }[] {
  return [
    { kind: "device", key: `device:${t.fingerprint.deviceId}`, label: t.fingerprint.deviceId },
    { kind: "ip", key: `ip:${subnet(t.fingerprint.ip)}`, label: subnet(t.fingerprint.ip) },
    { kind: "address", key: `address:${normaliseAddress(t.fingerprint.address)}`, label: t.fingerprint.address },
  ];
}

/**
 * Builds the identity graph (accounts linked through shared devices, IP ranges
 * and shipping addresses) and finds connected groups of accounts — likely rings.
 */
export function buildGraph() {
  const txs = [...store.transactions.values()];
  const accounts = new Map<string, Transaction[]>();
  for (const t of txs) {
    const key = t.buyer.email.toLowerCase();
    accounts.set(key, [...(accounts.get(key) ?? []), t]);
  }

  const attrAccounts = new Map<string, { kind: NodeKind; label: string; accounts: Set<string> }>();
  for (const [email, list] of accounts)
    for (const t of list)
      for (const a of attributes(t)) {
        const entry = attrAccounts.get(a.key) ?? { kind: a.kind, label: a.label, accounts: new Set() };
        entry.accounts.add(email);
        attrAccounts.set(a.key, entry);
      }

  // Union-find over accounts that share any attribute.
  const parent = new Map<string, string>([...accounts.keys()].map((k) => [k, k]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  for (const { accounts: set } of attrAccounts.values()) {
    const [first, ...rest] = [...set];
    for (const other of rest) parent.set(find(other), find(first));
  }

  const groups = new Map<string, string[]>();
  for (const email of accounts.keys()) groups.set(find(email), [...(groups.get(find(email)) ?? []), email]);

  const rings: Ring[] = [];
  const ringOf = new Map<string, string>();
  let n = 1;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const id = `RING-${n++}`;
    const orders = members.flatMap((m) => accounts.get(m)!);
    const shared = [...attrAccounts.values()]
      .filter((a) => a.accounts.size >= 2 && members.includes([...a.accounts][0]))
      .map((a) => ({ kind: a.kind, value: a.label, accounts: a.accounts.size }));
    const avgAge = members.reduce((s, m) => s + accounts.get(m)![0].buyer.accountAgeDays, 0) / members.length;
    const score = Math.min(99, Math.round(20 + members.length * 12 + shared.length * 6 + (avgAge < 30 ? 20 : 0)));
    rings.push({
      id,
      accounts: members,
      orders: orders.map((o) => o.id),
      totalAmount: orders.reduce((s, o) => s + o.amount, 0),
      avgAccountAgeDays: Math.round(avgAge),
      sharedSignals: shared,
      score,
    });
    for (const m of members) ringOf.set(m, id);
  }

  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  for (const [email, list] of accounts) {
    nodes.push({
      id: `account:${email}`,
      kind: "account",
      label: list[0].buyer.name,
      ringId: ringOf.get(email),
      orders: list.length,
      amount: list.reduce((s, t) => s + t.amount, 0),
      accountAgeDays: list[0].buyer.accountAgeDays,
      maxRisk: Math.max(0, ...list.map((t) => t.risk?.score ?? 0)),
    });
  }
  for (const [key, a] of attrAccounts) {
    const ringId = ringOf.get([...a.accounts][0]);
    nodes.push({ id: key, kind: a.kind, label: a.label, ringId: a.accounts.size >= 2 ? ringId : undefined });
    for (const email of a.accounts) links.push({ source: `account:${email}`, target: key });
  }

  return { nodes, links, rings: rings.sort((a, b) => b.score - a.score) };
}

/** Other accounts that share a device, IP range or address with this buyer. */
export function linkedAccounts(email: string) {
  const { rings } = buildGraph();
  const ring = rings.find((r) => r.accounts.includes(email.toLowerCase()));
  return ring ? { ring, others: ring.accounts.filter((a) => a !== email.toLowerCase()) } : null;
}
