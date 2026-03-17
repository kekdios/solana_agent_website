/**
 * MCP server for Solana Agent website API.
 * Exposes tools for swap (SOL→BTC) and token creation (invoices).
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

// ---- Token creation (invoices) ----
server.tool(
  "create_token_invoice",
  "Create an invoice for token creation. Returns invoice_id, address (treasury), amount (SOL). User must pay then call confirm_invoice.",
  z.object({
    name: z.string().describe("Token name"),
    symbol: z.string().describe("Token symbol"),
    creator_address: z.string().describe("SOL address to receive minted supply"),
    decimals: z.number().min(0).max(9).optional().default(9),
    supply: z.string().optional().default("0"),
    description: z.string().optional(),
  }),
  async (args) => {
    const body = {
      name: args.name,
      symbol: args.symbol,
      creator_address: args.creator_address,
      decimals: args.decimals,
      supply: args.supply,
      description: args.description,
    };
    const out = await apiPost("/api/invoices", body);
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  }
);

server.tool(
  "get_invoice",
  "Get invoice status by invoice_id (UUID).",
  z.object({
    invoice_id: z.string().uuid().describe("Invoice UUID from create_token_invoice"),
  }),
  async ({ invoice_id }) => {
    const out = await apiGet(`/api/invoices/${encodeURIComponent(invoice_id)}`);
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  }
);

server.tool(
  "confirm_invoice",
  "Confirm invoice payment. Pass invoice_id and Solana tx signature that sent the fee to the treasury. Idempotent if already completed.",
  z.object({
    invoice_id: z.string().uuid().describe("Invoice UUID"),
    tx_signature: z.string().describe("Solana transaction signature of the payment"),
  }),
  async ({ invoice_id, tx_signature }) => {
    const out = await apiPost("/api/invoices/confirm", {
      invoice_id,
      tx_signature,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  }
);

server.tool(
  "get_token",
  "Get token by numeric id (e.g. from confirm_invoice response).",
  z.object({
    token_id: z.number().int().positive().describe("Token ID"),
  }),
  async ({ token_id }) => {
    const out = await apiGet(`/api/tokens/${token_id}`);
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
