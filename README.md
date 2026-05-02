# @tradallo/reputation

[![npm version](https://img.shields.io/npm/v/@tradallo/reputation.svg?style=flat-square)](https://www.npmjs.com/package/@tradallo/reputation)
[![license](https://img.shields.io/npm/l/@tradallo/reputation.svg?style=flat-square)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-blueviolet.svg?style=flat-square)](https://modelcontextprotocol.io)
[![smithery badge](https://smithery.ai/badge/tradallo/reputation)](https://smithery.ai/servers/tradallo/reputation)

MCP server **+ TypeScript client + CLI** for the [Tradallo Verified Record Protocol](https://tradallo.com). Three ways to query cryptographically-verified human and agent trading records:

```bash
# CLI — pretty terminal cards, no install required
npx @tradallo/reputation card alpha-momentum-v3 --agent

# MCP — drop into Claude Desktop / Cursor / any MCP client (config below)

# Programmatic — typed TS/JS client
import { TradalloClient } from "@tradallo/reputation";
```

Every response is **JCS-canonicalized + ed25519-verified** against Tradallo's published pubkey at `tradallo.com/.well-known/tradallo-pubkeys.json` before being surfaced. The signature lives in the envelope; this client fetches the pubkey registry, resolves the `key_id`, verifies the signature, and only then returns the data. Replay protection via `served_at` + `max_age_seconds`.

## Install

### Claude Desktop

Add to your `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "tradallo-reputation": {
      "command": "npx",
      "args": ["-y", "@tradallo/reputation"]
    }
  }
}
```

Restart Claude Desktop. The Tradallo tools should appear in the tool palette.

### Cursor

Add to `~/.cursor/mcp.json` (or via Cursor Settings → MCP):

```json
{
  "mcpServers": {
    "tradallo-reputation": {
      "command": "npx",
      "args": ["-y", "@tradallo/reputation"]
    }
  }
}
```

### Generic MCP client

```bash
npx @tradallo/reputation
```

Speaks MCP over stdio.

### Local dev / staging

Point at your own deploy by setting `TRADALLO_BASE_URL`:

```json
{
  "mcpServers": {
    "tradallo-reputation": {
      "command": "npx",
      "args": ["-y", "@tradallo/reputation"],
      "env": { "TRADALLO_BASE_URL": "http://localhost:3000" }
    }
  }
}
```

## CLI

The same binary doubles as a terminal CLI when invoked with a subcommand:

```bash
# Pretty card with verification status, stats, version metadata
npx @tradallo/reputation card alpha-momentum-v3 --agent

# Raw verified JSON (for piping into jq, etc.)
npx @tradallo/reputation track-record alpha-momentum-v3 --agent

# Discovery
npx @tradallo/reputation search --min-sharpe 1.5 --min-trades 200 --sort-by sharpe

# Agent version history
npx @tradallo/reputation versions alpha-momentum-v3

# Paginated UTRs
npx @tradallo/reputation utrs alpha-momentum-v3 --limit 50

# Look up a specific UTR by hash
npx @tradallo/reputation verify <sha256-hex> alpha-momentum-v3

# Help
npx @tradallo/reputation help
```

`NO_COLOR=1` disables ANSI. `TRADALLO_BASE_URL` overrides the API base.

## Programmatic client

Embed the verifying client in your own TS/JS code:

```ts
import { TradalloClient } from "@tradallo/reputation";

const client = new TradalloClient(); // defaults to https://tradallo.com

// Throws if signature invalid, replay window expired, or pubkey unknown.
// Returns the verified `data` payload (not the envelope wrapper).
const record = await client.getSigned<{ stats: { all_time: { sharpe_ratio: number | null } } }>(
  "/api/v1/agents/alpha-momentum-v3/track-record",
);

if ((record.stats.all_time.sharpe_ratio ?? 0) >= 1.5) {
  // ... delegate capital, copy trades, etc.
}
```

The verification flow happens INSIDE `getSigned`. If anything fails — bad signature, expired envelope, unknown key, schema mismatch — the call throws. You never see unverified data.

## Tools

### `get_track_record(handle, principal_type?)`

Fetch a verified track record for a Tradallo profile or agent.

**Inputs:**
- `handle` (string, required) — the Tradallo handle (e.g. `aaronjordan`, `alpha-momentum-v3`)
- `principal_type` (`"human"` | `"agent"`, optional, default `"agent"`) — which namespace to look in

**Returns:** the full signed payload (verification level, all-time + rolling 30/90/365d stats including Sharpe, max drawdown, win rate, PnL, expectancy).

**Example use:**
> "Show me Aaron Jordan's verified trading record on Tradallo."

### `search_records(filters)`

Discover verified records matching performance criteria.

**Inputs (all optional):** `min_sharpe`, `min_trades`, `max_drawdown`, `venue`, `principal_type`, `sort_by`, `limit`.

**Returns:** sorted list of human/agent summaries with their stats. Signature-verified.

### `verify_utr(utr_hash)`

Look up a Universal Trade Receipt by hash. Returns whether Tradallo has anchored that hash on-chain via a Solana memo, and if so the chain, signature, slot, posted_at, Solana Explorer URL, and notarizer pubkey so the caller can independently verify on-chain.

**Returns:** `{ found, anchored_on_chain, chain?, signature?, slot?, posted_at?, explorer_url?, notarizer_pubkey? }`.

### `get_versions(agent_handle)`

Fetch an agent's full version history (semver tags, version_hash, policy_hash, when each version was deployed and superseded). Signature-verified.

### `get_utrs(agent_handle, since?, limit?)`

Fetch raw Universal Trade Receipts for an agent, paginated cursor-style on `closed_at`. Each receipt includes its SHA-256 hash recomputed by Tradallo so consumers can spot-check individual records.

## How verification works

Every signed Tradallo API response wraps the data in a JCS-canonicalized (RFC 8785) envelope with an ed25519 signature:

```json
{
  "data": { ... },
  "schema_version": "1",
  "served_at": "2026-04-30T22:29:52.776Z",
  "max_age_seconds": 60,
  "signature": {
    "alg": "ed25519",
    "key_id": "tradallo-prod-2026-04",
    "sig": "<base64>"
  }
}
```

This MCP server:

1. Fetches `/.well-known/tradallo-pubkeys.json` (cached 5 min)
2. Resolves `signature.key_id` → ed25519 public key
3. JCS-canonicalizes `{data, schema_version, served_at, max_age_seconds}`
4. Verifies the signature against the pubkey
5. Rejects responses where `now > served_at + max_age_seconds` (replay protection)

If any check fails, the tool call returns an error rather than the data. The agent is told why.

## Why this matters

Identity (who is the agent) and payments (how does it pay) are solved in 2026 by x402, MPP, Coinbase Agentic Wallets, and ERC-8004. **Reputation is not.** When an agent decides whether to delegate capital, copy trades, or subscribe to signals from another party, it needs a way to ask: "is their record real?"

This MCP server is the lowest-friction way to ask that question.

## x402 — what's coming

Today the public API is anonymous and IP-rate-limited (60 req/min). We're rolling out tiered access via [x402](https://x402.org), the HTTP 402 payment-required standard, so agents can pay USDC micro-transactions on Base to bypass rate limits and unlock higher-throughput tiers without any signup or API-key dance.

Forward-compatible expectations:
- Anonymous: 60 req/min/IP (today, free)
- Active subscriber: 600 req/min via API key (in dev — Phase 4.4)
- **x402 micro-payment**: per-call USDC payment for one-shot heavy queries; no account required (planned Phase 4.5)
- Operator / Fleet tiers: webhook subscriptions, custom subdomains, priority indexing

The rate-limit response will gain an `x402` payment-options block once the facilitator pipeline is wired. This MCP server will start auto-paying when it sees a 402 with x402 metadata. Until then, all queries are free and verifiable.

## Reference agent

A working example agent that queries Tradallo before delegating capital:
[github.com/tradallo/agent](https://github.com/tradallo/agent).

## Spec & docs

- Protocol overview: [docs/PROTOCOL.md](https://github.com/tradallo/tradallo/blob/main/docs/PROTOCOL.md)
- Spec: [docs/SPEC_V1.1.md](https://github.com/tradallo/tradallo/blob/main/docs/SPEC_V1.1.md)
- Public API: https://tradallo.com/api/v1/
- Pubkey registry: https://tradallo.com/.well-known/tradallo-pubkeys.json

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
