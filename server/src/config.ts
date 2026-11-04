import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Read .env from the repo root whichever directory the server is started from.
dotenv.config({ path: [resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"), ".env"], quiet: true });

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8787}`,

  paypal: {
    clientId: env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: env.PAYPAL_CLIENT_SECRET ?? "",
    webhookId: env.PAYPAL_WEBHOOK_ID ?? "",
    baseUrl: env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com",
    merchantEmail: env.PAYPAL_MERCHANT_EMAIL ?? "merchant@arguspay.example",
  },

  anthropic: {
    enabled: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
  },

  // Claude when an Anthropic key is set, otherwise Groq's free tier when GROQ_API_KEY is set, otherwise the rules engine.
  ai: (() => {
    const provider: "anthropic" | "groq" | null = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? "anthropic" : env.GROQ_API_KEY ? "groq" : null;
    const model = provider === "groq" ? (env.GROQ_MODEL ?? "openai/gpt-oss-120b") : (env.ARGUS_MODEL ?? "claude-opus-5-5");
    return { provider, model };
  })(),

  policy: {
    // Money-moving actions at or below this amount run without a human when autonomy is "guarded".
    autoApproveLimit: Number(env.AUTO_APPROVE_LIMIT ?? 25),
    // Transactions scoring at or above this are held for review.
    holdThreshold: Number(env.RISK_HOLD_THRESHOLD ?? 70),
    currency: env.CURRENCY ?? "USD",
  },
};

export const paypalMode: "sandbox" | "simulator" =
  config.paypal.clientId && config.paypal.clientSecret ? "sandbox" : "simulator";
