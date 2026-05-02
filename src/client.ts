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
 */

import { createPublicKey, verify as nodeVerify } from "node:crypto";
import canonicalize from "canonicalize";

const DEFAULT_BASE = "https://tradallo.com";

export type TradalloClientOptions = {
  /** Base URL — override for local dev or staging. */
  baseUrl?: string;
  /** Additional headers (e.g. API key when tier endpoints need it). */
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

const SPKI_ED25519_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);

function publicKeyFromB64(b64: string) {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) {
    throw new Error(`expected 32-byte ed25519 public key, got ${raw.length} bytes`);
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export class TradalloClient {
  private baseUrl: string;
  private extraHeaders: Record<string, string>;
  private pubkeyCacheMs: number;
  private pubkeyCache: { fetchedAt: number; entries: PubkeyEntry[] } | null = null;

  constructor(opts: TradalloClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.extraHeaders = opts.extraHeaders ?? {};
    this.pubkeyCacheMs = opts.pubkeyCacheMs ?? 5 * 60_000;
  }

  /** Fetch the published signing-key registry. Cached for `pubkeyCacheMs`. */
  async getPubkeys(): Promise<PubkeyEntry[]> {
    const now = Date.now();
    if (this.pubkeyCache && now - this.pubkeyCache.fetchedAt < this.pubkeyCacheMs) {
      return this.pubkeyCache.entries;
    }
    const res = await fetch(`${this.baseUrl}/.well-known/tradallo-pubkeys.json`, {
      headers: { ...this.extraHeaders, accept: "application/json" },
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
      headers: { ...this.extraHeaders, accept: "application/json" },
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
   *  the reference verifier in lib/crypto/signing.ts. */
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

    const pubkey = publicKeyFromB64(match.pubkey);
    const toVerify = canonicalize({
      data: envelope.data,
      schema_version: envelope.schema_version,
      served_at: envelope.served_at,
      max_age_seconds: envelope.max_age_seconds,
    });
    if (toVerify === undefined) {
      throw new Error("envelope data not canonicalizable");
    }

    const verified = nodeVerify(
      null,
      Buffer.from(toVerify, "utf8"),
      pubkey,
      Buffer.from(envelope.signature.sig, "base64"),
    );
    if (!verified) {
      throw new Error("ed25519 signature verification failed");
    }
  }
}
