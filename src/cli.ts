/**
 * CLI mode for the @tradallo/reputation binary.
 *
 * Same package, same client, same signature verification. The MCP transport
 * is only invoked when no CLI subcommand is present (i.e. when stdin is
 * the JSON-RPC channel).
 *
 * Subcommands:
 *   card <handle> [--agent]            ANSI-rendered reputation card
 *   track-record <handle> [--agent]    raw verified JSON
 *   versions <agent_handle>            agent version history
 *   utrs <agent_handle> [--limit N]    paginated UTRs
 *   search [filters...]                discovery
 *   verify <utr_hash>                  look up on-chain anchor for a UTR hash
 *   help                               show usage
 *
 * No deps beyond what we already pull (canonicalize, MCP SDK).
 * Pure ANSI for colors — terminals without color support degrade cleanly.
 */

import { TradalloClient } from "./client.js";

const BASE = process.env.TRADALLO_BASE_URL ?? "https://tradallo.com";

// ─── ANSI helpers (no chalk dep — keeps install lean) ───────────────────
const ESC = "\x1b[";
const c = {
  reset: ESC + "0m",
  dim: ESC + "2m",
  bold: ESC + "1m",
  blue: ESC + "38;5;39m",
  gold: ESC + "38;5;220m",
  green: ESC + "38;5;40m",
  red: ESC + "38;5;203m",
  grey: ESC + "38;5;245m",
  cyan: ESC + "38;5;44m",
  // Brand pink #FF7BA6, truecolor (24-bit). Falls back to nearest 256-color
  // approximation on terminals without truecolor; degrades to plain text
  // entirely when NO_COLOR is set.
  brand: ESC + "38;2;255;123;166m",
  brandSoft: ESC + "38;2;255;179;204m",
};

const NO_COLOR = process.env.NO_COLOR != null || !process.stdout.isTTY;
function paint(color: string, s: string): string {
  return NO_COLOR ? s : `${color}${s}${c.reset}`;
}

const CARD_WIDTH = 60;

function pad(s: string, width: number): string {
  // Strip ANSI for width math; pad with spaces.
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  const need = Math.max(0, width - visible.length);
  return s + " ".repeat(need);
}

function hr(width = CARD_WIDTH - 2): string {
  return paint(c.dim, "─".repeat(width));
}

function row(label: string, value: string): string {
  const left = paint(c.grey, label.padEnd(16));
  return `${left}${value}`;
}

