#!/usr/bin/env node
/**
 * @tradallo/reputation
 *
 * Dual-mode binary:
 *   - With CLI subcommand args (`card`, `track-record`, `search`, ...) → CLI mode
 *   - Without args → MCP stdio server (Claude Desktop, Cursor, generic MCP)
 *
 * Both modes use the same TradalloClient and the same signature-verification
 * pipeline. Every response — whether rendered as a card, returned as JSON,
 * or relayed to an LLM via MCP — has been JCS-canonicalized and
 * ed25519-verified against Tradallo's published pubkey at /.well-known/.
 *
 * Tools (MCP mode):
 *   - get_track_record(handle, principal_type?)
 *   - search_records(filters)
 *   - get_versions(agent_handle)
 *   - get_utrs(agent_handle, since?, limit?)
 *   - verify_utr(utr_hash, agent_handle)
 *
 * Subcommands (CLI mode): see `npx @tradallo/reputation help`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TradalloClient } from "./client.js";
import { isCliInvocation, runCli } from "./cli.js";

// ─── CLI fast-path ──────────────────────────────────────────────────────
// If we were invoked with a recognized subcommand, run it and exit before
// the MCP server tries to claim stdin. Otherwise fall through to MCP mode.
if (isCliInvocation(process.argv)) {
  await runCli(process.argv);
  process.exit(0);
}

const TRADALLO_BASE = process.env.TRADALLO_BASE_URL ?? "https://tradallo.com";
const client = new TradalloClient({ baseUrl: TRADALLO_BASE });

const server = new Server(
  { name: "tradallo-reputation", version: "0.3.1" },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ─── Tool catalog ───────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_track_record",
      description:
        "Fetch a verified trading track record for a Tradallo profile (human) or agent. Returns cryptographically-verified statistics (Sharpe, win rate, max drawdown, PnL, trade count) computed from on-chain or in-house-sim trade history. The signature is ed25519-verified against Tradallo's published pubkey before this tool returns.",
      inputSchema: {
        type: "object",
        properties: {
          handle: {
            type: "string",
            description:
              "The Tradallo handle to look up (e.g. 'aaronjordan' for a human, 'alpha-momentum-v3' for an agent).",
          },
          principal_type: {
            type: "string",
            enum: ["human", "agent"],
            description:
              "Whether the handle is a human profile or an agent. Defaults to 'agent' (the more common reputation-query use case).",
          },
        },
        required: ["handle"],
      },
    },
    {
      name: "search_records",
      description:
        "Search verified trading records by performance filters (Sharpe, max drawdown, trade count, venue, principal type). Returns a list of summary records sorted by the chosen metric. Useful for an agent shopping for strategies that meet specific risk/return criteria. The response is signature-verified against Tradallo's published pubkey before being returned.",
      inputSchema: {
        type: "object",
        properties: {
          min_sharpe: { type: "number", description: "Minimum annualized Sharpe ratio." },
          min_trades: { type: "integer", description: "Minimum trade count." },
          max_drawdown: { type: "number", description: "Maximum drawdown as a fraction (e.g. 0.25 for 25%)." },
          venue: { type: "string", description: "Restrict to a specific venue (e.g. 'hyperliquid', 'dydx')." },
          principal_type: { type: "string", enum: ["human", "agent"] },
          sort_by: {
            type: "string",
            enum: ["sharpe", "net_pnl", "trade_count", "win_rate"],
            description: "Field to sort results by (descending). Default: net_pnl.",
          },
          limit: { type: "integer", description: "Max results (default 25, max 100)." },
        },
      },
    },
    {
      name: "verify_utr",
      description:
        "Look up a Universal Trade Receipt by hash. Returns whether Tradallo has anchored that hash on-chain via a Solana memo transaction, and if so, returns the chain, signature, slot, posted_at, explorer URL, and notarizer pubkey so the caller can independently verify the anchor on Solana Explorer. The signed-envelope response is ed25519-verified before this tool returns.",
      inputSchema: {
        type: "object",
        properties: {
          utr_hash: {
            type: "string",
            description: "The 64-char hex SHA-256 UTR hash to look up.",
          },
        },
        required: ["utr_hash"],
      },
    },
    {
      name: "get_versions",
      description:
        "Fetch the full version history of an agent (semver tags, version_hash, policy_hash, when each version was deployed and superseded). Useful for understanding which version of an agent's policy produced a given track record. The response is signature-verified.",
      inputSchema: {
        type: "object",
        properties: {
          agent_handle: { type: "string", description: "The agent's handle." },
        },
        required: ["agent_handle"],
      },
    },
    {
      name: "get_utrs",
      description:
        "Fetch raw Universal Trade Receipts for an agent. Each UTR is a v2 canonical receipt with its SHA-256 hash recomputed by Tradallo so consumers can spot-check individual receipts. Paginated cursor-style on closed_at.",
      inputSchema: {
        type: "object",
        properties: {
          agent_handle: { type: "string", description: "The agent's handle." },
          since: {
            type: "string",
            description: "ISO timestamp; only return UTRs closed at or after this. Defaults to the agent's anchor.",
          },
          limit: { type: "integer", description: "Page size (default 100, max 500)." },
        },
        required: ["agent_handle"],
      },
    },
  ],
}));

// ─── Tool dispatcher ────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_track_record": {
        const handle = String((args as { handle?: unknown })?.handle ?? "").trim();
        const principal_type =
          ((args as { principal_type?: unknown })?.principal_type as
            | "human"
            | "agent"
            | undefined) ?? "agent";
        if (!handle) {
          return errorResult("handle is required");
        }
        const path =
          principal_type === "human"
            ? `/api/v1/profiles/${encodeURIComponent(handle)}/track-record`
            : `/api/v1/agents/${encodeURIComponent(handle)}/track-record`;
        const data = await client.getSigned<unknown>(path);
        return jsonResult(data);
      }

      case "search_records": {
        const params = new URLSearchParams();
        const a = (args ?? {}) as Record<string, unknown>;
        if (typeof a.principal_type === "string") params.set("principal_type", a.principal_type);
        if (typeof a.min_sharpe === "number") params.set("min_sharpe", String(a.min_sharpe));
        if (typeof a.min_trades === "number") params.set("min_trades", String(a.min_trades));
        if (typeof a.max_drawdown === "number") params.set("max_drawdown", String(a.max_drawdown));
        if (typeof a.venue === "string") params.set("venue", a.venue);
        if (typeof a.sort_by === "string") params.set("sort_by", a.sort_by);
        if (typeof a.limit === "number") params.set("limit", String(a.limit));
        const path = `/api/v1/search${params.toString() ? `?${params.toString()}` : ""}`;
        const data = await client.getSigned<unknown>(path);
        return jsonResult(data);
      }

      case "verify_utr": {
        const utr_hash = String((args as { utr_hash?: unknown })?.utr_hash ?? "")
          .trim()
          .toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(utr_hash)) {
          return errorResult("utr_hash must be a 64-char SHA-256 hex string");
        }
        // Direct lookup against the public notarization endpoint. The
        // TradalloClient verifies the ed25519 signature before returning
        // the payload, so the MCP layer can trust the booleans below.
        const data = await client.getSigned<{
          utr_hash: string;
          found: boolean;
          anchored_on_chain: boolean;
          chain?: string;
          signature?: string;
          slot?: number;
          posted_at?: string;
          explorer_url?: string;
          notarizer_pubkey?: string;
        }>(`/api/v1/utrs/${encodeURIComponent(utr_hash)}/notarization`);
        return jsonResult(data);
      }

      case "get_versions": {
        const handle = String((args as { agent_handle?: unknown })?.agent_handle ?? "").trim();
        if (!handle) return errorResult("agent_handle is required");
        const data = await client.getSigned<unknown>(
          `/api/v1/agents/${encodeURIComponent(handle)}/versions`,
        );
        return jsonResult(data);
      }

      case "get_utrs": {
        const handle = String((args as { agent_handle?: unknown })?.agent_handle ?? "").trim();
        if (!handle) return errorResult("agent_handle is required");
        const qs = new URLSearchParams();
        const sinceArg = (args as { since?: unknown })?.since;
        const limitArg = (args as { limit?: unknown })?.limit;
        if (typeof sinceArg === "string") qs.set("since", sinceArg);
        if (typeof limitArg === "number") qs.set("limit", String(limitArg));
        const path = `/api/v1/agents/${encodeURIComponent(handle)}/utrs${qs.toString() ? `?${qs.toString()}` : ""}`;
        const data = await client.getSigned<unknown>(path);
        return jsonResult(data);
      }

      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  }
});

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

// ─── Start ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
// Server runs over stdio — no console.log here, that would corrupt the MCP
// protocol stream. Errors go to stderr via the SDK's logging.
