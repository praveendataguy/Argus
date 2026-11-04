import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeApproval, rejectApproval } from "./actions.js";
import { aiOnline, analyseDispute, analyseRing, analyseTransaction, askCopilot, draftInvoices } from "./agents/index.js";
import { buildGraph } from "./graph.js";
import { agentPayments, mandates, mandateTokens, payees, runLiveShopper, scenarios } from "./firewall.js";
import { jwks, keyIds, verifyToken } from "./credentials.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { needsStepUp, passkeyStatus, registrationOptions, removePasskeys, stepUpOptions, verifyRegistration, verifyStepUp } from "./passkey.js";
import { attachAudit, audit, checkpoint, inclusionProof, snapshot } from "./observability.js";
import { describeRule, learnedRules } from "./rules.js";
import { explain, modelState, train } from "./ml.js";
import { conveneTribunal } from "./tribunal.js";
import { investigate, investigateAll, listInvestigations } from "./investigator.js";
import { CATCH_SCORE, game, playRound, resetGame, toggleRule } from "./wargame.js";
import { catalog, merchant, productBySku } from "./catalog.js";
import { config, paypalMode } from "./config.js";
import { paypal } from "./paypal/index.js";
import { PayPalApiError } from "./paypal/rest.js";
import { seedDemoData } from "./seed.js";
import { runStorm, simulateOrder, stormRunning, type Scenario } from "./simulate.js";
import { newId, store, type Dispute, type LineItem, type Transaction } from "./store.js";

attachAudit();
seedDemoData();

const app = express();
app.use(express.json({ limit: "1mb" }));

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

/** Runs agent work after the HTTP response; progress reaches the UI over SSE. */
const background = (label: string, p: Promise<unknown>) =>
  p.catch((err) => store.log({ agent: "system", kind: "error", message: `${label}: ${err instanceof Error ? err.message : err}` }));

app.get("/api/config", (_req, res) => {
  res.json({
    merchant,
    catalog,
    paypalMode,
    paypalClientId: paypalMode === "sandbox" ? config.paypal.clientId : null,
    aiOnline: aiOnline(),
    model: config.ai.model,
    autonomy: store.autonomy,
    autoApproveLimit: config.policy.autoApproveLimit,
  });
});

app.get("/api/state", (_req, res) => {
  res.json({
    transactions: [...store.transactions.values()].reverse(),
    disputes: [...store.disputes.values()],
    invoices: [...store.invoices.values()].reverse(),
    approvals: [...store.approvals.values()].reverse(),
    events: store.events.slice(-200),
    autonomy: store.autonomy,
    investigations: listInvestigations(),
  });
});

app.get("/api/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const onEvent = (e: unknown) => send("agent", e);
  const onChange = (entity: string) => send("changed", { entity });
  store.on("event", onEvent);
  store.on("changed", onChange);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    store.off("event", onEvent);
    store.off("changed", onChange);
  });
});

app.post("/api/settings", (req, res) => {
  const autonomy = req.body?.autonomy;
  if (!["observe", "guarded", "autopilot"].includes(autonomy)) return res.status(400).json({ error: "Invalid autonomy" });
  store.autonomy = autonomy;
  store.changed("settings");
  store.log({ agent: "human", kind: "info", message: `Autonomy set to ${autonomy}.` });
  res.json({ autonomy });
});

app.post("/api/transactions/:id/analyse", (req, res) => {
  background("Risk analysis", analyseTransaction(req.params.id));
  res.status(202).json({ ok: true });
});

app.post("/api/transactions/analyse-unscored", (_req, res) => {
  const ids = [...store.transactions.values()].filter((t) => !t.risk).map((t) => t.id);
  // Sequential so the feed reads like an analyst working through a queue.
  background("Risk sweep", ids.reduce((p, id) => p.then(() => background(`Risk analysis ${id}`, analyseTransaction(id))), Promise.resolve<unknown>(null)));
  res.status(202).json({ queued: ids });
});

/* ---------------- Autonomous investigator ---------------- */

app.get("/api/investigations", (_req, res) => res.json(listInvestigations()));

app.post("/api/investigations/all", (_req, res) => {
  res.status(202).json({ queued: investigateAll() });
});

