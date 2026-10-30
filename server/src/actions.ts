import { config } from "./config.js";
import { agentPayments, issueReceipt, releaseReservation } from "./firewall.js";
import { gatewayFor, paypal } from "./paypal/index.js";
import { newId, store, type Approval, type ApprovalKind } from "./store.js";

const AUTOPILOT_CEILING = 500;

/** Decides whether an agent's requested action may run without a human. */
export function policyAllowsAuto(kind: ApprovalKind, amount: number): { auto: boolean; why: string } {
  const limit = config.policy.autoApproveLimit;
  switch (store.autonomy) {
    case "observe":
      return { auto: false, why: "Observe mode: agents only propose, a human executes everything." };
    case "guarded":
      if (kind === "DISPUTE_RESPONSE" || kind === "INVOICE_SEND")
        return { auto: false, why: "Guarded mode: anything a customer sees needs a human." };
      return amount <= limit
        ? { auto: true, why: `Guarded mode: $${amount.toFixed(2)} is within the $${limit} auto-approve limit.` }
        : { auto: false, why: `Guarded mode: $${amount.toFixed(2)} is above the $${limit} auto-approve limit.` };
    case "autopilot":
      return amount <= AUTOPILOT_CEILING
        ? { auto: true, why: `Autopilot: within the $${AUTOPILOT_CEILING} hard ceiling.` }
        : { auto: false, why: `Autopilot: $${amount.toFixed(2)} exceeds the $${AUTOPILOT_CEILING} hard ceiling.` };
  }
}

/** Every money-moving or customer-facing agent action is funnelled through here. */
export async function requestAction(input: Omit<Approval, "id" | "createdAt" | "status"> & { forceAuto?: boolean }): Promise<Approval> {
  const { forceAuto, ...rest } = input;
  const approval: Approval = { ...rest, id: newId("APR"), createdAt: new Date().toISOString(), status: "PENDING" };
  const policy = policyAllowsAuto(approval.kind, approval.amount);
  // The agent firewall has already applied the owner's mandate, so it can pre-approve.
  const { auto, why } = forceAuto && store.autonomy !== "observe" ? { auto: true, why: "Within the agent's mandate and approved by the firewall." } : policy;
  store.upsertApproval(approval);
  store.log({ agent: approval.requestedBy, kind: "decision", message: `Requested: ${approval.title}. ${why}`, data: { approvalId: approval.id } });
  if (auto) {
    approval.autoApproved = true;
    await executeApproval(approval.id, "policy");
  }
  return store.approvals.get(approval.id)!;
}

export async function rejectApproval(id: string, by = "human") {
  const a = store.approvals.get(id);
  if (!a || a.status !== "PENDING") throw new Error("Approval is not pending");
  a.status = "REJECTED";
  a.decidedAt = new Date().toISOString();
  store.upsertApproval(a);
  store.log({ agent: by, kind: "action", message: `Rejected: ${a.title}` });
  if (a.kind === "AGENT_PAYMENT") {
    releaseReservation(String(a.payload.agentId), a.amount);
    const p = agentPayments.find((x) => x.id === a.payload.paymentId);
    if (p) p.verdict = "blocked";
    store.changed("firewall");
  }
  if (a.kind === "RELEASE_HOLD" || a.kind === "REFUND") {
    const tx = store.transactions.get(String(a.payload.transactionId));
    if (tx && a.kind === "REFUND" && tx.status === "HELD") {
      // Reviewer kept the order: release the hold.
      tx.status = "COMPLETED";
      store.upsertTransaction(tx);
    }
  }
  return a;
}

