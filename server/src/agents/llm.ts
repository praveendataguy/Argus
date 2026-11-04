import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config } from "../config.js";
import { endRun, recordTool, recordUsage, startRun } from "../observability.js";
import { newId, store } from "../store.js";
import { GroqToolCallError, groqChat, groqStructured, usageOf, type ChatMessage } from "./groq.js";

export const client = config.ai.provider === "anthropic" ? new Anthropic() : null;
/** True when any model provider is configured (Claude or Groq). */
export const aiEnabled = config.ai.provider !== null;

export interface ToolContext {
  agent: string;
  runId: string;
}

/**
 * Defines a tool whose calls and results stream into the live agent feed.
 * The factory takes the run context so every log line is tagged with its run.
 */
export function defineTool<S extends z.ZodObject>(spec: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}) {
  return (ctx: ToolContext) =>
    betaZodTool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      run: async (input) => {
        store.log({ agent: ctx.agent, kind: "tool", runId: ctx.runId, message: `→ ${spec.name}(${summarise(input)})` });
        const t0 = Date.now();
        try {
          const result = await spec.run(input as z.infer<S>, ctx);
          recordTool(ctx.runId, { name: spec.name, ms: Date.now() - t0, ok: true });
          return typeof result === "string" ? result : JSON.stringify(result, null, 1);
        } catch (err) {
          recordTool(ctx.runId, { name: spec.name, ms: Date.now() - t0, ok: false });
          const message = err instanceof Error ? err.message : String(err);
          store.log({ agent: ctx.agent, kind: "error", runId: ctx.runId, message: `${spec.name} failed: ${message}` });
          return `ERROR: ${message}`;
        }
      },
    });
}

function summarise(input: unknown) {
  const s = JSON.stringify(input);
  return s.length > 140 ? s.slice(0, 137) + "…" : s;
}

// Tools with different input types share one list.
/** Traces an offline rules-engine run the same way as an AI run. */
export async function runHeuristic<T extends { text: string }>(agent: string, task: string, fn: (runId: string) => Promise<T>): Promise<T & { runId: string }> {
  const runId = newId("RUN");
  startRun(runId, agent, task, "rules-engine");
  try {
    const out = await fn(runId);
    endRun(runId, "ok", out.text);
    return { ...out, runId };
  } catch (err) {
    endRun(runId, "error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export type ToolFactory = (ctx: ToolContext) => BetaRunnableTool<any>;

export interface AgentSpec {
  name: string;
  system: string;
  tools: ToolFactory[];
  effort?: "low" | "medium" | "high";
}

/** Runs one agent to completion with Claude, streaming its reasoning and tool calls to the feed. */
export async function runAgent(spec: AgentSpec, task: string): Promise<{ runId: string; text: string }> {
  if (!aiEnabled) throw new Error("No AI provider configured (set GROQ_API_KEY or ANTHROPIC_API_KEY)");
  const runId = newId("RUN");
  const ctx: ToolContext = { agent: spec.name, runId };
  store.log({ agent: spec.name, kind: "info", runId, message: `Started: ${task.split("\n")[0].slice(0, 160)}` });
  startRun(runId, spec.name, task);
  if (!client) return runGroqAgent(spec, task, ctx);

  const runner = client.beta.messages.toolRunner({
    model: config.ai.model,
    max_tokens: 16000,
    max_iterations: 12,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: spec.effort ?? "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: spec.system,
    tools: spec.tools.map((t) => t(ctx)),
    messages: [{ role: "user", content: task }],
  });

  let text = "";
  let status: "ok" | "refused" = "ok";
  try {
    for await (const message of runner) {
      recordUsage(runId, message.usage);
      if (message.stop_reason === "refusal") {
        store.log({ agent: spec.name, kind: "error", runId, message: "The model declined this request." });
        status = "refused";
        break;
      }
      for (const block of message.content) {
        if (block.type === "thinking" && block.thinking.trim())
          store.log({ agent: spec.name, kind: "thinking", runId, message: block.thinking.trim().slice(0, 600) });
        if (block.type === "text" && block.text.trim()) text = block.text.trim();
      }
    }
  } catch (err) {
    endRun(runId, "error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  endRun(runId, status, text);
  if (text) store.log({ agent: spec.name, kind: "decision", runId, message: text.slice(0, 800) });
  return { runId, text };
}

/**
 * Prepares a tool's JSON Schema for Groq. Open models fill long arrays of objects
 * unreliably, and Groq rejects the whole turn over any nested mismatch, so:
 * $ref definitions are inlined (gpt-oss reads an inline schema far better), and
 * nested required/additionalProperties are dropped. The tool's zod schema still
 * validates locally and its error goes back to the model as the tool result,
 * naming exactly which field to fix.
 */
function groqSchema(schema: unknown): unknown {
  const defs = ((schema as { $defs?: Record<string, unknown> })?.$defs ?? {}) as Record<string, unknown>;
  const walk = (node: unknown, depth: number, seen: Set<string>): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, depth, seen));
    if (!node || typeof node !== "object") return node;
    const ref = (node as { $ref?: string }).$ref;
    if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
      const name = ref.slice("#/$defs/".length);
      if (!seen.has(name) && defs[name]) return walk(defs[name], depth, new Set(seen).add(name));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$defs" || k === "$schema") continue;
      if (depth > 0 && (k === "required" || k === "additionalProperties")) continue;
      out[k] = k === "properties" && v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv, depth + 1, seen)]))
        : walk(v, depth, seen);
    }
    return out;
  };
  return walk(schema, 0, new Set());
}