app.post("/api/transactions/:id/investigate", (req, res) => {
  try {
    res.status(202).json(investigate(req.params.id));
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/disputes/:id/analyse", (req, res) => {
  background("Dispute analysis", analyseDispute(req.params.id));
  res.status(202).json({ ok: true });
});

app.post("/api/disputes/:id/tribunal", (req, res) => {
  const id = String(req.params.id);
  if (!store.disputes.has(id)) return res.status(404).json({ error: "No such dispute" });
  background("Tribunal", conveneTribunal(id));
  res.status(202).json({ started: true });
});
app.post("/api/disputes/sync", wrap(async (_req, res) => {
  const remote = await paypal.listDisputes();
  for (const r of remote) {
    if (store.disputes.has(r.id)) continue;
    const tx = [...store.transactions.values()].find((t) => t.captureId === r.captureId);
    store.upsertDispute({
      id: r.id,
      transactionId: tx?.id ?? "",
      createdAt: r.createdAt,
      reason: r.reason as Dispute["reason"],
      amount: r.amount,
      currency: r.currency,
      status: "WAITING_FOR_SELLER_RESPONSE",
      buyerMessage: r.buyerMessage ?? "",
      source: "paypal-sandbox",
    });
  }
  res.json({ synced: remote.length });
}));

app.get("/api/graph", (_req, res) => {
  const graph = buildGraph();
  const rings = graph.rings.map((r) => ({ ...r, verdict: store.ringVerdicts.get(r.accounts.slice().sort().join("|")) ?? null }));
  res.json({ ...graph, rings });
});

app.post("/api/rings/:id/analyse", (req, res) => {
  background("Ring analysis", analyseRing(String(req.params.id)));
  res.status(202).json({ ok: true });
});

/* ---------------- Agent payment firewall ---------------- */

app.get("/api/firewall", (_req, res) => {
  res.json({
    mandates: mandates.map((m) => ({ ...m, token: mandateTokens.get(m.agentId) })),
    keys: keyIds(),
    payees,
    payments: agentPayments.slice(0, 50),
    scenarios: Object.entries(scenarios).map(([id, s]) => ({ id, label: s.label })),
    mcpUrl: `${config.publicUrl}/mcp`,
  });
});

app.post("/api/firewall/scenario/:id", wrap(async (req, res) => {
  const s = scenarios[String(req.params.id)];
  if (!s) return res.status(404).json({ error: "Unknown scenario" });
  res.json(await s.run());
}));

app.post("/api/firewall/live-agent", (_req, res) => {
  if (!aiOnline()) return res.status(400).json({ error: "The live agent needs GROQ_API_KEY or ANTHROPIC_API_KEY" });
  background("Live shopping agent", runLiveShopper());
  res.status(202).json({ ok: true });
});

app.get("/.well-known/jwks.json", (_req, res) => res.json(jwks()));
app.post("/api/credentials/verify", (req, res) => res.json(verifyToken(String(req.body?.token ?? ""))));

// MCP endpoint (stateless Streamable HTTP): a fresh server per request.
app.post("/mcp", wrap(async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}));
app.all("/mcp", (_req, res) => res.status(405).json({ error: "Use POST for MCP requests" }));

/* ---------------- Observability & audit ---------------- */

app.get("/api/observability", (_req, res) => res.json(snapshot()));
app.get("/api/audit", (req, res) => res.json(audit.tail(Math.min(500, Number(req.query.limit ?? 200)))));
/* ---------------- Explainable ML risk model ---------------- */
app.get("/api/ml", (_req, res) => res.json(modelState()));
app.post("/api/ml/train", (_req, res) => res.json(train("Manual retrain.")));
app.get("/api/ml/explain/:id", (req, res) => {
  const id = String(req.params.id);
  const tx = store.transactions.get(id) ?? game.orders.find((t) => t.id === id);
  if (!tx) return res.status(404).json({ error: "No such transaction" });
  res.json(explain(tx));
});

app.get("/api/audit/verify", (_req, res) => res.json(audit.verify()));
app.post("/api/audit/checkpoint", (_req, res) => res.json(checkpoint() ?? null));
app.get("/api/audit/proof/:seq", (req, res) => res.json(inclusionProof(Number(req.params.seq))));
app.get("/api/audit/export", (_req, res) => {
  res.set({ "Content-Type": "application/x-ndjson", "Content-Disposition": "attachment; filename=argus-audit.jsonl" });
  res.send(audit.file());
});

/* ---------------- War game ---------------- */

app.get("/api/wargame", (_req, res) => {
  res.json({
    running: game.running,
    catchScore: CATCH_SCORE,
    rounds: game.rounds.map(({ orders, ...r }) => ({ ...r, orders: orders.map(({ tx, ...o }) => o) })),
    rules: learnedRules.map((r) => ({ ...r, description: describeRule(r) })),
  });
});

