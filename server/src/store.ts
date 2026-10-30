import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface Buyer {
  name: string;
  email: string;
  country: string;
  accountAgeDays: number;
  payerId?: string;
}

export interface LineItem {
  name: string;
  quantity: number;
  unitAmount: number;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  action: "allow" | "review" | "hold" | "refund";
  reasons: string[];
  summary: string;
  decidedBy: "ai" | "heuristic";
  at: string;
}

export interface Transaction {
  id: string;
  orderId: string;
  captureId: string;
  createdAt: string;
  amount: number;
  currency: string;
  items: LineItem[];
  buyer: Buyer;
  shipping: { country: string; city: string; method: string; trackingNumber?: string; delivered?: boolean };
  ipCountry: string;
  device: string;
  /** Identity signals used to link accounts: IP address, device fingerprint, normalised shipping address. */
  fingerprint: { ip: string; deviceId: string; address: string };
  status: "COMPLETED" | "HELD" | "REFUNDED" | "PARTIALLY_REFUNDED";
  refundedAmount: number;
  source: "seed" | "paypal-sandbox" | "simulator";
  risk?: RiskAssessment;
}

export interface Dispute {
  id: string;
  transactionId: string;
  createdAt: string;
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" | "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" | "UNAUTHORISED";
  amount: number;
  currency: string;
  status: "OPEN" | "WAITING_FOR_SELLER_RESPONSE" | "UNDER_REVIEW" | "RESOLVED";
  buyerMessage: string;
  outcome?: "WON" | "LOST" | "ACCEPTED";
  agentCase?: {
    recommendation: "contest" | "accept";
    confidence: number;
    winProbability: number;
    evidence: string[];
    responseText: string;
    at: string;
  };
  source: "seed" | "paypal-sandbox";
}

export interface Invoice {
  id: string;
  number: string;
  createdAt: string;
  recipientEmail: string;
  recipientName: string;
  items: LineItem[];
  total: number;
  currency: string;
  dueInDays: number;
  note: string;
  status: "DRAFT" | "SENT" | "PAID" | "CANCELLED";
  paypalUrl?: string;
  source: "ai" | "manual";
}

export type ApprovalKind = "REFUND" | "PAYOUT" | "DISPUTE_RESPONSE" | "DISPUTE_ACCEPT" | "INVOICE_SEND" | "RELEASE_HOLD";

export interface Approval {
  id: string;
  kind: ApprovalKind;
  createdAt: string;
  requestedBy: string;
  title: string;
  rationale: string;
  amount: number;
  currency: string;
  payload: Record<string, unknown>;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED" | "FAILED";
  autoApproved?: boolean;
  result?: string;
  decidedAt?: string;
}

export interface AgentEvent {
  id: string;
  ts: string;
  agent: string;
  kind: "thinking" | "tool" | "decision" | "action" | "error" | "info" | "webhook";
  message: string;
  runId?: string;
  data?: unknown;
}

class Store extends EventEmitter {
  transactions = new Map<string, Transaction>();
  disputes = new Map<string, Dispute>();
  invoices = new Map<string, Invoice>();
  approvals = new Map<string, Approval>();
  events: AgentEvent[] = [];
  autonomy: "observe" | "guarded" | "autopilot" = "guarded";
  /** Ring verdicts keyed by the sorted member emails, so they survive ring renumbering. */
  ringVerdicts = new Map<string, { verdict: "fraud" | "benign"; explanation: string; at: string; by: string }>();

  log(e: Omit<AgentEvent, "id" | "ts">): AgentEvent {
    const event: AgentEvent = { id: randomUUID(), ts: new Date().toISOString(), ...e };
    this.events.push(event);
    if (this.events.length > 500) this.events.shift();
    this.emit("event", event);
    return event;
  }

  changed(entity: "transactions" | "disputes" | "invoices" | "approvals" | "settings") {
    this.emit("changed", entity);
  }

  upsertTransaction(t: Transaction) {
    this.transactions.set(t.id, t);
    this.changed("transactions");
  }

  upsertDispute(d: Dispute) {
    this.disputes.set(d.id, d);
    this.changed("disputes");
  }

  upsertInvoice(i: Invoice) {
    this.invoices.set(i.id, i);
    this.changed("invoices");
  }

  upsertApproval(a: Approval) {
    this.approvals.set(a.id, a);
    this.changed("approvals");
  }

  buyerHistory(email: string) {
    return [...this.transactions.values()].filter((t) => t.buyer.email.toLowerCase() === email.toLowerCase());
  }
}

export const store = new Store();
store.setMaxListeners(100);

export const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
