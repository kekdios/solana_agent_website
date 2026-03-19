/**
 * MCP server for Solana Agent website API.
 * Exposes tools for swap (SOL→BTC).
 * Run: node mcp-server.cjs (stdio) or set API_BASE_URL for a different API origin.
 */
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const API_BASE = (process.env.API_BASE_URL || "https://www.solanaagent.app").replace(/\/$/, "");

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = { raw: text };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, ...body };
  }
  return { ok: true, status: res.status, ...body };
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, ...data };
  }
  return { ok: true, status: res.status, ...data };
}

const server = new McpServer({
  name: "solana-agent-website",
  version: "1.0.0",
});

// ---- Reserves ----
server.tool(
  "get_reserves",
  "Get Bitcoin and Solana reserve addresses and balances.",
  z.object({}),
  async () => {
    const out = await apiGet("/api/reserves");
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  }
);

// ---- Swap (SOL → BTC) ----
server.tool(
  "swap_min",
  "Get minimum SOL amount and current reserve SOL balance for SOL→BTC swap.",
  z.object({}),
  async () => {
    const out = await apiGet("/api/swap/min");
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  }
);

server.tool(
  "swap_estimate",
  "Get estimated BTC (sats) for a given SOL amount.",
  z.object({
    amount_sol: z.number().positive().describe("Amount of SOL to swap"),
  }),
  async ({ amount_sol }) => {
    const out = await apiGet(`/api/swap/estimate?amountSol=${encodeURIComponent(amount_sol)}`);
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  }
);

server.tool(
  "swap_create",
  "Create a reserve SOL→BTC swap. Returns immediately with tx id; poll swap_status for completion.",
  z.object({
    amount_sol: z.number().positive().describe("Amount of SOL to swap"),
  }),
  async ({ amount_sol }) => {
    const out = await apiPost("/api/swap/create", { amountSol: amount_sol });
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  }
);

server.tool(
  "swap_status",
  "Poll swap status by Solana transaction signature (id from swap_create).",
  z.object({
    id: z.string().describe("Solana transaction signature (id from swap_create)"),
  }),
  async ({ id }) => {
    const out = await apiGet(`/api/swap/status/${encodeURIComponent(id)}`);
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
