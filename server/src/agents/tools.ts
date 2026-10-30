import { z } from "zod";
import { requestAction } from "../actions.js";
import { catalog, merchant } from "../catalog.js";
import { config } from "../config.js";
import { paypal } from "../paypal/index.js";
import { computeSignals, levelFor } from "../risk.js";
import { fulfillmentRecords } from "../seed.js";
import { store, type Transaction } from "../store.js";
import { defineTool } from "./llm.js";

const txView = (t: Transaction) => ({
  id: t.id,
  createdAt: t.createdAt,
  amount: t.amount,
  currency: t.currency,
  status: t.status,
  refunded: t.refundedAmount,
  items: t.items.map((i) => `${i.quantity}× ${i.name} @ $${i.unitAmount}`),
  buyer: t.buyer,
  shipping: t.shipping,
  ipCountry: t.ipCountry,
  device: t.device,
  paypal: { orderId: t.orderId, captureId: t.captureId, source: t.source },
  risk: t.risk ? { score: t.risk.score, level: t.risk.level, action: t.risk.action } : null,
});

export const getTransaction = defineTool({
  name: "get_transaction",
  description: "Fetch one transaction (PayPal order + capture) with buyer, items, shipping and any existing risk assessment.",
  inputSchema: z.object({ transactionId: z.string() }),
  run: async ({ transactionId }) => {
    const t = store.transactions.get(transactionId);
    if (!t) throw new Error(`No transaction ${transactionId}`);
    return txView(t);
  },
});

export const searchTransactions = defineTool({
  name: "search_transactions",
  description: "Search the merchant's PayPal transactions. All filters are optional; results are newest first.",
  inputSchema: z.object({
    buyerEmail: z.string().optional(),
    minRiskScore: z.number().optional(),
    status: z.enum(["COMPLETED", "HELD", "REFUNDED", "PARTIALLY_REFUNDED"]).optional(),
    sinceHours: z.number().optional().describe("Only transactions in the last N hours"),
    limit: z.number().optional(),
  }),
  run: async (f) => {
    let rows = [...store.transactions.values()];
    if (f.buyerEmail) rows = rows.filter((t) => t.buyer.email.toLowerCase().includes(f.buyerEmail!.toLowerCase()));
    if (f.minRiskScore !== undefined) rows = rows.filter((t) => (t.risk?.score ?? 0) >= f.minRiskScore!);
    if (f.status) rows = rows.filter((t) => t.status === f.status);
    if (f.sinceHours) rows = rows.filter((t) => Date.parse(t.createdAt) >= Date.now() - f.sinceHours! * 3_600_000);
    rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return rows.slice(0, f.limit ?? 15).map(txView);
  },
});

export const getBuyerProfile = defineTool({
  name: "get_buyer_profile",
  description: "Summarise a buyer's full history with this merchant: orders, devices, countries, refunds and disputes.",
  inputSchema: z.object({ email: z.string() }),
  run: async ({ email }) => {
    const history = store.buyerHistory(email);
    const disputes = [...store.disputes.values()].filter((d) => history.some((h) => h.id === d.transactionId));
    return {
      email,
      orders: history.length,
      lifetimeValue: history.reduce((s, t) => s + t.amount, 0),
      devices: [...new Set(history.map((t) => t.device))],
      ipCountries: [...new Set(history.map((t) => t.ipCountry))],
      shipTo: [...new Set(history.map((t) => `${t.shipping.city || "?"}, ${t.shipping.country}`))],
      refunds: history.filter((t) => t.refundedAmount > 0).length,
      disputes: disputes.map((d) => ({ id: d.id, reason: d.reason, status: d.status, outcome: d.outcome })),
      recent: history.slice(-5).map((t) => ({ id: t.id, at: t.createdAt, amount: t.amount, device: t.device, ip: t.ipCountry })),
    };
  },
});

export const computeRiskSignals = defineTool({
  name: "compute_risk_signals",
  description:
    "Run Argus's deterministic fraud-signal engine on a transaction (velocity, account age, geo mismatch, amount outliers, account-takeover patterns). Positive weights add risk, negative weights reduce it.",
  inputSchema: z.object({ transactionId: z.string() }),
  run: async ({ transactionId }) => {
    const t = store.transactions.get(transactionId);
    if (!t) throw new Error(`No transaction ${transactionId}`);
    return computeSignals(t);
  },
});