export async function executeApproval(id: string, by: "human" | "policy" = "human"): Promise<Approval> {
  const a = store.approvals.get(id);
  if (!a || a.status !== "PENDING") throw new Error("Approval is not pending");
  a.status = "APPROVED";
  a.decidedAt = new Date().toISOString();
  store.upsertApproval(a);

  try {
    a.result = await run(a);
    a.status = "EXECUTED";
    if (a.kind === "AGENT_PAYMENT") {
      const p = agentPayments.find((x) => x.id === a.payload.paymentId);
      if (p) {
        p.verdict = "approved";
        p.reference = a.result;
        issueReceipt(p);
        store.changed("firewall");
      }
    }
    store.log({
      agent: by === "policy" ? "policy-engine" : "human",
      kind: "action",
      message: `${by === "policy" ? "Auto-executed" : "Approved and executed"}: ${a.title} → ${a.result}`,
    });
  } catch (err) {
    a.status = "FAILED";
    a.result = err instanceof Error ? err.message : String(err);
    store.log({ agent: "paypal", kind: "error", message: `PayPal call failed for "${a.title}": ${a.result}` });
  }
  store.upsertApproval(a);
  return a;
}

async function run(a: Approval): Promise<string> {
  const p = a.payload;
  switch (a.kind) {
    case "REFUND": {
      const tx = store.transactions.get(String(p.transactionId));
      if (!tx) throw new Error("Transaction not found");
      const refund = await gatewayFor(tx.source).refundCapture(tx.captureId, a.amount, tx.currency, String(p.note ?? "Refund from Nimbus Audio"));
      tx.refundedAmount += a.amount;
      tx.status = tx.refundedAmount >= tx.amount ? "REFUNDED" : "PARTIALLY_REFUNDED";
      store.upsertTransaction(tx);
      return `PayPal refund ${refund.id} ${refund.status}`;
    }
    case "RELEASE_HOLD": {
      const tx = store.transactions.get(String(p.transactionId));
      if (!tx) throw new Error("Transaction not found");
      tx.status = "COMPLETED";
      store.upsertTransaction(tx);
      return "Order released for fulfilment";
    }
    case "DISPUTE_RESPONSE": {
      const d = store.disputes.get(String(p.disputeId));
      if (!d) throw new Error("Dispute not found");
      if (d.source === "paypal-sandbox") await paypal.provideDisputeEvidence(d.id, String(p.responseText));
      d.status = "UNDER_REVIEW";
      store.upsertDispute(d);
      return d.source === "paypal-sandbox" ? "Evidence submitted to PayPal Disputes API" : "Evidence package filed";
    }
    case "DISPUTE_ACCEPT": {
      const d = store.disputes.get(String(p.disputeId));
      if (!d) throw new Error("Dispute not found");
      let detail = "Claim accepted";
      if (d.source === "paypal-sandbox") await paypal.acceptDisputeClaim(d.id, String(p.note ?? ""));
      else {
        const tx = store.transactions.get(d.transactionId);
        if (tx) {
          const refund = await gatewayFor(tx.source).refundCapture(tx.captureId, d.amount, d.currency, String(p.note ?? "Refund for your claim"));
          tx.refundedAmount += d.amount;
          tx.status = "REFUNDED";
          store.upsertTransaction(tx);
          detail = `Claim accepted, PayPal refund ${refund.id}`;
        }
      }
      d.status = "RESOLVED";
      d.outcome = "ACCEPTED";
      store.upsertDispute(d);
      return detail;
    }
    case "INVOICE_SEND": {
      const inv = store.invoices.get(String(p.invoiceId));
      if (!inv) throw new Error("Invoice not found");
      const sent = await paypal.sendInvoice(inv.id);
      inv.status = "SENT";
      inv.paypalUrl = sent.url;
      store.upsertInvoice(inv);
      return `PayPal invoice #${inv.number} sent to ${inv.recipientEmail}`;
    }
    case "AGENT_PAYMENT":
    case "PAYOUT": {
      const res = await paypal.createPayout({
        receiverEmail: String(p.receiverEmail),
        amount: a.amount,
        currency: a.currency,
        note: String(p.note ?? ""),
      });
      return `PayPal payout batch ${res.batchId} ${res.status}`;
    }
  }
}
