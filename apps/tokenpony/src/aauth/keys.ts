import { exportJWK, exportPKCS8, generateKeyPair, importJWK, importPKCS8, type JWK } from 'jose';
import type { Bindings } from '../types';

/**
 * The provider's Ed25519 signing key (used to sign aa-resource+jwt and
 * aa-auth+jwt). Stored in D1 with the private half AES-256-GCM wrapped by a KEK
 * derived from the AAUTH_KEK secret, so a D1 export alone stays worthless. A
 * fixed dev KEK is used when the secret is unset (zero-setup dev/CI).
 */

const DEV_KEK_SEED = 'tokenpony-aauth-dev-kek-v1';

interface KeyRow {
  kid: string;
  public_jwk: string;
  private_wrapped: string;
  kek_id: string;
}

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Uint8Array.from(atob(b64 + pad), (ch) => ch.charCodeAt(0));
}

function bytesToB64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

async function getKek(env: Bindings): Promise<{ key: CryptoKey; kekId: string }> {
  const secret = env.AAUTH_KEK ?? DEV_KEK_SEED;
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  const kekId = env.AAUTH_KEK
    ? bytesToB64url(new Uint8Array(raw).slice(0, 8))
    : 'dev';
  return { key, kekId };
}

async function wrap(kek: CryptoKey, pkcs8: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, new TextEncoder().encode(pkcs8)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return bytesToB64url(out);
}

async function unwrap(kek: CryptoKey, wrapped: string): Promise<string> {
  const bytes = b64urlToBytes(wrapped);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ct);
  return new TextDecoder().decode(pt);
}

/** Newest active signing key; lazily generated on first use. */
export async function getSigningKey(env: Bindings): Promise<SigningKey> {
  const { key: kek, kekId } = await getKek(env);
  const row = await env.DB.prepare(
    'SELECT kid, public_jwk, private_wrapped, kek_id FROM aauth_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1',
  ).first<KeyRow>();

  if (row && row.kek_id === kekId) {
    const pkcs8 = await unwrap(kek, row.private_wrapped);
    const privateKey = await importPKCS8(pkcs8, 'EdDSA');
    return { kid: row.kid, privateKey, publicJwk: JSON.parse(row.public_jwk) as JWK };
  }
  // No key, or the KEK changed (secret rotated): retire the stale row and mint fresh.
  if (row) {
    await env.DB.prepare("UPDATE aauth_keys SET retired_at = ? WHERE kid = ?")
      .bind(Date.now(), row.kid)
      .run();
  }

  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const kid = await jwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = 'EdDSA';
  const pkcs8 = await exportPKCS8(privateKey);
  await env.DB.prepare(
    'INSERT INTO aauth_keys (kid, public_jwk, private_wrapped, kek_id, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(kid, JSON.stringify(publicJwk), await wrap(kek, pkcs8), kekId, Date.now())
    .run();
  return { kid, privateKey, publicJwk };
}

/** Public JWKS (active + recently retired keys, so tokens verify across a rotation). */
export async function getJwks(env: Bindings): Promise<{ keys: JWK[] }> {
  const rows = await env.DB.prepare(
    "SELECT public_jwk FROM aauth_keys WHERE retired_at IS NULL OR retired_at > ? ORDER BY created_at DESC",
  )
    .bind(Date.now() - 3600_000)
    .all<{ public_jwk: string }>();
  const keys = rows.results.map((r) => JSON.parse(r.public_jwk) as JWK);
  // Ensure at least one key exists (lazy-generate on a cold resource).
  if (keys.length === 0) {
    const sk = await getSigningKey(env);
    keys.push(sk.publicJwk);
  }
  return { keys };
}

/** RFC 7638 thumbprint of an OKP (Ed25519) JWK. */
export async function jwkThumbprint(jwk: JWK): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return bytesToB64url(new Uint8Array(digest));
}

/** Import a public JWK (OKP or EC) for verification. */
export async function importPublicJwk(jwk: JWK): Promise<CryptoKey> {
  const alg = jwk.kty === 'OKP' ? 'EdDSA' : 'ES256';
  return importJWK(jwk, alg) as Promise<CryptoKey>;
}

export { b64urlToBytes, bytesToB64url };
