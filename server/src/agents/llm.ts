import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { z } from "zod";
import { config } from "../config.js";
import { endRun, recordTool, recordUsage, startRun } from "../observability.js";
import { newId, store } from "../store.js";

export const client = config.anthropic.enabled ? new Anthropic() : null;

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
  if (!client) throw new Error("No Anthropic credentials configured");
  const runId = newId("RUN");
  const ctx: ToolContext = { agent: spec.name, runId };
  store.log({ agent: spec.name, kind: "info", runId, message: `Started: ${task.split("\n")[0].slice(0, 160)}` });
  startRun(runId, spec.name, task);

  const runner = client.beta.messages.toolRunner({
    model: config.anthropic.model,
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
