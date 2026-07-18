/**
 * DPoP (RFC 9449) proof verification, ES256 only.
 *
 * A proof is a JWS whose header carries the public JWK. Verifying yields the
 * key thumbprint (jkt); tokens are bound by storing that thumbprint and
 * requiring a fresh proof from the same key on use.
 */

const td = new TextDecoder();

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Uint8Array.from(atob(b64 + pad), (ch) => ch.charCodeAt(0));
}

function bytesToB64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

async function sha256B64url(input: string): Promise<string> {
  return bytesToB64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

/** RFC 7638 thumbprint of an EC JWK. */
export async function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return sha256B64url(canonical);
}

export interface DpopCheck {
  proof: string;
  htm: string;
  htu: string;
  accessToken?: string;
}

/** Verify a DPoP proof; returns the key thumbprint or null if invalid. */
export async function verifyDpopProof({ proof, htm, htu, accessToken }: DpopCheck): Promise<string | null> {
  try {
    const [h, p, s] = proof.split('.');
    if (!h || !p || !s) return null;
    const header = JSON.parse(td.decode(b64urlToBytes(h))) as {
      typ?: string;
      alg?: string;
      jwk?: { kty?: string; crv?: string; x?: string; y?: string };
    };
    if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256') return null;
    const jwk = header.jwk;
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return null;

    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64urlToBytes(s) as unknown as ArrayBuffer,
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(td.decode(b64urlToBytes(p))) as {
      htm?: string;
      htu?: string;
      iat?: number;
      jti?: string;
      ath?: string;
    };
    if (payload.htm?.toUpperCase() !== htm.toUpperCase()) return null;
    // Compare htu without query or fragment, per RFC 9449.
    const norm = (u: string) => {
      const url = new URL(u);
      return `${url.origin}${url.pathname}`;
    };
    if (!payload.htu || norm(payload.htu) !== norm(htu)) return null;
    if (!payload.jti || typeof payload.iat !== 'number') return null;
    if (Math.abs(Date.now() / 1000 - payload.iat) > 300) return null;
    if (accessToken !== undefined) {
      if (payload.ath !== (await sha256B64url(accessToken))) return null;
    }
    return jwkThumbprint(jwk as { crv: string; kty: string; x: string; y: string });
  } catch {
    return null;
  }
}