app.post("/api/wargame/round", (_req, res) => {
  if (game.running) return res.status(409).json({ error: "A round is already running" });
  background("War game", playRound());
  res.status(202).json({ ok: true });
});

app.post("/api/wargame/reset", (_req, res) => {
  resetGame();
  res.json({ ok: true });
});

app.post("/api/wargame/rules/:id", wrap(async (req, res) => res.json(toggleRule(String(req.params.id), Boolean(req.body?.enabled)))));

/** Relying party for WebAuthn: the page's own origin (or PASSKEY_RP_ID when pinned in production). */
const rp = (req: Request) => {
  const origin = String(req.get("origin") ?? `${req.protocol}://${req.get("host")}`);
  return { origin, rpID: process.env.PASSKEY_RP_ID ?? new URL(origin).hostname };
};

app.post("/api/approvals/:id/approve", wrap(async (req, res) => {
  const a = store.approvals.get(String(req.params.id));
  if (!a) return res.status(404).json({ error: "No such approval" });
  const { rpID, origin } = rp(req);
  if (a.status === "PENDING" && needsStepUp(a, rpID)) {
    // High-value: the operator must sign this exact approval with their passkey.
    if (!req.body?.assertion) return res.status(401).json({ stepUp: true, options: await stepUpOptions(a, rpID) });
    a.stepUp = await verifyStepUp(a, rpID, origin, req.body.assertion);
  }
  res.json(await executeApproval(a.id));
}));

app.get("/api/passkey", (req, res) => res.json(passkeyStatus(rp(req).rpID)));
app.post("/api/passkey/register/options", wrap(async (req, res) => res.json(await registrationOptions(rp(req).rpID))));
app.post("/api/passkey/register/verify", wrap(async (req, res) => {
  const { rpID, origin } = rp(req);
  res.json(await verifyRegistration(rpID, origin, req.body.response, String(req.body.label ?? "Passkey").slice(0, 40)));
}));
app.delete("/api/passkey", (req, res) => {
  removePasskeys(rp(req).rpID);
  res.json(passkeyStatus(rp(req).rpID));
});
app.post("/api/approvals/:id/reject", wrap(async (req, res) => res.json(await rejectApproval(String(req.params.id)))));

app.post("/api/invoices/draft", wrap(async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "Describe the invoice" });
  res.json(await draftInvoices(text));
}));

app.post("/api/copilot", wrap(async (req, res) => {
  const question = String(req.body?.question ?? "").trim();
  if (!question) return res.status(400).json({ error: "Ask a question" });
  res.json(await askCopilot(question));
}));

/* ---------------- Storefront checkout (PayPal Orders v2) ---------------- */

function cartToItems(cart: { sku: string; quantity: number }[]): LineItem[] {
  return cart.map(({ sku, quantity }) => {
    const p = productBySku(sku);
    if (!p) throw new Error(`Unknown product ${sku}`);
    return { name: p.name, quantity: Math.max(1, Math.min(10, Number(quantity) || 1)), unitAmount: p.price };
  });
}

app.post("/api/checkout/orders", wrap(async (req, res) => {
  const items = cartToItems(req.body?.cart ?? []);
  if (!items.length) return res.status(400).json({ error: "Cart is empty" });
  const amount = items.reduce((s, i) => s + i.quantity * i.unitAmount, 0);
  const order = await paypal.createOrder({ amount, currency: config.policy.currency, items, description: `${merchant.name} order` });
  pendingCarts.set(order.id, items);
  res.json(order);
}));

const pendingCarts = new Map<string, LineItem[]>();

