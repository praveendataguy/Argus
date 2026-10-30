# 🛡️ Sentinel Pay

**An autonomous AI back office that guards a PayPal merchant account.**

Small online sellers lose money in three places: fraud they don't catch before shipping, disputes they don't have time to fight (or fight when they shouldn't), and billing that slips. Sentinel Pay puts a team of AI agents in charge of the PayPal account, with a policy engine and a human approval queue in front of every dollar that moves.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

| Agent | Watches | Does | PayPal APIs |
|---|---|---|---|
| **Risk Sentinel** 🛡️ | Every captured payment | Scores fraud risk from deterministic signals plus reasoning, then allows, flags, holds or cancels and refunds | Orders v2, Payments v2 (refunds), Webhooks |
| **Dispute Agent** ⚖️ | Every PayPal dispute | Reads the case, tracking, support tickets and QA notes, estimates win probability, drafts the evidence response or recommends accepting | Disputes v1 (list, provide-evidence, accept-claim) |
| **Billing Agent** 🧾 | Free-text requests | Turns an email, note or voice transcript into a PayPal invoice | Invoicing v2 |
| **Sentinel Copilot** 💬 | The merchant | Answers questions and carries out instructions ("refund $20 on TX-1039", "pay our affiliate $40") | All of the above, plus Payouts v1 |

### Guardrails: AI behind the wheel, human on the brake

Every money-moving or customer-facing action goes through one policy engine (`server/src/actions.ts`). The merchant chooses how much autonomy the agents get:

- **Observe**: agents only propose. A human executes everything.
- **Guarded** (default): refunds and payouts up to `AUTO_APPROVE_LIMIT` ($25) run on their own. Anything larger, and anything a customer will read (dispute responses, invoices), waits in the approval queue.
- **Autopilot**: agents act on their own up to a hard $500 ceiling.

Agents can't move money directly. They can only *request* an action, and the policy engine decides whether it runs now or waits for a human.

## Architecture

```
 Storefront (PayPal JS SDK) ──► Orders v2 create/capture ──┐
 PayPal webhooks ─────────────────────────────────────────┤
                                                           ▼
                                   ┌──────────── Express server ────────────┐
                                   │  Agents (Claude tool use)              │
                                   │   risk · dispute · billing · copilot   │
                                   │        │ tools                         │
                                   │        ▼                               │
                                   │  Signal engine   Policy engine ──► Approval queue
                                   │                       │                │
                                   │                       ▼                │
                                   │              PayPal gateway            │
                                   │     (REST sandbox │ built-in simulator)│
                                   └───────────┬────────────────────────────┘
                                               │ Server-sent events
                                               ▼
                         React dashboard: AG Grid, live agent feed, approvals
```

- `server/src/paypal/rest.ts` is a typed PayPal REST client covering OAuth, Orders, Payments, Invoicing, Disputes, Payouts and webhook signature verification.
- `server/src/paypal/simulator.ts` mirrors the same interface in memory, so the project runs end to end with no credentials.
- `server/src/agents/` holds the agent definitions and tools. They use the Anthropic SDK tool runner with adaptive thinking. The model's reasoning summaries and every tool call stream live into the dashboard feed.
- `server/src/risk.ts` is the deterministic signal engine: velocity, account age, IP, account and shipping country mismatch, disposable email, amount outliers, bulk quantity, account-takeover patterns and prior disputes. The AI reasons over these signals rather than guessing. When no API key is set, the same signals drive an offline rules engine.

## Run it locally

Requires Node 20+.

```bash
git clone <this repo> && cd sentinel-pay
npm install
cp .env.example .env      # optional: add PayPal sandbox + Anthropic keys
npm run dev               # API on :8787, dashboard on http://localhost:5173
```

The app runs in three configurations:

| `.env` | PayPal | AI |
|---|---|---|
| nothing | built-in simulator | offline rules engine |
| `ANTHROPIC_API_KEY` | built-in simulator | Claude agents |
| both PayPal sandbox keys + `ANTHROPIC_API_KEY` | **real PayPal sandbox** | Claude agents |

Production build (serves the dashboard from the API server):

```bash
npm run build && npm start   # http://localhost:8787
```

### Connecting the PayPal sandbox

1. At [developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox), create a sandbox REST app. Copy its Client ID and Secret into `.env`.
2. Set `PAYPAL_MERCHANT_EMAIL` to the app's sandbox business account email.
3. Optional: add a webhook pointing at `https://<your-host>/api/webhooks/paypal` for `PAYMENT.CAPTURE.COMPLETED` and `CUSTOMER.DISPUTE.CREATED`, and put its ID in `PAYPAL_WEBHOOK_ID`.
4. Open the **Storefront** tab and pay with a sandbox personal account. The real capture shows up in the Command Center and Risk Sentinel screens it within seconds. Refunds you approve on it are real sandbox refunds.

The seeded history (about 40 orders and 3 disputes for the demo shop "Nimbus Audio") and the traffic simulator buttons use the simulator gateway, because PayPal's sandbox can't produce card-testing bursts or account takeovers on demand. Anything that goes through real checkout uses the real sandbox APIs.

## Deploy

A `render.yaml` blueprint is included: on Render, choose **New → Blueprint**, point it at this repo, and fill in the secret env vars.

## AI tools used

- **Claude (Anthropic API, `claude-opus-5-5`)** powers all four agents through the Anthropic TypeScript SDK's tool runner. It uses adaptive thinking with summarized reasoning, which is shown live in the dashboard, and server-side refusal fallbacks.
- **Claude Code** was used as a pair programmer to build this project.

## Sponsor tools

- **AG Grid** for the transaction risk grid.
- **Render** for hosting (blueprint included).

## License

[MIT](LICENSE)