/** The same agent loop on Groq: OpenAI-style function calling over the same tools. */
async function runGroqAgent(spec: AgentSpec, task: string, ctx: ToolContext): Promise<{ runId: string; text: string }> {
  const { runId } = ctx;
  const tools = spec.tools.map((t) => t(ctx));
  const messages: ChatMessage[] = [
    { role: "system", content: `${spec.system}\n\nUse the tools to act; never claim an action happened unless a tool result says so. When you are finished, reply with a short final answer and no tool call.` },
    { role: "user", content: task },
  ];
  const chatTools = tools.map((t) => { const d = t as unknown as { name: string; description?: string; input_schema: unknown }; return { type: "function" as const, function: { name: d.name, description: d.description ?? "", parameters: groqSchema(d.input_schema) } }; });
  let text = "";
  let repairs = 0;
  try {
    for (let step = 0; step < 12; step++) {
      let res: Awaited<ReturnType<typeof groqChat>>;
      try {
        res = await groqChat({ messages, tools: chatTools, maxTokens: 8000 });
      } catch (err) {
        if (!(err instanceof GroqToolCallError) || repairs >= 3) throw err;
        repairs++;
        store.log({ agent: spec.name, kind: "thinking", runId, message: `Tool call rejected by schema validation, retrying: ${err.message.slice(0, 200)}` });
        messages.push({ role: "user", content: `Your last tool call was rejected and did not run: ${err.message}\nCall the tool again, filling in every required field for every item, exactly as the tool's JSON schema specifies.` });
        continue;
      }
      recordUsage(runId, usageOf(res));
      const msg = res.choices[0]?.message;
      if (!msg) break;
      if (msg.reasoning?.trim()) store.log({ agent: spec.name, kind: "thinking", runId, message: msg.reasoning.trim().slice(0, 600) });
      if (msg.content?.trim()) text = msg.content.trim();
      if (!msg.tool_calls?.length) break;
      messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        const tool = tools.find((t) => t.name === call.function.name);
        let output: string;
        try {
          if (!tool) throw new Error(`Unknown tool ${call.function.name}`);
          const result = await tool.run(tool.parse(JSON.parse(call.function.arguments || "{}")));
          output = typeof result === "string" ? result : JSON.stringify(result);
        } catch (err) {
          output = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }
    }
  } catch (err) {
    endRun(runId, "error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  endRun(runId, "ok", text);
  if (text) store.log({ agent: spec.name, kind: "decision", runId, message: text.slice(0, 800) });
  return { runId, text };
}

/** One structured-output call (judge, tribunal), traced like an agent run, on whichever provider is configured. */
export async function structured<T extends z.ZodType>(opts: {
  agent: string;
  task: string;
  system: string;
  user: string;
  schema: T;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}): Promise<z.infer<T>> {
  if (!aiEnabled) throw new Error("No AI provider configured");
  const runId = newId("RUN");
  startRun(runId, opts.agent, opts.task);
  try {
    let out: z.infer<T>;
    if (client) {
      const res = await client.messages.parse({
        model: config.ai.model,
        max_tokens: opts.maxTokens ?? 4000,
        output_config: { effort: opts.effort ?? "medium", format: zodOutputFormat(opts.schema) },
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
      });
      recordUsage(runId, res.usage);
      if (!res.parsed_output) throw new Error(res.stop_reason === "refusal" ? "The model declined" : "No structured output");
      out = res.parsed_output as z.infer<T>;
    } else {
      out = await groqStructured(opts.system, opts.user, opts.schema, (u) => recordUsage(runId, u));
    }
    endRun(runId, "ok", JSON.stringify(out).slice(0, 300));
    return out;
  } catch (err) {
    endRun(runId, "error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}
