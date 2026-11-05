# 👁️ Argus

**An autonomous AI back office that guards a PayPal merchant account.**

*Named after Argus Panoptes, the hundred-eyed watchman of Greek myth: many agents, always watching, and a human holding the leash.*

Small online sellers lose money in three places: fraud they don't catch before shipping, disputes they don't have time to fight (or fight when they shouldn't), and billing that slips. Argus puts a team of AI agents in charge of the PayPal account, with a policy engine and a human approval queue in front of every dollar that moves.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

## For judges: try it in two minutes

- **Hosted demo:** https://argus-j237.onrender.com (Render free tier, so the first load can take up to a minute while it wakes).
- **Run it yourself:** `git clone https://github.com/praveendataguy/Argus && cd argus && npm install && npm run dev`, then open http://localhost:5173. No keys are needed: without them Argus uses a built-in PayPal simulator and an offline rules engine, and every feature still works. Add a free Groq key and PayPal sandbox keys to `.env` for live AI and real sandbox payments (see [Run it locally](#run-it-locally)).
- **Then:** press **▶ Live demo** in the header for a narrated tour, or open the **Investigator** tab and press **Investigate suspicious** to watch Argus work fraud cases on its own.

| Agent | Watches | Does | PayPal APIs |
|---|---|---|---|
| **Risk Watch** 🛡️ | Every captured payment | Scores fraud risk from deterministic signals plus reasoning, then allows, flags, holds or cancels and refunds | Orders v2, Payments v2 (refunds), Webhooks |
| **Dispute Agent** ⚖️ | Every PayPal dispute | Reads the case, tracking, support tickets and QA notes, estimates win probability, drafts the evidence response or recommends accepting | Disputes v1 (list, provide-evidence, accept-claim) |
| **Billing Agent** 🧾 | Free-text requests | Turns an email, note or voice transcript into a PayPal invoice | Invoicing v2 |
| **Argus Copilot** 💬 | The merchant | Answers questions and carries out instructions ("refund $20 on TX-1039", "pay our affiliate $40") | All of the above, plus Payouts v1 |
| **Ring Hunter** 🕸️ | Linked-account clusters | Decides fraud ring or benign household, holds and cancels ring orders | Payments v2 (refunds) |
| **Red team / Blue team** 🗡️🛡️ | The war game | Red invents attacks, blue writes and backtests new detection rules | (Argus scoring engine) |
| **Investigator** 🕵️ | Every held or high-risk payment | Works the whole case on its own (order, history, signals, identity network, geography), reaches a verdict with a plain-English reason, then freezes rings, cancels, or releases | Orders v2, Payments v2 (refunds) |
| **Intent judge** 🧱 | Payments requested by other AI agents | Independently judges each payment against the owner's mandate | Payouts v1 |
| **Tribunal** ⚖️ (counsel, advocate, judge) | Disputes | Adversarial debate with an independent ruling that must flag unsupported claims | Disputes v1 |
| **ML model** 📈 | Every order, every war-game wave | Explainable second opinion, retrained after each round | — |

### 🎬 One-click live demo

The **▶ Live demo** button in the header runs a narrated, hands-free tour of everything Argus does in about two minutes. It launches a global attack storm, lets Risk Watch intercept it, hunts a fraud ring, plays a war-game round, hijacks an AI shopper with a poisoned page, convenes the dispute tribunal and re-verifies the audit chain. Captions appear on screen and the browser's own voice reads them aloud. Everything it triggers is real and goes through the same APIs as the buttons. Press → to skip a step, M to mute and Esc to stop.

### 🕵️ Autonomous fraud investigator

The **Investigator** tab works each suspicious payment the way a human analyst would, step by step and live on screen. Argus opens the PayPal order, pulls the buyer's history, scores the risk signals, sweeps the identity network for linked accounts, and traces the geography on a map (account country → checkout IP → parcel). It then reasons to a verdict (fraud, legitimate or needs a human) with a confidence and a plain-English "why", and acts on it. If the buyer is part of a ring, Argus freezes the whole ring and queues every order in it for cancellation. If the buyer is legitimate, it releases the hold so a good customer is not lost. The AI decides only the verdict; what each verdict is allowed to do is fixed in code, and every action runs through the approval policy and the signed audit log. Without an AI key, the rules engine reaches the verdict instead. Press **Investigate suspicious** to work the whole queue, or say "investigate" to the voice control.

### 🌍 Live threat globe

The Command Center has a 3D dot-matrix globe (Natural Earth land, rendered on canvas). Every PayPal capture flies from the buyer's real IP country to the shipping destination. Honest orders stay local and green, while attacks cross oceans in red to freight forwarders and reshippers. When Argus holds or cancels one, a shield burst marks the interception. Beside it are a DEFCON-style **threat level** for the last 15 minutes, the **hot corridors** (IP country → ship country) ranked by risk, and a **🌪️ global attack storm** button. The storm fires a burst of honest buyers from eight countries mixed with attacks from seven fraud hubs. Each payment is triaged in milliseconds by an edge pre-screen on the deterministic signal engine, and then Risk Watch reviews each one in full and has the final word. You can also say "launch an attack storm" to the voice control.

### 🕸️ Fraud ring graph

Organised fraud spreads small, normal-looking orders across many fresh accounts. Argus links every account through the **device fingerprints, IP /24 ranges and normalised shipping addresses** it used (so "41 Larkin Street #3" and "41 Larkin St Apt 3" match). It runs union-find over the graph to find connected groups. The **Ring Hunter** agent investigates each ring and either clears it as a shared household or office, or holds every order in it and queues them for cancellation. The view is a live force-directed graph.

### 🗡️🛡️ AI vs AI fraud war game

A **red-team agent** reads what Argus is known to check and invents waves of synthetic fraud designed to slip past it. These include aged accounts, freight-forwarder drops, rotating addresses and residential proxies. Argus scores each wave mixed in with legitimate traffic. A **blue-team agent** studies the misses and writes new detection rules in a small, auditable rule language (`shipCity contains doral AND accountAgeDays gt 300`). Each rule is **backtested against real customer orders** and rejected if it would block more than 3% of them. The scoreboard shows how many attacks were caught on first contact and how many after learning. Every rule can be switched off by a human.

### 🧱 Agent payment firewall (MCP)

AI agents are starting to spend money, and a prompt injection on any web page they read can redirect it. Argus is an **MCP server** (`/mcp`, Streamable HTTP) that agents pay through instead of holding PayPal credentials. Each payment goes through these checks:

0. **Signed mandate** (in the spirit of AP2, the Agent Payments Protocol): the owner signs each agent's spending mandate as an Ed25519 compact JWS. The signed credential, not the server's mutable record, sets the limits, so an agent that edits its own mandate ("forges a bigger mandate" in the demo) fails signature verification.
1. **Mandate**: the owner's stated purpose for this agent.
2. **Payee allowlist**: only approved PayPal merchants.
3. **Per-payment limit and monthly budget**: reserved on request and released if a human rejects.
4. **Injection scan**: catches instruction-override phrases, fake system notices, manufactured urgency, look-alike PayPal domains and "don't tell the user".
5. **Independent AI intent judge**: a separate model that never sees the agent's reasoning, only the mandate and the content the agent was reading.
6. **Replay protection**: each request can carry a single-use nonce. A captured request sent again is blocked.

Every settled payment gets a **receipt signed by Argus** (amount, payee, PayPal reference, mandate hash, checks passed). Public keys are at `/.well-known/jwks.json`, so anyone can verify mandates and receipts offline.

Payments that pass are settled with **PayPal Payouts**. Large ones wait for a human, and anything suspicious is blocked. The dashboard can also run a live AI agent against a poisoned order page to show the firewall stopping it.

Connect any MCP client:

```json
{ "mcpServers": { "argus-pay": { "type": "http", "url": "https://<your-host>/mcp" } } }
```

Tools: `argus_get_mandate(agentId)` (returns the signed `mandateToken`), `argus_pay(agentId, payee, amount, purpose, context?, mandateToken?, nonce?)` (returns the signed receipt).

### 🚩 Payout guard: stop payment redirection scams

The costliest scam for small businesses is an email that looks like a supplier's: "we changed our PayPal, please pay this account instead". Before any PayPal payout moves money, Argus checks it against the **payee book**:

- **Payee on file**: is this exactly the PayPal address we've paid before, or a new one claiming to be a known supplier?
- **Look-alike address**: `pebble-components.co` imitating `pebblecomponents.com`.
- **Recent detail change**: payout details changed in the last 14 days, and how the change arrived.
- **Redirection language**: "we moved banks", "pay this account instead", "please don't call", audit or same-day pressure.
- **Amount vs history**: more than twice what this payee is usually paid.

A flagged payout **never runs on its own**, in any autonomy mode, and approving it needs the operator's passkey at any amount. The approval card tells the operator to confirm by calling the number already on file. Try it on the Agent Firewall tab with **Scam email: "we changed our PayPal"**.

### 🔐 Trust center: verify, don't trust

- **Passkey step-up (WebAuthn)**: after an operator enrols a passkey, approving anything above `PASSKEY_STEP_UP_ABOVE` ($100) needs a fresh passkey assertion. The challenge is derived from the hash of that exact approval (id, kind, amount, payload), so what you see is what you sign, and a hijacked session or an edited request can't reuse it. Each step-up is written to the audit log.
- **Credential inspector**: paste any Argus token to verify it, or press *Tamper with it* to raise a limit inside a real mandate and watch the signature fail.
- **Transparency log**: the audit log is also an RFC 6962 Merkle tree. Argus signs a checkpoint (tree size and root) every 100 entries. With one checkpoint you can prove that any entry is in the log using about log₂(n) hashes, and the browser recomputes them with WebCrypto.

### ⚖️ AI tribunal for disputes

Before Argus commits to a dispute, two adversarial agents argue it. **Merchant's counsel** argues to contest and the **buyer's advocate** argues to refund. Each writes an opening brief and then rebuts the other. An independent **chief judge** rules on the record, gives a win probability, names the deciding facts and the strongest dissent, and has to call out any claim that the case file does not support. The ruling replaces any earlier single-agent recommendation in the approval queue.

### 📈 Explainable ML risk model

Next to the rules, Argus trains a logistic regression in-process on 14 interpretable features: account age, linked accounts, drop-address patterns, geo mismatches, velocity and others. It starts from the labelled seeded history and **retrains after every war-game round** on the wave it just saw. Each round records how the model scored attacks it had never been trained on. In the scripted game it flags waves 2 and 4 that the rules miss on first contact. Because the model is linear, each score splits exactly into per-feature log-odds contributions, and the transaction drawer shows that breakdown for every order.

### 🎙️ Voice command center

The 🎙️ button in the header uses the browser's Web Speech API. You can say "open fraud rings", "run a risk sweep", "play a war game round", "simulate a card-testing attack" or "verify the audit log", or ask the copilot anything. Voice is limited on purpose: it can never approve money or switch to Autopilot.

### 📈 Observability and tamper-evident audit

- **Hash-chained audit log** (`data/audit.jsonl`): every agent decision, tool call, approval and PayPal API call is appended with a SHA-256 hash that also covers the previous entry. **Verify chain** recomputes every link, so editing or deleting any past record is detected, along with exactly where. The log can be exported as JSONL.
- **Run traces**: each agent run records its model, steps, input, output and cache tokens, cost in USD, latency, and a span per tool call.
- **Metrics**: per-agent runs, average and p95 latency, errors and spend; per-endpoint PayPal call counts, latency and failures; and the split of money decisions made by policy versus by a human.
- **Optional Elastic sink**: set `ELASTIC_URL` and `ELASTIC_API_KEY` and audit entries are bulk-indexed into Elastic (`argus-audit`) for search and dashboards.

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
                                   │  Agents (Groq / Claude tool use)       │
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
- `server/src/agents/` holds the agent definitions and tools. On Claude they use the Anthropic SDK tool runner with adaptive thinking; on Groq the same tools run through OpenAI-style function calling (`agents/groq.ts`). The model's reasoning summaries and every tool call stream live into the dashboard feed.
- `server/src/risk.ts` is the deterministic signal engine: velocity, account age, IP, account and shipping country mismatch, disposable email, amount outliers, bulk quantity, account-takeover patterns and prior disputes. The AI reasons over these signals rather than guessing. When no API key is set, the same signals drive an offline rules engine.

## Run it locally

Requires Node 20+.

```bash
git clone <this repo> && cd argus
npm install
cp .env.example .env      # optional: add PayPal sandbox keys and a free Groq key
npm run dev               # API on :8787, dashboard on http://localhost:5173
```

The app runs in three configurations:

| `.env` | PayPal | AI |
|---|---|---|
| nothing | built-in simulator | offline rules engine + ML model |
| `GROQ_API_KEY` (free) | built-in simulator | agents on Groq (`openai/gpt-oss-120b`) |
| `ANTHROPIC_API_KEY` | built-in simulator | agents on Claude |
| both PayPal sandbox keys + an AI key | **real PayPal sandbox** | AI agents |

If both AI keys are set, Claude is used. Change the Groq model with `GROQ_MODEL`. A free Groq key is available at [console.groq.com/keys](https://console.groq.com/keys).

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

- **Groq (`openai/gpt-oss-120b`, free tier)** is the default model provider. Every agent, the investigator's verdicts, the intent judge and the tribunal run on it through OpenAI-compatible function calling and JSON-mode structured output. Its reasoning is shown live in the dashboard.
- **Claude (Anthropic API)** is the alternative provider. It is used when `ANTHROPIC_API_KEY` is set, through the Anthropic TypeScript SDK's tool runner with adaptive thinking.
- **In-process ML**: a logistic-regression fraud model trained and retrained in the app, with exact per-feature attributions.
- **Model Context Protocol** (`@modelcontextprotocol/sdk`) exposes the agent payment firewall to any MCP client.
- **Claude Code** was used as a pair programmer to build this project.

## Sponsor tools

- **AG Grid** for the transaction risk grid.
- **Elastic** (optional) as the audit log sink.
- **Render** for hosting (blueprint included).

## License

[MIT](LICENSE)
