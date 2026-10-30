import { randomUUID } from "node:crypto";
import type { CapturedPayment, PayPalGateway } from "./gateway.js";

const id = (prefix = "") => prefix + randomUUID().replace(/-/g, "").slice(0, 17).toUpperCase();

/**
 * An in-memory stand-in for the PayPal REST APIs, used when no sandbox
 * credentials are configured so the project still runs end to end.
 * Response shapes mirror what PayPalRestGateway returns.
 */
export class PayPalSimulatorGateway implements PayPalGateway {
  readonly mode = "simulator" as const;
  private orders = new Map<string, { amount: number; currency: string }>();
  private invoiceSeq = 1000;

  async createOrder({ amount, currency }: Parameters<PayPalGateway["createOrder"]>[0]) {
    const orderId = id();
    this.orders.set(orderId, { amount, currency });
    return { id: orderId };
  }

  async captureOrder(orderId: string): Promise<CapturedPayment> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    return {
      orderId,
      captureId: id("CAP"),
      status: "COMPLETED",
      amount: order.amount,
      currency: order.currency,
      payer: { name: "Sandbox Buyer", email: "sb-buyer@personal.example.com", payerId: id("P"), country: "US" },
      shipping: { city: "San Jose", country: "US" },
    };
  }

  async refundCapture() {
    return { id: id("REF"), status: "COMPLETED" };
  }

  async createInvoice() {
    return { id: `INV2-${id().slice(0, 4)}-${id().slice(0, 4)}-${id().slice(0, 4)}`, number: String(++this.invoiceSeq) };
  }

  async sendInvoice(invoiceId: string) {
    return { status: "SENT", url: `https://www.sandbox.paypal.com/invoice/p/#${invoiceId}` };
  }

  async listDisputes() {
    return [];
  }

  async provideDisputeEvidence() {
    return { status: "EVIDENCE_SUBMITTED" };
  }

  async acceptDisputeClaim() {
    return { status: "ACCEPTED" };
  }

  async createPayout() {
    return { batchId: id("PB"), status: "SUCCESS" };
  }

  async verifyWebhook() {
    return true;
  }
}