function num(v: unknown, opts: { currency?: boolean; pct?: boolean; decimals?: number } = {}): string {
  if (v === null || v === undefined) return paint(c.dim, "—");
  const n = Number(v);
  if (!Number.isFinite(n)) return paint(c.dim, "—");
  const decimals = opts.decimals ?? (opts.pct ? 1 : 2);
  if (opts.pct) return `${(n * 100).toFixed(decimals)}%`;
  if (opts.currency) {
    const sign = n >= 0 ? "+" : "−";
    const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${sign}$${abs}`;
  }
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

function tonePnl(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return paint(c.dim, "—");
  if (v > 0) return paint(c.green, num(v, { currency: true }));
  if (v < 0) return paint(c.red, num(v, { currency: true }));
  return num(v, { currency: true });
}

// ─── Render a track-record envelope into a clean card ───────────────────

type TrackRecordPayload = {
  profile?: {
    handle: string;
    display_name: string | null;
    tier: string;
    principal_type: "human" | "agent";
    registered_at: string;
  };
  agent?: {
    handle: string;
    display_name: string;
    description?: string | null;
    framework?: string | null;
    principal_type: "agent";
    tier: string;
    registered_at: string;
    version: string | null;
    version_hash: string | null;
    policy_hash: string | null;
  };
  verification: { level: string; anchor_at: string | null };
  stats: {
    all_time: {
      trade_count: number;
      win_rate: number;
      net_pnl_usd: number;
      sharpe_ratio: number | null;
      max_drawdown_pct: number;
    };
  };
  account_summary: { account_count: number; brokers: string[] };
};

function levelLabel(level: string): string {
  switch (level) {
    case "verified_blue": return paint(c.blue, "● Verified blue");
    case "tradallo_notarized": return paint(c.cyan, "● Notarized");
    case "verified_gold": return paint(c.gold, "● Verified gold");
    default: return paint(c.dim, "○ Self-attested");
  }
}

function renderCard(payload: TrackRecordPayload, opts: { keyId: string }): string {
  const isAgent = !!payload.agent;
  const subject = isAgent ? payload.agent! : payload.profile!;
  const handle = subject.handle;
  const name = subject.display_name ?? null;

  const tag = isAgent ? paint(c.dim, " (agent)") : "";
  const top = `╭─ ${paint(c.bold, "@" + handle)}${tag} `;
  const topPad = pad(top, CARD_WIDTH - 1);
  const lines: string[] = [
    topPad + "╮",
  ];

  const pushLine = (content: string) => lines.push(pad(`│ ${content}`, CARD_WIDTH - 1) + "│");

  if (name && name !== handle) pushLine(paint(c.grey, name));
  pushLine("");
  pushLine(`${levelLabel(payload.verification.level)}    ${paint(c.dim, "tier")} ${subject.tier ?? "—"}`);
  pushLine(`${paint(c.grey, "venues")}: ${payload.account_summary.brokers.join(", ") || paint(c.dim, "none")}    ${paint(c.dim, "accounts")} ${payload.account_summary.account_count}`);

  if (isAgent && payload.agent) {
    const v = payload.agent.version ? `v${payload.agent.version}` : paint(c.dim, "no version");
    const fw = payload.agent.framework ? `· ${payload.agent.framework}` : "";
    pushLine(`${paint(c.grey, "version")}: ${v} ${paint(c.dim, fw)}`);
    if (payload.agent.policy_hash) {
      const short = payload.agent.policy_hash.slice(0, 12) + "…";
      pushLine(`${paint(c.grey, "policy_hash")}: ${paint(c.dim, short)}`);
    }
  }

  pushLine("");
  pushLine(paint(c.bold, "All-time stats"));
  pushLine(hr(CARD_WIDTH - 4));
  const s = payload.stats.all_time;
  pushLine(row("trades", num(s.trade_count, { decimals: 0 })));
  pushLine(row("net P&L", tonePnl(s.net_pnl_usd)));
  pushLine(row("win rate", num(s.win_rate, { pct: true })));
  pushLine(row("sharpe", num(s.sharpe_ratio, { decimals: 2 })));
  pushLine(row("max drawdown", num(s.max_drawdown_pct, { pct: true })));

  pushLine("");
  if (payload.verification.anchor_at) {
    pushLine(`${paint(c.grey, "anchor_at")}: ${payload.verification.anchor_at.slice(0, 19).replace("T", " ")} UTC`);
  }
  pushLine(`${paint(c.grey, "verified by")}: ${paint(c.cyan, opts.keyId)}`);

  lines.push("╰" + "─".repeat(CARD_WIDTH - 2) + "╯");
  return lines.join("\n");
}

// ─── Subcommand dispatch ────────────────────────────────────────────────

// Brand banner — block-letter "TRADALLO" in brand pink. Six lines × ~66
// cols. Prints at the top of `help` output; also emitted to stderr on MCP
// startup so a developer attaching to the stdio process sees something
// recognizable instead of silence. Pure printable ASCII so it round-trips
// safely across terminals/SSH/log aggregators.
const BANNER_LINES = [
  "████████╗██████╗  █████╗ ██████╗  █████╗ ██╗     ██╗      ██████╗ ",
  "╚══██╔══╝██╔══██╗██╔══██╗██╔══██╗██╔══██╗██║     ██║     ██╔═══██╗",
  "   ██║   ██████╔╝███████║██║  ██║███████║██║     ██║     ██║   ██║",
  "   ██║   ██╔══██╗██╔══██║██║  ██║██╔══██║██║     ██║     ██║   ██║",
  "   ██║   ██║  ██║██║  ██║██████╔╝██║  ██║███████╗███████╗╚██████╔╝",
  "   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝ ╚═════╝ ",
];

export const PKG_VERSION = "0.3.2";

const BANNER = [
  ...BANNER_LINES.map((l) => paint(c.brand, l)),
  paint(c.brandSoft, "  reputation") +
    paint(c.dim, ` · v${PKG_VERSION} · MIT · `) +
    paint(c.brandSoft, "tradallo.com"),
].join("\n");

const HELP = `${BANNER}

${paint(c.bold, "USAGE")}
  npx @tradallo/reputation <subcommand> [args]

${paint(c.bold, "SUBCOMMANDS")}
  ${paint(c.cyan, "card")} <handle> [--agent]               Pretty-printed reputation card
  ${paint(c.cyan, "track-record")} <handle> [--agent]       Raw verified JSON
  ${paint(c.cyan, "versions")} <agent_handle>               Agent version history
  ${paint(c.cyan, "utrs")} <agent_handle> [--limit N]       Paginated UTRs (signed)
  ${paint(c.cyan, "search")} [--min-sharpe N] [--min-trades N] ...
                                          Discovery with stat filters
  ${paint(c.cyan, "verify")} <utr_hash>                     On-chain anchor lookup for a UTR hash
  ${paint(c.cyan, "help")}                                  Show this help

${paint(c.bold, "MCP MODE")}
  Run with no args to start the MCP stdio server (for Claude Desktop, Cursor, etc.).

${paint(c.bold, "ENV")}
  TRADALLO_BASE_URL    Override the API base (default: ${BASE})
  NO_COLOR             Disable ANSI colors

${paint(c.bold, "DOCS")}
  Protocol:    https://github.com/tradallo/tradallo/blob/main/docs/PROTOCOL.md
  Spec:        https://github.com/tradallo/tradallo/blob/main/docs/SPEC_V1.1.md
`;

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function cmdCard(args: string[]): Promise<void> {
  const handle = args[0];
  if (!handle) {
    console.error("usage: card <handle> [--agent]");
    process.exit(2);
  }
  const isAgent = flag(args, "--agent");
  const client = new TradalloClient({ baseUrl: BASE });
  const path = isAgent
    ? `/api/v1/agents/${encodeURIComponent(handle)}/track-record`
    : `/api/v1/profiles/${encodeURIComponent(handle)}/track-record`;
  // We need the key_id from the envelope — fetch raw, verify, then render.
  const res = await fetch(`${BASE}${path}`);
  if (res.status === 404) {
    console.error(paint(c.red, `not found: ${handle}${isAgent ? " (agent)" : ""}`));
    if (!isAgent) console.error(paint(c.dim, "(if this is an agent, pass --agent)"));
    process.exit(1);
  }
  if (!res.ok) {
    console.error(paint(c.red, `request failed: ${res.status}`));
    process.exit(1);
  }
  const envelope = (await res.json()) as { data: TrackRecordPayload; signature: { key_id: string }; principal_type?: string };
  // Verify by routing through TradalloClient internals — re-fetch via getSigned
  // would double-call the API. Inline the verification trick: pass the
  // already-fetched envelope to a thin wrapper.
  // Simpler: trust the verifier inside TradalloClient by going through it.
  const data = await client.getSigned<TrackRecordPayload>(path);
  console.log(renderCard(data, { keyId: envelope.signature.key_id }));
  console.log(paint(c.dim, `\n  Open: ${BASE}${isAgent ? "/agents/" : "/u/"}${handle}\n`));
}

async function cmdTrackRecord(args: string[]): Promise<void> {
  const handle = args[0];
  if (!handle) {
    console.error("usage: track-record <handle> [--agent]");
    process.exit(2);
  }
  const isAgent = flag(args, "--agent");
  const client = new TradalloClient({ baseUrl: BASE });
  const path = isAgent
    ? `/api/v1/agents/${encodeURIComponent(handle)}/track-record`
    : `/api/v1/profiles/${encodeURIComponent(handle)}/track-record`;
  const data = await client.getSigned<unknown>(path);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdVersions(args: string[]): Promise<void> {
  const handle = args[0];
  if (!handle) {
    console.error("usage: versions <agent_handle>");
    process.exit(2);
  }
  const client = new TradalloClient({ baseUrl: BASE });
  const data = await client.getSigned<unknown>(
    `/api/v1/agents/${encodeURIComponent(handle)}/versions`,
  );
  console.log(JSON.stringify(data, null, 2));
}

async function cmdUtrs(args: string[]): Promise<void> {
  const handle = args[0];
  if (!handle) {
    console.error("usage: utrs <agent_handle> [--limit N] [--since ISO]");
    process.exit(2);
  }
  const limit = arg(args, "--limit");
  const since = arg(args, "--since");
  const qs = new URLSearchParams();
  if (limit) qs.set("limit", limit);
  if (since) qs.set("since", since);
  const path = `/api/v1/agents/${encodeURIComponent(handle)}/utrs${qs.toString() ? `?${qs.toString()}` : ""}`;
  const client = new TradalloClient({ baseUrl: BASE });
  const data = await client.getSigned<unknown>(path);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdSearch(args: string[]): Promise<void> {
  const qs = new URLSearchParams();
  const minSharpe = arg(args, "--min-sharpe");
  const minTrades = arg(args, "--min-trades");
  const maxDd = arg(args, "--max-drawdown");
  const venue = arg(args, "--venue");
  const principal = arg(args, "--principal");
  const sortBy = arg(args, "--sort-by");
  const limit = arg(args, "--limit");
  if (minSharpe) qs.set("min_sharpe", minSharpe);
  if (minTrades) qs.set("min_trades", minTrades);
  if (maxDd) qs.set("max_drawdown", maxDd);
  if (venue) qs.set("venue", venue);
  if (principal) qs.set("principal_type", principal);
  if (sortBy) qs.set("sort_by", sortBy);
  if (limit) qs.set("limit", limit);
  const path = `/api/v1/search${qs.toString() ? `?${qs.toString()}` : ""}`;
  const client = new TradalloClient({ baseUrl: BASE });
  const data = await client.getSigned<unknown>(path);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdVerify(args: string[]): Promise<void> {
  const utrHash = args[0];
  if (!utrHash) {
    console.error("usage: verify <utr_hash>");
    process.exit(2);
  }
  const lower = utrHash.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(lower)) {
    console.error("verify: utr_hash must be 64-char SHA-256 hex");
    process.exit(2);
  }
  const client = new TradalloClient({ baseUrl: BASE });
  const data = await client.getSigned<unknown>(
    `/api/v1/utrs/${encodeURIComponent(lower)}/notarization`,
  );
  console.log(JSON.stringify(data, null, 2));
}

const SUBCOMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  card: cmdCard,
  "track-record": cmdTrackRecord,
  versions: cmdVersions,
  utrs: cmdUtrs,
  search: cmdSearch,
  verify: cmdVerify,
};

/** Returns true if argv looks like a CLI subcommand invocation (vs MCP stdio). */
export function isCliInvocation(argv: string[]): boolean {
  const args = argv.slice(2);
  if (args.length === 0) return false;
  const first = args[0]!;
  if (first === "help" || first === "--help" || first === "-h") return true;
  return Object.prototype.hasOwnProperty.call(SUBCOMMANDS, first);
}

export async function runCli(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const subcommand = args[0];
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(HELP);
    return;
  }
  const handler = SUBCOMMANDS[subcommand];
  if (!handler) {
    console.error(`unknown subcommand: ${subcommand}`);
    console.error(`run "npx @tradallo/reputation help" for usage.`);
    process.exit(2);
  }
  try {
    await handler(args.slice(1));
  } catch (e) {
    console.error(paint(c.red, `✗ ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}
