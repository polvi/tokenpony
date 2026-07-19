import { CompactSign, compactVerify, type JWK } from 'jose';
import type { Bindings } from '../types';
import { getSigningKey, importPublicJwk, jwkThumbprint } from './keys';

/**
 * AAuth JWS minting/verification (seam contract section 2). All provider-minted
 * tokens are EdDSA (Ed25519). See the token-shape table in the contract.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface MissionRef {
  approver: string;
  s256: string;
}

export interface BudgetEntry {
  resource: string;
  amount: string;
  currency: string;
  models?: string[];
}

async function signJws(
  env: Bindings,
  typ: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const { kid, privateKey } = await getSigningKey(env);
  return new CompactSign(enc.encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'EdDSA', typ, kid })
    .sign(privateKey);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** aa-resource+jwt: the 401 challenge token the agent carries to its PS. */
export async function mintResourceToken(
  env: Bindings,
  opts: {
    resource: string; // our resource origin (== iss)
    tokenEndpoint: string; // aud (four-party: the AS token endpoint)
    agent: string;
    agentJkt: string;
    scope: string;
    mission?: MissionRef;
  },
): Promise<string> {
  const iat = now();
  return signJws(env, 'aa-resource+jwt', {
    iss: opts.resource,
    dwk: 'aauth-resource.json',
    aud: opts.tokenEndpoint,
    agent: opts.agent,
    agent_jkt: opts.agentJkt,
    scope: opts.scope,
    ...(opts.mission && { mission: opts.mission }),
    jti: crypto.randomUUID(),
    iat,
    exp: iat + 300, // <= 5m
  });
}

/** aa-auth+jwt (budgeted, TPX-A): identity-free, budget-bearing. */
export async function mintAuthToken(
  env: Bindings,
  opts: {
    resource: string; // iss
    agent: string;
    mission: MissionRef;
    budget: BudgetEntry;
    cnfJwk: JWK;
    scope: string;
    ttl?: number;
  },
): Promise<{ token: string; jti: string; exp: number }> {
  const iat = now();
  const exp = iat + Math.min(opts.ttl ?? 3600, 3600);
  const jti = crypto.randomUUID();
  const token = await signJws(env, 'aa-auth+jwt', {
    iss: opts.resource,
    dwk: 'aauth-resource.json',
    agent: opts.agent,
    mission: opts.mission,
    budget: opts.budget,
    cnf: { jwk: opts.cnfJwk },
    scope: opts.scope,
    jti,
    iat,
    exp,
    // No sub, no identity claims (seam contract section 2 / TPX-A section 9).
  });
  return { token, jti, exp };
}

export interface ParsedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function decodeUnverified(jwt: string): ParsedJws | null {
  try {
    const [h, p] = jwt.split('.');
    if (!h || !p) return null;
    const b64 = (s: string) => s.replaceAll('-', '+').replaceAll('_', '/');
    const pad = (s: string) => s + '='.repeat((4 - (s.length % 4)) % 4);
    const header = JSON.parse(atob(pad(b64(h)))) as Record<string, unknown>;
    const payload = JSON.parse(atob(pad(b64(p)))) as Record<string, unknown>;
    return { header, payload };
  } catch {
    return null;
  }
}

/** Verify a token we minted ourselves against our local signing key. */
export async function verifySelfJws(
  env: Bindings,
  jwt: string,
  expectedTyp: string,
): Promise<Record<string, unknown> | null> {
  try {
    const { publicJwk } = await getSigningKey(env);
    const key = await importPublicJwk(publicJwk);
    const { payload, protectedHeader } = await compactVerify(jwt, key);
    if (protectedHeader.typ !== expectedTyp) return null;
    const claims = JSON.parse(dec.decode(payload)) as Record<string, unknown>;
    if (typeof claims.exp === 'number' && claims.exp < now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Verify a PS-signed budget attestation (seam contract section 4) against a JWK
 * fetched from the PS's aauth-person.json. Ed25519 only.
 */
export async function verifyAttestation(
  jwt: string,
  jwks: JWK[],
): Promise<Record<string, unknown> | null> {
  const parsed = decodeUnverified(jwt);
  if (!parsed) return null;
  if (parsed.header.alg !== 'EdDSA') return null;
  if (parsed.header.typ !== 'aauth-budget-attestation+jwt') return null;
  const kid = parsed.header.kid as string | undefined;
  const candidates = kid ? jwks.filter((k) => k.kid === kid || !k.kid) : jwks;
  for (const jwk of candidates.length ? candidates : jwks) {
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') continue;
    try {
      const key = await importPublicJwk(jwk);
      const { payload } = await compactVerify(jwt, key);
      const claims = JSON.parse(dec.decode(payload)) as Record<string, unknown>;
      if (typeof claims.exp === 'number' && claims.exp < now()) return null;
      return claims;
    } catch {
      // try the next key
    }
  }
  return null;
}

export { decodeUnverified, jwkThumbprint };