export const recordRiskAssessment = defineTool({
  name: "record_risk_assessment",
  description:
    "Record your final risk verdict for a transaction. action: allow = ship it; review = ship but flag; hold = stop fulfilment and ask a human; refund = cancel and refund the buyer (goes through the approval policy).",
  inputSchema: z.object({
    transactionId: z.string(),
    score: z.number().min(0).max(100),
    action: z.enum(["allow", "review", "hold", "refund"]),
    reasons: z.array(z.string()).describe("Short, specific evidence bullets"),
    summary: z.string().describe("One or two sentences a busy merchant can act on"),
  }),
  run: async (a, ctx) => {
    const t = store.transactions.get(a.transactionId);
    if (!t) throw new Error(`No transaction ${a.transactionId}`);
    t.risk = { score: Math.round(a.score), level: levelFor(a.score), action: a.action, reasons: a.reasons, summary: a.summary, decidedBy: "ai", at: new Date().toISOString() };
    if (a.action === "hold" || a.action === "refund") t.status = "HELD";
    store.upsertTransaction(t);
    if (a.action === "hold") {
      await requestAction({
        kind: "RELEASE_HOLD",
        requestedBy: ctx.agent,
        title: `Release held order ${t.id} ($${t.amount.toFixed(2)})`,
        rationale: a.summary,
        amount: 0,
        currency: t.currency,
        payload: { transactionId: t.id },
      });
    }
    if (a.action === "refund") {
      await requestAction({
        kind: "REFUND",
        requestedBy: ctx.agent,
        title: `Cancel and refund ${t.id} ($${(t.amount - t.refundedAmount).toFixed(2)}) to ${t.buyer.email}`,
        rationale: a.summary,
        amount: t.amount - t.refundedAmount,
        currency: t.currency,
        payload: { transactionId: t.id, note: "Your order was cancelled and fully refunded by Nimbus Audio." },
      });
    }
    return `Recorded ${levelFor(a.score)} risk (${a.score}) with action "${a.action}".`;
  },
});

export const getDisputeCase = defineTool({
  name: "get_dispute_case",
  description: "Load a PayPal dispute with the disputed transaction, courier tracking events, support tickets, internal QA notes and the merchant's policies.",
  inputSchema: z.object({ disputeId: z.string() }),
  run: async ({ disputeId }) => {
    const d = store.disputes.get(disputeId);
    if (!d) throw new Error(`No dispute ${disputeId}`);
    const t = store.transactions.get(d.transactionId);
    return {
      dispute: d,
      transaction: t ? txView(t) : null,
      fulfillment: t ? (fulfillmentRecords[t.buyer.email] ?? { courierEvents: ["No courier data on file"], supportTickets: [] }) : null,
      buyerHistory: t ? store.buyerHistory(t.buyer.email).length : 0,
      merchantPolicies: merchant,
    };
  },
});

export const fileDisputeCase = defineTool({
  name: "file_dispute_case",
  description:
    "File your recommendation for a dispute. 'contest' queues an evidence response for PayPal; 'accept' queues accepting the claim and refunding. A human reviews customer-facing responses.",
  inputSchema: z.object({
    disputeId: z.string(),
    recommendation: z.enum(["contest", "accept"]),
    confidence: z.number().min(0).max(1),
    winProbability: z.number().min(0).max(1).describe("Estimated probability PayPal rules for the seller if contested"),
    evidence: z.array(z.string()).describe("Evidence bullets, strongest first"),
    responseText: z.string().describe("The exact message to submit to PayPal (contest) or send the buyer (accept). Professional, factual, under 1500 characters."),
  }),
  run: async (c, ctx) => {
    const d = store.disputes.get(c.disputeId);
    if (!d) throw new Error(`No dispute ${c.disputeId}`);
    d.agentCase = { recommendation: c.recommendation, confidence: c.confidence, winProbability: c.winProbability, evidence: c.evidence, responseText: c.responseText, at: new Date().toISOString() };
    store.upsertDispute(d);
    await requestAction({
      kind: c.recommendation === "contest" ? "DISPUTE_RESPONSE" : "DISPUTE_ACCEPT",
      requestedBy: ctx.agent,
      title: `${c.recommendation === "contest" ? "Contest" : "Accept and refund"} dispute ${d.id} ($${d.amount.toFixed(2)})`,
      rationale: `${Math.round(c.winProbability * 100)}% estimated win chance. ${c.evidence[0] ?? ""}`,
      amount: c.recommendation === "accept" ? d.amount : 0,
      currency: d.currency,
      payload: { disputeId: d.id, responseText: c.responseText, note: c.responseText },
    });
    return `Filed: ${c.recommendation} (win probability ${Math.round(c.winProbability * 100)}%).`;
  },
});

