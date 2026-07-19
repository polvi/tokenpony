import type { JWK } from 'jose';

/**
 * SSRF-guarded fetch of a Person Server's aauth-person.json JWKS, used to verify
 * budget attestations. Open to any https PS (trust is funding-gated, seam
 * contract section 5); the guardrails below just prevent internal-network abuse.
 *
 * Cached per isolate for ~5m with serve-stale-on-error (seam contract section 8),
 * the same read-through pattern as pricing.ts. Not request state: public keys only.
 */

const CACHE_TTL_MS = 300_000;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;

const cache = new Map<string, { at: number; keys: JWK[] }>();

function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // literal IPv4
  if (h.includes(':') || h.startsWith('[')) return true; // literal IPv6
  return false;
}

/** SSRF-guarded GET of a small JSON doc. Returns null on any failure. */
async function fetchJson(target: string): Promise<Record<string, unknown> | null> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || isBlockedHost(url.hostname)) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    // Workers has no redirect:'error'; use 'manual' and reject any 3xx (an
    // open-redirect could otherwise dodge the SSRF host guard).
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    clearTimeout(timer);
    if (res.status >= 300 || !res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null;
    return JSON.parse(new TextDecoder().decode(buf)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Fetch (and cache) a JWKS from an AAuth well-known doc. Keys may be inline
 * (`keys`) or referenced by `jwks_uri` (seam contract section 8); we follow the
 * URI when there are no inline keys. Returns [] on failure.
 */
export async function fetchWellKnownJwks(issuer: string, doc: string): Promise<JWK[]> {
  const wellKnown = `${issuer.replace(/\/$/, '')}/.well-known/${doc}`;
  const hit = cache.get(wellKnown);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.keys;

  const meta = await fetchJson(wellKnown);
  if (!meta) return hit?.keys ?? [];

  let keys = (meta.keys as JWK[] | undefined) ?? (meta.jwks as { keys?: JWK[] } | undefined)?.keys ?? [];
  if (keys.length === 0 && typeof meta.jwks_uri === 'string') {
    const jwks = await fetchJson(meta.jwks_uri);
    keys = (jwks?.keys as JWK[] | undefined) ?? [];
  }
  if (keys.length) cache.set(wellKnown, { at: Date.now(), keys });
  return keys.length ? keys : (hit?.keys ?? []);
}

/** The PS's signing JWKS (verifies budget attestations). */
export function fetchPersonJwks(issuer: string): Promise<JWK[]> {
  return fetchWellKnownJwks(issuer, 'aauth-person.json');
}

/** An agent provider's signing JWKS (verifies agent tokens). */
export function fetchAgentJwks(issuer: string): Promise<JWK[]> {
  return fetchWellKnownJwks(issuer, 'aauth-agent.json');
}