app.post("/api/checkout/orders/:id/capture", wrap(async (req, res) => {
  const capture = await paypal.captureOrder(String(req.params.id));
  // A declined card still returns a 201 from PayPal; don't book it as a sale.
  if (capture.status === "DECLINED" || capture.status === "FAILED") {
    return res.status(402).json({ error: `PayPal ${capture.status.toLowerCase()} the payment`, status: capture.status });
  }
  const items = pendingCarts.get(capture.orderId) ?? [{ name: "PayPal order", quantity: 1, unitAmount: capture.amount }];
  pendingCarts.delete(capture.orderId);
  const country = capture.payer.country ?? "US";
  const tx: Transaction = {
    id: newId("TX"),
    orderId: capture.orderId,
    captureId: capture.captureId,
    createdAt: new Date().toISOString(),
    amount: capture.amount,
    currency: capture.currency,
    items,
    buyer: { name: capture.payer.name, email: capture.payer.email, country, accountAgeDays: 400, payerId: capture.payer.payerId },
    shipping: { country: capture.shipping?.country ?? country, city: capture.shipping?.city ?? "", method: capture.amount > 300 ? "tracked-signature" : "tracked" },
    ipCountry: country,
    device: String(req.headers["user-agent"] ?? "Unknown").slice(0, 60),
    fingerprint: {
      ip: String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "0.0.0.0").split(",")[0].replace("::ffff:", ""),
      deviceId: `dev-${capture.payer.payerId ?? "unknown"}`,
      address: `${capture.shipping?.city ?? ""}, ${capture.shipping?.country ?? country}`,
    },
    status: "COMPLETED",
    refundedAmount: 0,
    source: paypalMode === "sandbox" ? "paypal-sandbox" : "simulator",
  };
  store.upsertTransaction(tx);
  store.log({ agent: "paypal", kind: "webhook", message: `Payment captured: ${tx.id} · $${tx.amount.toFixed(2)} from ${tx.buyer.email} (capture ${tx.captureId})` });
  background("Risk analysis", analyseTransaction(tx.id));
  res.json({ transactionId: tx.id, captureId: tx.captureId, status: capture.status });
}));

app.post("/api/simulate/storm", (req, res) => {
  if (stormRunning) return res.status(409).json({ error: "A storm is already running" });
  const size = Math.max(4, Math.min(30, Number(req.body?.size ?? 14)));
  background("Attack storm", runStorm(size, (ids) => ids.reduce((p, id) => p.then(() => background(`Risk analysis ${id}`, analyseTransaction(id))), Promise.resolve<unknown>(null))));
  res.status(202).json({ started: true, size });
});

app.post("/api/simulate/:scenario", wrap(async (req, res) => {
  const tx = await simulateOrder(req.params.scenario as Scenario);
  background("Risk analysis", analyseTransaction(tx.id));
  res.json({ transactionId: tx.id });
}));

/* ---------------- PayPal webhooks ---------------- */

app.post("/api/webhooks/paypal", wrap(async (req, res) => {
  const event = req.body as { event_type?: string; resource?: { id?: string; dispute_id?: string } };
  const verified = await paypal.verifyWebhook(req.headers, event).catch(() => false);
  store.log({ agent: "paypal", kind: "webhook", message: `Webhook ${event.event_type ?? "?"} (${verified ? "signature verified" : "unverified"})` });
  if (!verified && paypalMode === "sandbox") return res.status(400).json({ error: "Signature verification failed" });

  if (event.event_type === "CUSTOMER.DISPUTE.CREATED" && event.resource?.dispute_id) {
    const remote = await paypal.listDisputes();
    const r = remote.find((d) => d.id === event.resource!.dispute_id);
    if (r && !store.disputes.has(r.id)) {
      const tx = [...store.transactions.values()].find((t) => t.captureId === r.captureId);
      store.upsertDispute({ id: r.id, transactionId: tx?.id ?? "", createdAt: r.createdAt, reason: r.reason as Dispute["reason"], amount: r.amount, currency: r.currency, status: "WAITING_FOR_SELLER_RESPONSE", buyerMessage: "", source: "paypal-sandbox" });
      background("Dispute analysis", analyseDispute(r.id));
    }
  }
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" && event.resource?.id) {
    const tx = [...store.transactions.values()].find((t) => t.captureId === event.resource!.id);
    if (tx && !tx.risk) background("Risk analysis", analyseTransaction(tx.id));
  }
  res.json({ ok: true });
}));

/* ---------------- Static web app ---------------- */

const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/|mcp|\.well-known).*/, (_req, res) => res.sendFile(join(webDist, "index.html")));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  store.log({ agent: "system", kind: "error", message });
  // Surface PayPal's own 4xx (e.g. 422 "payer has not approved") instead of a generic 500.
  const status = err instanceof PayPalApiError && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`Argus on http://localhost:${config.port}`);
  console.log(`  PayPal: ${paypalMode}${paypalMode === "simulator" ? " (set PAYPAL_CLIENT_ID/SECRET for the real sandbox)" : ""}`);
  console.log(`  AI: ${aiOnline() ? config.ai.model : "offline rules engine (set GROQ_API_KEY or ANTHROPIC_API_KEY)"}`);
});
