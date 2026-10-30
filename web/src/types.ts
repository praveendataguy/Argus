// Mirrors server/src/store.ts. Kept as a copy so the web build has no server imports.
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface LineItem {
  name: string;
  quantity: number;
  unitAmount: number;
}

export interface Transaction {
  id: string;
  orderId: string;
  captureId: string;
  createdAt: string;
  amount: number;
  currency: string;
  items: LineItem[];
  buyer: { name: string; email: string; country: string; accountAgeDays: number };
  shipping: { country: string; city: string; method: string; trackingNumber?: string; delivered?: boolean };
  ipCountry: string;
  device: string;
  status: "COMPLETED" | "HELD" | "REFUNDED" | "PARTIALLY_REFUNDED";
  refundedAmount: number;
  source: "seed" | "paypal-sandbox" | "simulator";
  risk?: {
    score: number;
    level: RiskLevel;
    action: "allow" | "review" | "hold" | "refund";
    reasons: string[];
    summary: string;
    decidedBy: "ai" | "heuristic";
    at: string;
  };
}

export interface Dispute {
  id: string;
  transactionId: string;
  createdAt: string;
  reason: string;
  amount: number;
  currency: string;
  status: string;
  buyerMessage: string;
  outcome?: string;
  agentCase?: {
    recommendation: "contest" | "accept";
    confidence: number;
    winProbability: number;
    evidence: string[];
    responseText: string;
    at: string;
  };
  source: string;
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
  status: string;
  paypalUrl?: string;
}

export interface Approval {
  id: string;
  kind: string;
  createdAt: string;
  requestedBy: string;
  title: string;
  rationale: string;
  amount: number;
  currency: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED" | "FAILED";
  autoApproved?: boolean;
  result?: string;
}

export interface AgentEvent {
  id: string;
  ts: string;
  agent: string;
  kind: "thinking" | "tool" | "decision" | "action" | "error" | "info" | "webhook";
  message: string;
  runId?: string;
}

export type Autonomy = "observe" | "guarded" | "autopilot";

export interface AppConfig {
  merchant: { name: string; tagline: string };
  catalog: { sku: string; name: string; price: number; blurb: string; emoji: string }[];
  paypalMode: "sandbox" | "simulator";
  paypalClientId: string | null;
  aiOnline: boolean;
  model: string;
  autonomy: Autonomy;
  autoApproveLimit: number;
}

export interface AppState {
  transactions: Transaction[];
  disputes: Dispute[];
  invoices: Invoice[];
  approvals: Approval[];
  events: AgentEvent[];
  autonomy: Autonomy;
}
