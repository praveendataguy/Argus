import { requestAction } from "../actions.js";
import { catalog, merchant } from "../catalog.js";
import { config } from "../config.js";
import { computeSignals, heuristicScore, levelFor } from "../risk.js";
import { fulfillmentRecords } from "../seed.js";
import { store } from "../store.js";
import { client, runAgent, type AgentSpec } from "./llm.js";
import * as T from "./tools.js";

const today = () => new Date().toISOString().slice(0, 10);

export const riskWatch: AgentSpec = {
  name: "risk-watch",
  effort: "medium",
  system: `You are Risk Watch, the fraud analyst for ${merchant.name}, a small online shop that takes payments through PayPal.
You review captured PayPal payments before the order ships. Losing a good customer costs money too, so do not hold orders on weak evidence.

For each transaction: load it, run compute_risk_signals, look at the buyer's profile when history matters, then call record_risk_assessment exactly once.
Scoring guide: 0-29 low (allow), 30-59 medium (allow or review), 60-84 high (hold), 85-100 critical (refund to cancel a near-certain fraud before shipping goods).
Reasons must cite concrete facts (amounts, countries, counts, timings). Finish with one sentence for the merchant.`,
  tools: [T.getTransaction, T.computeRiskSignals, T.getBuyerProfile, T.searchTransactions, T.recordRiskAssessment],
};

export const disputeAgent: AgentSpec = {
  name: "dispute-agent",
  effort: "high",
  system: `You are the dispute specialist for ${merchant.name}. You handle PayPal disputes (chargebacks and claims).
Load the case with get_dispute_case, weigh the evidence honestly against PayPal's seller protection rules, then call file_dispute_case exactly once.
Contest only when the evidence would convince a PayPal adjudicator (for example signed proof of delivery, or proof the buyer engaged with this exact order). If the merchant is at fault, recommend accepting: a fast refund protects the seller's PayPal standing and the customer relationship.
Write responseText in a calm, factual tone with specific dates, tracking events and ticket numbers. Today is ${today()}.`,
  tools: [T.getDisputeCase, T.getBuyerProfile, T.searchTransactions, T.fileDisputeCase],
};

export const billingAgent: AgentSpec = {
  name: "billing-agent",
  effort: "low",
  system: `You are the billing assistant for ${merchant.name}. You turn plain-language requests (notes, emails, voice transcripts) into PayPal invoices.
Use catalog prices for catalog products: ${catalog.map((p) => `${p.name} $${p.price}`).join("; ")}.
Services or custom work use the price the request states. If a detail is missing, choose a sensible default (due in 14 days) and say so.
Call create_paypal_invoice once per customer, then confirm what you created in one short paragraph.`,
  tools: [T.createInvoice, T.searchTransactions],
};

export const copilot: AgentSpec = {
  name: "argus-copilot",
  effort: "medium",
  system: `You are Argus, the AI operator of ${merchant.name}'s PayPal account. The merchant talks to you in plain language.
You can look up transactions, buyers and disputes, issue refunds, send payouts and create invoices. All money movement goes through the approval policy (current autonomy: tools report it) — never claim money moved unless the tool result says it executed.
Answer briefly with specific numbers. Today is ${today()}.`,
  tools: [
    T.getBusinessSnapshot,
    T.searchTransactions,
    T.getTransaction,
    T.getBuyerProfile,
    T.computeRiskSignals,
    T.getDisputeCase,
    T.requestRefund,
    T.requestPayout,
    T.createInvoice,
  ],
};

export const aiOnline = () => client !== null;

