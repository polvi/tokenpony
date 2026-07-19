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

/** Fetch (and cache) a JWKS from an AAuth well-known doc. Returns [] on failure. */
export async function fetchWellKnownJwks(issuer: string, doc: string): Promise<JWK[]> {
  let url: URL;
  try {
    url = new URL(`/.well-known/${doc}`, issuer);
  } catch {
    return [];
  }
  if (url.protocol !== 'https:' || isBlockedHost(url.hostname)) return [];

  const hit = cache.get(url.href);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.keys;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    // Workers has no redirect:'error'; use 'manual' and reject any 3xx (an
    // open-redirect could otherwise dodge the SSRF host guard).
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    clearTimeout(timer);
    if (res.status >= 300 && res.status < 400) return hit?.keys ?? [];
    if (!res.ok) return hit?.keys ?? [];
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return hit?.keys ?? [];
    const parsed = JSON.parse(new TextDecoder().decode(buf)) as {
      keys?: JWK[];
      jwks?: { keys?: JWK[] };
    };
    const keys = parsed.keys ?? parsed.jwks?.keys ?? [];
    if (keys.length) cache.set(url.href, { at: Date.now(), keys });
    return keys.length ? keys : (hit?.keys ?? []);
  } catch {
    return hit?.keys ?? []; // serve stale on error
  }
}

/** The PS's signing JWKS (verifies budget attestations). */
export function fetchPersonJwks(issuer: string): Promise<JWK[]> {
  return fetchWellKnownJwks(issuer, 'aauth-person.json');
}

/** An agent provider's signing JWKS (verifies agent tokens). */
export function fetchAgentJwks(issuer: string): Promise<JWK[]> {
  return fetchWellKnownJwks(issuer, 'aauth-agent.json');
}
