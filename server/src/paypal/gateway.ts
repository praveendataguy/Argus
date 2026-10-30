import type { LineItem } from "../store.js";

export interface CapturedPayment {
  orderId: string;
  captureId: string;
  status: string;
  amount: number;
  currency: string;
  payer: { name: string; email: string; payerId?: string; country?: string };
  shipping?: { city?: string; country?: string };
}

export interface PayPalDisputeSummary {
  id: string;
  reason: string;
  status: string;
  amount: number;
  currency: string;
  createdAt: string;
  captureId?: string;
  buyerMessage?: string;
}

/** Every PayPal call Argus makes goes through this interface. */
export interface PayPalGateway {
  readonly mode: "sandbox" | "simulator";
  createOrder(input: { amount: number; currency: string; items: LineItem[]; description?: string }): Promise<{ id: string; approveUrl?: string }>;
  captureOrder(orderId: string): Promise<CapturedPayment>;
  refundCapture(captureId: string, amount: number, currency: string, note: string): Promise<{ id: string; status: string }>;
  createInvoice(input: {
    recipientEmail: string;
    recipientName: string;
    items: LineItem[];
    currency: string;
    dueInDays: number;
    note: string;
  }): Promise<{ id: string; number: string }>;
  sendInvoice(invoiceId: string): Promise<{ status: string; url?: string }>;
  listDisputes(): Promise<PayPalDisputeSummary[]>;
  provideDisputeEvidence(disputeId: string, notes: string): Promise<{ status: string }>;
  acceptDisputeClaim(disputeId: string, note: string): Promise<{ status: string }>;
  createPayout(input: { receiverEmail: string; amount: number; currency: string; note: string }): Promise<{ batchId: string; status: string }>;
  verifyWebhook(headers: Record<string, string | string[] | undefined>, body: unknown): Promise<boolean>;
}
