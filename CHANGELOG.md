# Changelog

All notable changes to `@tradallo/reputation` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.2] — 2026-05-02

### Changed
- Repository moved from the `tradallo/tradallo` monorepo subdir to its own
  repo at `github.com/tradallo/reputation`. `package.json` `repository` and
  `bugs` URLs updated. No code changes.

## [0.3.1] — 2026-05-01

### Changed
- **`verify_utr`**: now hits the public
  `/api/v1/utrs/<hash>/notarization` endpoint and returns whether the UTR
  hash has been anchored on Solana via Tradallo's notarizer. Response
  includes the chain, signature, slot, posted_at, Solana Explorer URL,
  and notarizer pubkey when found. The per-agent paginated walk is gone
  — direct hash lookup is faster and more honest about what "verified"
  means now that the on-chain anchoring pipeline is live.
- The tool no longer requires `agent_handle` — only `utr_hash`.

## [0.3.0] — 2026-04-30

### Added
- **CLI mode**: same binary now runs as a terminal CLI when invoked with
  a subcommand. Subcommands: `card`, `track-record`, `versions`, `utrs`,
  `search`, `verify`, `help`. Renders pretty ANSI cards (auto-disables
  with `NO_COLOR`).
- **Programmatic client export**: `TradalloClient` is now importable
  directly via `@tradallo/reputation` or `@tradallo/reputation/client`.
  Lets you embed the verifying client in any TS/JS app without going
  through the MCP transport.
- **`get_utrs` tool**: paginated UTR list, surfaces the cursor for further
  pages.
- **Improved `verify_utr`**: now scoped per-agent, walks the UTR pages
  to find the hash. Honest about Solana anchor lookup landing in 4.3.

### Changed
- `package.json` `main` now points to the client, not the MCP server, so
  `import` statements don't accidentally trigger the MCP runtime.
- Tool descriptions tightened with concrete usage hints.
- README expanded with CLI examples + x402 forward-roadmap section.

## [0.2.0] — 2026-04-30

### Changed
- **Stub-mode dropped.** All four MCP tools now wire to live, signed
  endpoints on tradallo.com:
  - `search_records` → `/api/v1/search`
  - `get_versions` → `/api/v1/agents/<handle>/versions`
  - `get_utrs` → `/api/v1/agents/<handle>/utrs`
  - `verify_utr` → walks the agent's UTR pages
- Every response is JCS-canonicalized + ed25519-verified before being
  returned to the agent.

## [0.1.0] — 2026-04-30

### Added
- Initial release.
- MCP server speaking JSON-RPC over stdio.
- Tool: `get_track_record(handle, principal_type?)` — wired to live
  `/api/v1/profiles/<handle>/track-record` and `/api/v1/agents/<handle>/track-record`.
- Stub tools for `search_records`, `verify_utr`, `get_versions` (no
  server endpoints yet).
- ed25519 signature verification of all responses against the published
  pubkey at `tradallo.com/.well-known/tradallo-pubkeys.json`.
- JCS (RFC 8785) canonicalization for envelope verification.
- Replay-window enforcement (`served_at` + `max_age_seconds`).
