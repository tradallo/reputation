/**
 * Tradallo public-API client for the MCP server.
 *
 * Fetches signed envelopes from the public API, verifies the ed25519
 * signature against the well-known pubkey registry, and returns the
 * verified payload to the MCP tool layer.
 *
 * Verification on every call is the point — an MCP user that calls
 * `get_track_record` is asking us "is this trader's record real?", and
 * the only honest answer is "we cryptographically checked the response."
 *
 * Runtime portability: Web Crypto API (`crypto.subtle`) + `Uint8Array` only.
 * Runs unchanged in Node 20+, Cloudflare Workers, Bun, Deno. No `node:crypto`
 * and no `Buffer` so the same client serves stdio (npx package) and
 * Streamable-HTTP (Cloudflare Workers) deployments.
 */

import canonicalize from "canonicalize";

const DEFAULT_BASE = "https://tradallo.com";

export type TradalloClientOptions = {
  /** Base URL — override for local dev or staging. */
  baseUrl?: string;
  /** Tradallo API key (tdo_live_… / tdo_test_…). When set, requests carry
   *  `Authorization: Bearer <key>` and the caller gets their per-tier rate
   *  limit instead of the anonymous IP bucket. */
  apiKey?: string;
  /** Additional headers (advanced — mostly for tests or proxy scenarios). */
  extraHeaders?: Record<string, string>;
  /** Pubkey cache TTL in ms. Default 5 minutes. */
  pubkeyCacheMs?: number;
};

type PubkeyEntry = {
  key_id: string;
  alg: string;
  pubkey: string;
  valid_from: string;
  valid_until: string | null;
};

type SignedEnvelope<T> = {
  data: T;
  schema_version: string;
  served_at: string;
  max_age_seconds: number;
  signature: { alg: string; key_id: string; sig: string };
};

const SUPPORTED_SCHEMA_VERSION = "1";

// ─── Web-Crypto-only helpers (no Buffer, no node:crypto) ────────────────

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const TEXT_ENCODER = new TextEncoder();

async function verifyEd25519(
  message: Uint8Array,
  signature: Uint8Array,
  pubkeyRaw: Uint8Array,
): Promise<boolean> {
  if (pubkeyRaw.length !== 32) {
    throw new Error(`expected 32-byte ed25519 public key, got ${pubkeyRaw.length} bytes`);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    pubkeyRaw as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("Ed25519", key, signature as BufferSource, message as BufferSource);
}

export class TradalloClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private pubkeyCacheMs: number;
  private pubkeyCache: { fetchedAt: number; entries: PubkeyEntry[] } | null = null;

  constructor(opts: TradalloClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) };
    if (opts.apiKey) {
      headers["authorization"] = `Bearer ${opts.apiKey}`;
    }
    this.headers = headers;
    this.pubkeyCacheMs = opts.pubkeyCacheMs ?? 5 * 60_000;
  }

  /** Fetch the published signing-key registry. Cached for `pubkeyCacheMs`. */
  async getPubkeys(): Promise<PubkeyEntry[]> {
    const now = Date.now();
    if (this.pubkeyCache && now - this.pubkeyCache.fetchedAt < this.pubkeyCacheMs) {
      return this.pubkeyCache.entries;
    }
    const res = await fetch(`${this.baseUrl}/.well-known/tradallo-pubkeys.json`, {
      headers: { ...this.headers, accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`pubkey registry fetch failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { keys: PubkeyEntry[] };
    this.pubkeyCache = { fetchedAt: now, entries: body.keys };
    return body.keys;
  }

  /** Fetch a signed endpoint and verify the signature. Returns the inner
   *  `data` payload on success; throws on any verification failure. */
  async getSigned<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { ...this.headers, accept: "application/json" },
    });
    if (res.status === 404) {
      throw new Error(`not_found: ${path}`);
    }
    if (!res.ok) {
      throw new Error(`request failed: ${res.status} ${res.statusText} (${path})`);
    }
    const envelope = (await res.json()) as SignedEnvelope<T>;
    await this.verifyEnvelope(envelope);
    return envelope.data;
  }

  /** Internal: full ed25519 + JCS + replay-window verification. Mirrors
   *  the reference verifier in lib/crypto/signing.ts (the server-side
   *  signer that produces these envelopes). */
  private async verifyEnvelope<T>(envelope: SignedEnvelope<T>): Promise<void> {
    if (envelope.schema_version !== SUPPORTED_SCHEMA_VERSION) {
      throw new Error(
        `unsupported envelope schema_version: ${envelope.schema_version} (expected ${SUPPORTED_SCHEMA_VERSION})`,
      );
    }
    const servedAtMs = Date.parse(envelope.served_at);
    if (Number.isNaN(servedAtMs)) {
      throw new Error("envelope has invalid served_at");
    }
    if (Date.now() > servedAtMs + envelope.max_age_seconds * 1000) {
      throw new Error("envelope past max_age_seconds (replay window expired)");
    }
    if (envelope.signature.alg !== "ed25519") {
      throw new Error(`unsupported signature alg: ${envelope.signature.alg}`);
    }

    const pubkeys = await this.getPubkeys();
    const match = pubkeys.find((k) => k.key_id === envelope.signature.key_id);
    if (!match) {
      // One refresh attempt — the key may have been rotated since our cache
      // was populated.
      this.pubkeyCache = null;
      const refreshed = await this.getPubkeys();
      const retry = refreshed.find((k) => k.key_id === envelope.signature.key_id);
      if (!retry) {
        throw new Error(`unknown signing key_id: ${envelope.signature.key_id}`);
      }
      return this.verifyEnvelope(envelope);
    }

    const pubkeyRaw = base64ToBytes(match.pubkey);
    const canonical = canonicalize({
      data: envelope.data,
      schema_version: envelope.schema_version,
      served_at: envelope.served_at,
      max_age_seconds: envelope.max_age_seconds,
    });
    if (canonical === undefined) {
      throw new Error("envelope data not canonicalizable");
    }

    const message = TEXT_ENCODER.encode(canonical);
    const signature = base64ToBytes(envelope.signature.sig);
    const ok = await verifyEd25519(message, signature, pubkeyRaw);
    if (!ok) {
      throw new Error("ed25519 signature verification failed");
    }
  }
}
