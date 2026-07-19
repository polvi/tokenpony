import { compactVerify, type JWK } from 'jose';
import type { Bindings } from '../types';
import { importPublicJwk } from './keys';

/**
 * RFC 9421 HTTP Message Signature verification, AAuth profile (seam contract
 * section 1). Ed25519 only. The agent token rides in `Signature-Key:
 * sig=jwt;jwt="<aa-agent+jwt>"`; the covered set MUST include `authorization`
 * whenever an Authorization header is sent, and `aauth-mission` when that header
 * is sent. Cloudflare-safe base reconstruction: raw pathname, lowercased host,
 * default port stripped, uppercased method.
 */

const REQUIRED = ['@method', '@authority', '@path', 'signature-key'];

interface SigParams {
  label: string;
  covered: string[];
  created?: number;
  keyid?: string;
  alg?: string;
}

/** Minimal RFC 8941 parse of the one signature we care about. */
function parseSignatureInput(header: string): SigParams | null {
  // e.g. sig=("@method" "@authority" ...);created=123;keyid="k";alg="ed25519"
  const eq = header.indexOf('=');
  if (eq < 0) return null;
  const label = header.slice(0, eq).trim();
  const rest = header.slice(eq + 1).trim();
  const listEnd = rest.indexOf(')');
  if (!rest.startsWith('(') || listEnd < 0) return null;
  const covered = [...rest.slice(1, listEnd).matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
  const params = rest.slice(listEnd + 1);
  const out: SigParams = { label, covered };
  for (const seg of params.split(';')) {
    const s = seg.trim();
    if (!s) continue;
    const [k, vRaw] = s.split('=');
    const v = vRaw?.replace(/^"|"$/g, '');
    if (k === 'created') out.created = Number(v);
    else if (k === 'keyid') out.keyid = v;
    else if (k === 'alg') out.alg = v;
  }
  return out;
}

function parseSignature(header: string, label: string): Uint8Array | null {
  // sig=:base64:
  for (const seg of header.split(',')) {
    const s = seg.trim();
    if (!s.startsWith(`${label}=`)) continue;
    const m = s.match(/:([A-Za-z0-9+/=]+):/);
    if (!m) return null;
    return Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0));
  }
  return null;
}

/** Extract the agent token from `Signature-Key: sig=jwt;jwt="..."`. */
export function parseSignatureKey(header: string, label: string): string | null {
  for (const seg of header.split(',')) {
    const s = seg.trim();
    if (!s.startsWith(`${label}=`)) continue;
    const m = s.match(/jwt="([^"]+)"/);
    return m ? m[1] : null;
  }
  return null;
}

function componentValue(name: string, url: URL, method: string, headers: Headers): string | null {
  switch (name) {
    case '@method':
      return method.toUpperCase();
    case '@authority': {
      let auth = url.host.toLowerCase();
      auth = auth.replace(/:80$/, '').replace(/:443$/, '');
      return auth;
    }
    case '@path':
      return url.pathname; // raw pathname
    default: {
      const v = headers.get(name);
      return v === null ? null : v.trim();
    }
  }
}

export function buildSignatureBase(
  covered: string[],
  params: SigParams,
  url: URL,
  method: string,
  headers: Headers,
): string | null {
  const lines: string[] = [];
  for (const c of covered) {
    const v = componentValue(c, url, method, headers);
    if (v === null) return null; // a covered component with no value is fatal
    lines.push(`"${c}": ${v}`);
  }
  // @signature-params line, echoing the exact serialized params.
  const list = covered.map((c) => `"${c}"`).join(' ');
  let sp = `(${list})`;
  if (params.created !== undefined) sp += `;created=${params.created}`;
  if (params.keyid !== undefined) sp += `;keyid="${params.keyid}"`;
  if (params.alg !== undefined) sp += `;alg="${params.alg}"`;
  lines.push(`"@signature-params": ${sp}`);
  return lines.join('\n');
}

export interface HttpSigResult {
  ok: boolean;
  reason?: string;
  agentToken?: string;
}

/**
 * Verify the agent's HTTP signature against a public JWK (the auth token's
 * cnf.jwk). Enforces the covered-set rules, created window, and replay guard.
 */
