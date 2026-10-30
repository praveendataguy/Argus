# 👁️ Argus

**An autonomous AI back office that guards a PayPal merchant account.**

*Named after Argus Panoptes, the hundred-eyed watchman of Greek myth: many agents, always watching, and a human holding the leash.*

Small online sellers lose money in three places: fraud they don't catch before shipping, disputes they don't have time to fight (or fight when they shouldn't), and billing that slips. Argus puts a team of AI agents in charge of the PayPal account, with a policy engine and a human approval queue in front of every dollar that moves.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

| Agent | Watches | Does | PayPal APIs |
|---|---|---|---|
| **Risk Watch** 🛡️ | Every captured payment | Scores fraud risk from deterministic signals plus reasoning, then allows, flags, holds or cancels and refunds | Orders v2, Payments v2 (refunds), Webhooks |
| **Dispute Agent** ⚖️ | Every PayPal dispute | Reads the case, tracking, support tickets and QA notes, estimates win probability, drafts the evidence response or recommends accepting | Disputes v1 (list, provide-evidence, accept-claim) |
| **Billing Agent** 🧾 | Free-text requests | Turns an email, note or voice transcript into a PayPal invoice | Invoicing v2 |
| **Argus Copilot** 💬 | The merchant | Answers questions and carries out instructions ("refund $20 on TX-1039", "pay our affiliate $40") | All of the above, plus Payouts v1 |
| **Ring Hunter** 🕸️ | Linked-account clusters | Decides fraud ring or benign household, holds and cancels ring orders | Payments v2 (refunds) |
| **Red team / Blue team** 🗡️🛡️ | The war game | Red invents attacks, blue writes and backtests new detection rules | (Argus scoring engine) |
| **Intent judge** 🧱 | Payments requested by other AI agents | Independently judges each payment against the owner's mandate | Payouts v1 |

### 🕸️ Fraud ring graph

Organised fraud spreads small, normal-looking orders across many fresh accounts. Argus links every account through the **device fingerprints, IP /24 ranges and normalised shipping addresses** it used (so "41 Larkin Street #3" and "41 Larkin St Apt 3" match). It runs union-find over the graph to find connected groups. The **Ring Hunter** agent investigates each ring and either clears it as a shared household or office, or holds every order in it and queues them for cancellation. The view is a live force-directed graph.

### 🗡️🛡️ AI vs AI fraud war game

A **red-team agent** reads what Argus is known to check and invents waves of synthetic fraud designed to slip past it. These include aged accounts, freight-forwarder drops, rotating addresses and residential proxies. Argus scores each wave mixed in with legitimate traffic. A **blue-team agent** studies the misses and writes new detection rules in a small, auditable rule language (`shipCity contains doral AND accountAgeDays gt 300`). Each rule is **backtested against real customer orders** and rejected if it would block more than 3% of them. The scoreboard shows how many attacks were caught on first contact and how many after learning. Every rule can be switched off by a human.

### 🧱 Agent payment firewall (MCP)

AI agents are starting to spend money, and a prompt injection on any web page they read can redirect it. Argus is an **MCP server** (`/mcp`, Streamable HTTP) that agents pay through instead of holding PayPal credentials. Each payment goes through five checks:

1. **Mandate**: the owner's stated purpose for this agent.
2. **Payee allowlist**: only approved PayPal merchants.
3. **Per-payment limit and monthly budget**: reserved on request and released if a human rejects.
4. **Injection scan**: catches instruction-override phrases, fake system notices, manufactured urgency, look-alike PayPal domains and "don't tell the user".
5. **Independent AI intent judge**: a separate model that never sees the agent's reasoning, only the mandate and the content the agent was reading.

Payments that pass are settled with **PayPal Payouts**. Large ones wait for a human, and anything suspicious is blocked. The dashboard can also run a live Claude agent against a poisoned order page to show the firewall stopping it.

Connect any MCP client:

```json
{ "mcpServers": { "argus-pay": { "type": "http", "url": "https://<your-host>/mcp" } } }
```

Tools: `argus_get_mandate(agentId)`, `argus_pay(agentId, payee, amount, purpose, context?)`.

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
git clone <this repo> && cd argus
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
4. Open the **Storefront** tab and pay with a sandbox personal account. The real capture shows up in the Command Center and Risk Watch screens it within seconds. Refunds you approve on it are real sandbox refunds.

The seeded history (about 40 orders and 3 disputes for the demo shop "Nimbus Audio") and the traffic simulator buttons use the simulator gateway, because PayPal's sandbox can't produce card-testing bursts or account takeovers on demand. Anything that goes through real checkout uses the real sandbox APIs.

## Deploy

A `render.yaml` blueprint is included: on Render, choose **New → Blueprint**, point it at this repo, and fill in the secret env vars.

## AI tools used

- **Claude (Anthropic API, `claude-opus-5-5`)** powers every agent through the Anthropic TypeScript SDK's tool runner. It uses adaptive thinking with summarized reasoning, which is shown live in the dashboard, and server-side refusal fallbacks.
- **Model Context Protocol** (`@modelcontextprotocol/sdk`) exposes the agent payment firewall to any MCP client.
- **Claude Code** was used as a pair programmer to build this project.

## Sponsor tools

- **AG Grid** for the transaction risk grid.
- **Render** for hosting (blueprint included).

## License

[MIT](LICENSE)