// One analysis per transaction at a time, so a webhook and a button click don't race.
const inFlight = new Map<string, Promise<unknown>>();
function once<R>(key: string, fn: () => Promise<R>): Promise<R> {
  const existing = inFlight.get(key) as Promise<R> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

export function analyseTransaction(transactionId: string) {
  return once(`tx:${transactionId}`, async () => {
    if (aiOnline()) return runAgent(riskWatch, `Assess PayPal transaction ${transactionId} before it ships.`);
    return heuristicRisk(transactionId);
  });
}

export function analyseDispute(disputeId: string) {
  return once(`dispute:${disputeId}`, async () => {
    if (aiOnline()) return runAgent(disputeAgent, `Build the case for PayPal dispute ${disputeId} and recommend contest or accept.`);
    return heuristicDispute(disputeId);
  });
}

export async function draftInvoices(request: string) {
  if (!aiOnline()) throw new Error("Invoice drafting from free text needs an Anthropic API key (set ANTHROPIC_API_KEY).");
  return runAgent(billingAgent, request);
}

export async function askCopilot(question: string) {
  if (!aiOnline()) throw new Error("The copilot needs an Anthropic API key (set ANTHROPIC_API_KEY).");
  return runAgent(copilot, question);
}

/* ---------- Offline fallbacks: keep the app usable without an API key ---------- */

async function heuristicRisk(transactionId: string) {
  const tx = store.transactions.get(transactionId);
  if (!tx) throw new Error(`No transaction ${transactionId}`);
  const signals = computeSignals(tx);
  const score = heuristicScore(signals);
  const level = levelFor(score);
  const action = score >= 85 ? "refund" : score >= config.policy.holdThreshold ? "hold" : score >= 30 ? "review" : "allow";
  tx.risk = {
    score,
    level,
    action,
    reasons: signals.filter((s) => s.weight > 0).map((s) => s.detail),
    summary: `Rules engine (AI offline): ${signals.length} signal(s), score ${score}.`,
    decidedBy: "heuristic",
    at: new Date().toISOString(),
  };
  if (action === "hold" || action === "refund") tx.status = "HELD";
  store.upsertTransaction(tx);
  store.log({ agent: "rules-engine", kind: "decision", message: `${tx.id}: ${level} risk (${score}) → ${action}` });
  if (action === "hold")
    await requestAction({ kind: "RELEASE_HOLD", requestedBy: "rules-engine", title: `Release held order ${tx.id}`, rationale: tx.risk.summary, amount: 0, currency: tx.currency, payload: { transactionId: tx.id } });
  if (action === "refund")
    await requestAction({ kind: "REFUND", requestedBy: "rules-engine", title: `Cancel and refund ${tx.id} ($${tx.amount.toFixed(2)})`, rationale: tx.risk.summary, amount: tx.amount, currency: tx.currency, payload: { transactionId: tx.id } });
  return { runId: "heuristic", text: tx.risk.summary };
}

async function heuristicDispute(disputeId: string) {
  const d = store.disputes.get(disputeId);
  if (!d) throw new Error(`No dispute ${disputeId}`);
  const tx = store.transactions.get(d.transactionId);
  const f = tx ? fulfillmentRecords[tx.buyer.email] : undefined;
  const signed = f?.courierEvents.some((e) => /signed/i.test(e)) ?? false;
  const engaged = f?.supportTickets.some((t) => /this exact order|delivery date/i.test(t)) ?? false;
  const merchantFault = Boolean(f?.batchNote) || (f?.supportTickets.some((t) => /unanswered/i.test(t)) ?? false);
  const contest = !merchantFault && (signed || engaged);
  const evidence = [...(f?.courierEvents.slice(-1) ?? []), ...(f?.supportTickets ?? []), ...(f?.batchNote ? [f.batchNote] : [])];
  d.agentCase = {
    recommendation: contest ? "contest" : "accept",
    confidence: 0.6,
    winProbability: contest ? 0.7 : 0.2,
    evidence,
    responseText: contest
      ? `We are contesting this claim. Evidence: ${evidence.join("; ")}.`
      : `We're sorry about your experience. We have accepted your claim and issued a full refund.`,
    at: new Date().toISOString(),
  };
  store.upsertDispute(d);
  await requestAction({
    kind: contest ? "DISPUTE_RESPONSE" : "DISPUTE_ACCEPT",
    requestedBy: "rules-engine",
    title: `${contest ? "Contest" : "Accept and refund"} dispute ${d.id} ($${d.amount.toFixed(2)})`,
    rationale: "Rules engine (AI offline)",
    amount: contest ? 0 : d.amount,
    currency: d.currency,
    payload: { disputeId: d.id, responseText: d.agentCase.responseText, note: d.agentCase.responseText },
  });
  return { runId: "heuristic", text: `Recommend ${d.agentCase.recommendation}.` };
}