export async function verifyHttpSignature(
  env: Bindings,
  req: { method: string; url: string; headers: Headers },
  cnfJwk: JWK,
): Promise<HttpSigResult> {
  if (cnfJwk.kty !== 'OKP' || cnfJwk.crv !== 'Ed25519') {
    return { ok: false, reason: 'unsupported_algorithm' };
  }
  const sigInput = req.headers.get('signature-input');
  const sig = req.headers.get('signature');
  const sigKey = req.headers.get('signature-key');
  if (!sigInput || !sig || !sigKey) return { ok: false, reason: 'missing_signature' };

  const params = parseSignatureInput(sigInput);
  if (!params) return { ok: false, reason: 'bad_signature_input' };
  if (params.alg && params.alg !== 'ed25519') return { ok: false, reason: 'unsupported_algorithm' };

  const covered = params.covered;
  for (const req0 of REQUIRED) {
    if (!covered.includes(req0)) return { ok: false, reason: `uncovered_${req0}` };
  }
  // Any present Authorization / AAuth-Mission header MUST be covered.
  if (req.headers.get('authorization') !== null && !covered.includes('authorization'))
    return { ok: false, reason: 'authorization_uncovered' };
  if (req.headers.get('aauth-mission') !== null && !covered.includes('aauth-mission'))
    return { ok: false, reason: 'aauth_mission_uncovered' };

  // created window: 300s with +/-60s skew.
  const nowS = Math.floor(Date.now() / 1000);
  if (params.created === undefined) return { ok: false, reason: 'missing_created' };
  if (Math.abs(nowS - params.created) > 360) return { ok: false, reason: 'stale_created' };

  const url = new URL(req.url);
  const base = buildSignatureBase(covered, params, url, req.method, req.headers);
  if (base === null) return { ok: false, reason: 'covered_component_missing' };

  const sigBytes = parseSignature(sig, params.label);
  if (!sigBytes) return { ok: false, reason: 'bad_signature' };

  let verified = false;
  try {
    const key = await importPublicJwk(cnfJwk);
    verified = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      sigBytes,
      new TextEncoder().encode(base),
    );
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: 'signature_invalid' };

  // Replay guard: dedupe on sha256(signature bytes) within the created window.
  const digest = await crypto.subtle.digest('SHA-256', sigBytes);
  const sigHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ins = await env.DB.prepare(
    'INSERT OR IGNORE INTO aauth_replay (sig_hash, expires_at) VALUES (?, ?)',
  )
    .bind(sigHash, nowS + 300)
    .run();
  if (ins.meta.changes === 0) return { ok: false, reason: 'replay' };

  const agentToken = parseSignatureKey(sigKey, params.label) ?? undefined;
  return { ok: true, agentToken };
}

/** Verify an aa-agent+jwt via its issuer JWKS; returns cnf jwk + thumbprint. */
export async function verifyAgentToken(
  agentJwt: string,
  fetchJwks: (issuer: string) => Promise<JWK[]>,
): Promise<{ iss: string; sub: string; cnfJwk: JWK } | null> {
  try {
    const [h, p] = agentJwt.split('.');
    const b64 = (s: string) => s.replaceAll('-', '+').replaceAll('_', '/');
    const pad = (s: string) => s + '='.repeat((4 - (s.length % 4)) % 4);
    const header = JSON.parse(atob(pad(b64(h)))) as { alg?: string; typ?: string };
    if (header.alg !== 'EdDSA') return null;
    if (header.typ !== 'aa-agent+jwt') return null;
    const claims = JSON.parse(atob(pad(b64(p)))) as {
      iss?: string;
      sub?: string;
      cnf?: { jwk?: JWK };
      exp?: number;
      iat?: number;
    };
    if (!claims.iss || !claims.iss.startsWith('https://') || !claims.sub || !claims.cnf?.jwk)
      return null;
    const nowS = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === 'number' && claims.exp < nowS - 60) return null;
    if (typeof claims.iat === 'number' && claims.iat > nowS + 60) return null;
    const jwks = await fetchJwks(claims.iss);
    for (const jwk of jwks) {
      if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') continue;
      try {
        const key = await importPublicJwk(jwk);
        await compactVerify(agentJwt, key);
        return { iss: claims.iss, sub: claims.sub, cnfJwk: claims.cnf.jwk };
      } catch {
        // next key
      }
    }
    return null;
  } catch {
    return null;
  }
}
