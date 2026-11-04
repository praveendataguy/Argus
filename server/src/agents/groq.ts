import { z } from "zod";
import { config } from "../config.js";

/**
 * Groq backend (OpenAI-compatible Chat Completions), used when GROQ_API_KEY is
 * set and no Anthropic key is. Free tier friendly: the same agents, tools and
 * guardrails run on an open model served by Groq.
 */

const URL = `${process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1"}/chat/completions`;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  reasoning?: string;
}

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

interface ChatResponse {
  choices: { message: ChatMessage; finish_reason: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Parses Groq durations such as "7.55s", "1m2.5s" or "450ms" into milliseconds. */
function parseDuration(v: string | null | undefined): number | null {
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Number(v) * 1000;
  let ms = 0;
  let matched = false;
  for (const [, n, unit] of v.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    ms += Number(n) * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
  }
  return matched ? ms : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/*
 * The free tier allows only a few thousand tokens per minute, and several agents
 * (tribunal, war game, risk sweep) can run at once. Calls go through one queue,
 * and when Groq reports the token budget is nearly spent the next call waits for
 * the reset instead of failing with a 429 halfway through an agent's run.
 */
let queue: Promise<unknown> = Promise.resolve();
let notBefore = 0;
const LOW_WATER_TOKENS = Number(process.env.GROQ_LOW_WATER_TOKENS ?? 2500);

export function groqChat(body: { messages: ChatMessage[]; tools?: ChatTool[]; json?: boolean; maxTokens?: number }): Promise<ChatResponse> {
  const run = queue.then(() => groqChatNow(body));
  queue = run.catch(() => undefined);
  return run;
}

async function groqChatNow(body: { messages: ChatMessage[]; tools?: ChatTool[]; json?: boolean; maxTokens?: number }): Promise<ChatResponse> {
  for (let attempt = 0; ; attempt++) {
    const delay = notBefore - Date.now();
    if (delay > 0) await sleep(delay);
    const res = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ai.model,
        messages: body.messages,
        tools: body.tools?.length ? body.tools : undefined,
        tool_choice: body.tools?.length ? "auto" : undefined,
        response_format: body.json ? { type: "json_object" } : undefined,
        max_completion_tokens: body.maxTokens ?? 4000,
        temperature: 0.3,
      }),
    });
    const remaining = Number(res.headers.get("x-ratelimit-remaining-tokens") ?? NaN);
    const reset = parseDuration(res.headers.get("x-ratelimit-reset-tokens"));
    if (Number.isFinite(remaining) && remaining < LOW_WATER_TOKENS && reset) notBefore = Date.now() + reset + 250;

    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const text = await res.text();
      const hinted = parseDuration(res.headers.get("retry-after")) ?? parseDuration(/try again in ([\d.hms]+)/i.exec(text)?.[1]);
      const wait = Math.min(65_000, (hinted ?? 2 ** attempt * 2000) + 500);
      notBefore = Math.max(notBefore, Date.now() + wait);
      continue;
    }
    if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as ChatResponse;
  }
}

export const usageOf = (r: ChatResponse) => ({ input_tokens: r.usage?.prompt_tokens ?? 0, output_tokens: r.usage?.completion_tokens ?? 0 });

/** JSON-mode call validated against a zod schema; one repair attempt if the output doesn't fit. */
export async function groqStructured<T extends z.ZodType>(system: string, user: string, schema: T, onUsage: (u: ReturnType<typeof usageOf>) => void): Promise<z.infer<T>> {
  const shape = JSON.stringify(z.toJSONSchema(schema));
  const messages: ChatMessage[] = [
    { role: "system", content: `${system}\n\nReply with a single JSON object that matches this JSON Schema, and nothing else:\n${shape}` },
    { role: "user", content: user },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await groqChat({ messages, json: true });
    onUsage(usageOf(res));
    const text = res.choices[0]?.message.content ?? "";
    try {
      return schema.parse(JSON.parse(text));
    } catch (err) {
      messages.push({ role: "assistant", content: text }, { role: "user", content: `That did not match the schema (${err instanceof Error ? err.message.slice(0, 300) : err}). Reply again with only the corrected JSON object.` });
    }
  }
  throw new Error("Model did not return valid structured output");
}
