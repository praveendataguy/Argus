import { config } from "../config.js";
import type { CapturedPayment, PayPalDisputeSummary, PayPalGateway } from "./gateway.js";

const money = (value: number, currency: string) => ({ currency_code: currency, value: value.toFixed(2) });

export class PayPalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: unknown,
  ) {
    super(message);
  }
}

/** Talks to the real PayPal REST APIs (sandbox by default). */
export class PayPalRestGateway implements PayPalGateway {
  readonly mode = "sandbox" as const;
  private token?: { value: string; expiresAt: number };

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString("base64");
    const res = await fetch(`${config.paypal.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalApiError("PayPal OAuth failed", res.status, await res.text());
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "PayPal-Request-Id": crypto.randomUUID(),
      Prefer: "return=representation",
      ...extraHeaders,
    };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${config.paypal.baseUrl}${path}`, { method, headers, body: payload });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = json?.details?.[0]?.description ?? json?.message ?? res.statusText;
      throw new PayPalApiError(`PayPal ${method} ${path} failed: ${msg}`, res.status, json);
    }
    return json as T;
  }

  async createOrder({ amount, currency, items, description }: Parameters<PayPalGateway["createOrder"]>[0]) {
    const itemTotal = items.reduce((s, i) => s + i.unitAmount * i.quantity, 0);
    const order = await this.call<{ id: string; links: { rel: string; href: string }[] }>("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [
        {
          description,
          amount: { ...money(amount, currency), breakdown: { item_total: money(itemTotal, currency) } },
          items: items.map((i) => ({ name: i.name, quantity: String(i.quantity), unit_amount: money(i.unitAmount, currency) })),
        },
      ],
      // PAY_NOW makes PayPal's last button "Complete Purchase" instead of "Continue to Review Order",
      // since this storefront has no review page of its own.
      payment_source: { paypal: { experience_context: { user_action: "PAY_NOW", shipping_preference: "GET_FROM_FILE" } } },
    });
    return { id: order.id, approveUrl: order.links.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href };
  }

  async captureOrder(orderId: string): Promise<CapturedPayment> {
    type Capture = {
      id: string;
      status: string;
      payer?: { name?: { given_name?: string; surname?: string }; email_address?: string; payer_id?: string; address?: { country_code?: string } };
      purchase_units: {
        shipping?: { address?: { admin_area_2?: string; country_code?: string } };
        payments: { captures: { id: string; status: string; amount: { value: string; currency_code: string } }[] };
      }[];
    };
    const order = await this.call<Capture>("POST", `/v2/checkout/orders/${orderId}/capture`, {});
    const unit = order.purchase_units[0];
    const capture = unit.payments.captures[0];
    return {
      orderId: order.id,
      captureId: capture.id,
      status: capture.status,
      amount: Number(capture.amount.value),
      currency: capture.amount.currency_code,
      payer: {
        name: [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(" ") || "PayPal buyer",
        email: order.payer?.email_address ?? "unknown@paypal.example",
        payerId: order.payer?.payer_id,
        country: order.payer?.address?.country_code,
      },
      shipping: { city: unit.shipping?.address?.admin_area_2, country: unit.shipping?.address?.country_code },
    };
  }

  async refundCapture(captureId: string, amount: number, currency: string, note: string) {
    const res = await this.call<{ id: string; status: string }>("POST", `/v2/payments/captures/${captureId}/refund`, {
      amount: money(amount, currency),
      note_to_payer: note.slice(0, 255),
    });
    return { id: res.id, status: res.status };
  }

  async createInvoice(input: Parameters<PayPalGateway["createInvoice"]>[0]) {
    const { invoice_number } = await this.call<{ invoice_number: string }>("POST", "/v2/invoicing/generate-next-invoice-number");
    const due = new Date(Date.now() + input.dueInDays * 86_400_000).toISOString().slice(0, 10);
    const [given, ...rest] = input.recipientName.split(" ");
    const res = await this.call<{ id?: string; href?: string }>("POST", "/v2/invoicing/invoices", {
      detail: {
        invoice_number,
        currency_code: input.currency,
        note: input.note.slice(0, 4000),
        payment_term: { due_date: due },
      },
      invoicer: { email_address: config.paypal.merchantEmail },
      primary_recipients: [{ billing_info: { email_address: input.recipientEmail, name: { given_name: given, surname: rest.join(" ") } } }],
      items: input.items.map((i) => ({ name: i.name.slice(0, 200), quantity: String(i.quantity), unit_amount: money(i.unitAmount, input.currency) })),
    });
    const id = res.id ?? res.href?.split("/").pop() ?? "";
    return { id, number: invoice_number };
  }

  async sendInvoice(invoiceId: string) {
    const res = await this.call<{ href?: string }>("POST", `/v2/invoicing/invoices/${invoiceId}/send`, {
      send_to_invoicer: true,
      send_to_recipient: true,
    });
    return { status: "SENT", url: res.href };
  }

  async listDisputes(): Promise<PayPalDisputeSummary[]> {
    type List = {
      items?: {
        dispute_id: string;
        reason: string;
        status: string;
        create_time: string;
        dispute_amount?: { value: string; currency_code: string };
        disputed_transactions?: { seller_transaction_id?: string }[];
      }[];
    };
    const res = await this.call<List>("GET", "/v1/customer/disputes?page_size=50");
    return (res.items ?? []).map((d) => ({
      id: d.dispute_id,
      reason: d.reason,
      status: d.status,
      createdAt: d.create_time,
      amount: Number(d.dispute_amount?.value ?? 0),
      currency: d.dispute_amount?.currency_code ?? config.policy.currency,
      captureId: d.disputed_transactions?.[0]?.seller_transaction_id,
    }));
  }

  async provideDisputeEvidence(disputeId: string, notes: string) {
    const form = new FormData();
    form.append(
      "input",
      new Blob([JSON.stringify({ evidences: [{ evidence_type: "OTHER", notes: notes.slice(0, 2000) }] })], { type: "application/json" }),
    );
    await this.call("POST", `/v1/customer/disputes/${disputeId}/provide-evidence`, form);
    return { status: "EVIDENCE_SUBMITTED" };
  }

  async acceptDisputeClaim(disputeId: string, note: string) {
    await this.call("POST", `/v1/customer/disputes/${disputeId}/accept-claim`, { note: note.slice(0, 2000) });
    return { status: "ACCEPTED" };
  }

  async createPayout({ receiverEmail, amount, currency, note }: Parameters<PayPalGateway["createPayout"]>[0]) {
    const res = await this.call<{ batch_header: { payout_batch_id: string; batch_status: string } }>("POST", "/v1/payments/payouts", {
      sender_batch_header: { sender_batch_id: crypto.randomUUID(), email_subject: "You have a payout from Argus" },
      items: [{ recipient_type: "EMAIL", amount: { value: amount.toFixed(2), currency }, receiver: receiverEmail, note }],
    });
    return { batchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status };
  }

  async verifyWebhook(headers: Record<string, string | string[] | undefined>, body: unknown) {
    if (!config.paypal.webhookId) return false;
    const h = (k: string) => String(headers[k] ?? "");
    const res = await this.call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: config.paypal.webhookId,
      webhook_event: body,
    });
    return res.verification_status === "SUCCESS";
  }
}