const lineItemSchema = z.object({ name: z.string(), quantity: z.number().int().min(1), unitAmount: z.number().positive() });

export const createInvoice = defineTool({
  name: "create_paypal_invoice",
  description: "Create a draft PayPal invoice and queue it for sending. Use catalog prices for catalog items.",
  inputSchema: z.object({
    recipientName: z.string(),
    recipientEmail: z.string(),
    items: z.array(lineItemSchema).min(1),
    dueInDays: z.number().int().min(0).max(90),
    note: z.string().describe("Friendly note to the customer"),
  }),
  run: async (i, ctx) => {
    const { id, number } = await paypal.createInvoice({ ...i, currency: config.policy.currency });
    const total = i.items.reduce((s, x) => s + x.quantity * x.unitAmount, 0);
    store.upsertInvoice({ id, number, createdAt: new Date().toISOString(), ...i, total, currency: config.policy.currency, status: "DRAFT", source: "ai" });
    await requestAction({
      kind: "INVOICE_SEND",
      requestedBy: ctx.agent,
      title: `Send PayPal invoice #${number} to ${i.recipientEmail} ($${total.toFixed(2)})`,
      rationale: i.note,
      amount: total,
      currency: config.policy.currency,
      payload: { invoiceId: id },
    });
    return { invoiceId: id, number, total };
  },
});

export const requestRefund = defineTool({
  name: "request_refund",
  description: "Request a full or partial refund of a captured PayPal payment. Goes through the approval policy.",
  inputSchema: z.object({ transactionId: z.string(), amount: z.number().positive(), reason: z.string() }),
  run: async ({ transactionId, amount, reason }, ctx) => {
    const t = store.transactions.get(transactionId);
    if (!t) throw new Error(`No transaction ${transactionId}`);
    const max = t.amount - t.refundedAmount;
    if (amount > max) throw new Error(`Only $${max.toFixed(2)} is refundable`);
    const a = await requestAction({
      kind: "REFUND",
      requestedBy: ctx.agent,
      title: `Refund $${amount.toFixed(2)} on ${t.id} to ${t.buyer.email}`,
      rationale: reason,
      amount,
      currency: t.currency,
      payload: { transactionId, note: reason },
    });
    return `Refund ${a.status === "EXECUTED" ? "executed automatically" : "queued for approval"} (${a.id}).`;
  },
});

export const requestPayout = defineTool({
  name: "request_payout",
  description: "Send money to a person (supplier, affiliate, creator) with PayPal Payouts. Goes through the approval policy.",
  inputSchema: z.object({ receiverEmail: z.string(), amount: z.number().positive(), note: z.string() }),
  run: async ({ receiverEmail, amount, note }, ctx) => {
    const a = await requestAction({
      kind: "PAYOUT",
      requestedBy: ctx.agent,
      title: `Pay out $${amount.toFixed(2)} to ${receiverEmail}`,
      rationale: note,
      amount,
      currency: config.policy.currency,
      payload: { receiverEmail, note },
    });
    return `Payout ${a.status === "EXECUTED" ? "executed automatically" : "queued for approval"} (${a.id}).`;
  },
});

export const getBusinessSnapshot = defineTool({
  name: "get_business_snapshot",
  description: "Revenue, refunds, risk distribution, held orders, open disputes, pending approvals and the product catalog.",
  inputSchema: z.object({}),
  run: async () => {
    const txs = [...store.transactions.values()];
    const level = (l: string) => txs.filter((t) => t.risk?.level === l).length;
    return {
      merchant: merchant.name,
      gross: txs.reduce((s, t) => s + t.amount, 0),
      refunded: txs.reduce((s, t) => s + t.refundedAmount, 0),
      orders: txs.length,
      risk: { low: level("low"), medium: level("medium"), high: level("high"), critical: level("critical"), unscored: txs.filter((t) => !t.risk).length },
      held: txs.filter((t) => t.status === "HELD").map((t) => t.id),
      openDisputes: [...store.disputes.values()].filter((d) => d.status !== "RESOLVED").map((d) => ({ id: d.id, reason: d.reason, amount: d.amount })),
      pendingApprovals: [...store.approvals.values()].filter((a) => a.status === "PENDING").map((a) => a.title),
      autonomy: store.autonomy,
      autoApproveLimit: config.policy.autoApproveLimit,
      catalog,
    };
  },
});

