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

export async function groqChat(body: { messages: ChatMessage[]; tools?: ChatTool[]; json?: boolean; maxTokens?: number }): Promise<ChatResponse> {
  for (let attempt = 0; ; attempt++) {
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
    // Free-tier rate limits: back off and retry a few times.
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get("retry-after") ?? 2 ** attempt * 2);
      await new Promise((r) => setTimeout(r, Math.min(20, wait) * 1000));
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
