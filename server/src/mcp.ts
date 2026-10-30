import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mandates, payees, requestAgentPayment } from "./firewall.js";

/**
 * Argus as an MCP server: any MCP-capable agent (Claude Desktop, Claude Code,
 * custom agents) can pay through PayPal without ever holding PayPal
 * credentials, and every payment passes the firewall.
 */
export function createMcpServer() {
  const server = new McpServer({ name: "argus-pay", version: "0.1.0" });

  server.registerTool(
    "argus_get_mandate",
    {
      title: "Get spending mandate",
      description: "Show what this agent is allowed to spend on: purpose, limits, remaining budget and allowed payees.",
      inputSchema: { agentId: z.string() },
    },
    async ({ agentId }) => {
      const m = mandates.find((x) => x.agentId === agentId);
      const text = m
        ? JSON.stringify({ ...m, remaining: m.monthlyBudget - m.spent, payees: payees.filter((p) => m.allowedPayees.includes(p.id)) }, null, 2)
        : `No mandate for ${agentId}.`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "argus_pay",
    {
      title: "Pay with PayPal through Argus",
      description:
        "Request a PayPal payment. Argus checks it against your owner's mandate, scans it for prompt injection and has an independent model judge the intent before settling. Include the page or message that led to the payment in `context` — payments without context are judged more strictly.",
      inputSchema: {
        agentId: z.string(),
        payee: z.string().describe("Payee id from argus_get_mandate, or a PayPal email"),
        amount: z.number().positive(),
        purpose: z.string(),
        context: z.string().optional(),
      },
    },
    async (input) => {
      const p = await requestAgentPayment(input);
      const lines = [
        `Verdict: ${p.verdict.toUpperCase()}`,
        ...p.checks.map((c) => `${c.pass ? "✓" : "✗"} ${c.name}: ${c.detail}`),
        p.reference ? `Reference: ${p.reference}` : "",
        p.verdict === "held" ? "A human must approve this payment in the Argus dashboard." : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }], isError: p.verdict === "blocked" };
    },
  );

  return server;
}
