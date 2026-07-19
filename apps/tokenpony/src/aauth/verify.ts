import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { mintResourceToken, verifySelfJws, type BudgetEntry, type MissionRef } from './jws';
import { verifyHttpSignature, verifyAgentToken, parseSignatureKey } from './httpsig';
import { requireActiveMission, type MissionRow } from './missions';
import { fetchAgentJwks } from './psfetch';
import { jwkThumbprint } from './keys';
import type { JWK } from 'jose';

/**
 * Verify an inbound AAuth request at the resource: the aa-auth+jwt in
 * `Authorization: AAuth <token>`, the RFC 9421 signature (proof of possession vs
 * the token's cnf.jwk), and the mission's active state. Shared by the inference
 * path and GET /grant.
 */

export type AAuthAuth =
  | { kind: 'none' } // no AAuth Authorization header; caller falls through
  | { kind: 'error'; status: number; code: string; message: string }
  | {
      kind: 'ok';
      mission: MissionRow;
      budget: BudgetEntry;
      agent: string;
      missionRef: MissionRef;
    };

export function getAAuthToken(c: Context<AppEnv>): string | null {
  const h = c.req.header('authorization') ?? '';
  const m = h.match(/^AAuth\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function authenticateAAuth(c: Context<AppEnv>): Promise<AAuthAuth> {
  const token = getAAuthToken(c);
  if (!token) return { kind: 'none' };

  const claims = await verifySelfJws(c.env, token, 'aa-auth+jwt');
  if (!claims) return { kind: 'error', status: 401, code: 'invalid_token', message: 'auth token failed verification' };

  const cnf = (claims.cnf as { jwk?: JWK } | undefined)?.jwk;
  const missionRef = claims.mission as MissionRef | undefined;
  const budget = claims.budget as BudgetEntry | undefined;
  const agent = claims.agent as string | undefined;
  if (!cnf || !missionRef?.approver || !missionRef?.s256 || !budget || !agent)
    return { kind: 'error', status: 401, code: 'invalid_token', message: 'auth token malformed' };

  // Proof of possession: the request must be RFC 9421-signed by cnf.jwk.
  const sig = await verifyHttpSignature(
    c.env,
    { method: c.req.method, url: c.req.url, headers: c.req.raw.headers },
    cnf,
  );
  if (!sig.ok)
    return { kind: 'error', status: 401, code: 'invalid_token', message: `http signature: ${sig.reason}` };

  const gate = await requireActiveMission(c.env.DB, missionRef);
  if (!gate.ok) {
    const code = gate.code === 'not_found' ? 'invalid_token' : gate.code;
    return { kind: 'error', status: 401, code, message: 'mission not active' };
  }
  return { kind: 'ok', mission: gate.mission, budget, agent, missionRef };
}

/** 401 with an AAuth challenge (seam contract section 8.4 style). */
export function aauthUnauthorized(c: Context<AppEnv>, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    {
      status: 401,
      headers: {
        'www-authenticate': `AAuth error="${code}", resource_metadata="${c.env.ISSUER}/.well-known/aauth-resource.json"`,
      },
    },
  );
}

/** Parse `AAuth-Mission: approver="<iss>"; s256="<b64url>"`. */
export function parseMissionHeader(h: string | undefined): MissionRef | undefined {
  if (!h) return undefined;
  const approver = h.match(/approver="([^"]+)"/)?.[1];
  const s256 = h.match(/s256="([^"]+)"/)?.[1];
  return approver && s256 ? { approver, s256 } : undefined;
}

/**
 * Build the 401 resource challenge (seam contract section 3): mint an
 * aa-resource+jwt bound to the requesting agent (from Signature-Key) and
 * echoing any AAuth-Mission ref, so the agent can take it to its PS. Falls back
 * to a bare metadata pointer when the request is not agent-signed.
 */
export async function buildAAuthChallenge(c: Context<AppEnv>): Promise<Response> {
  const sigKey = c.req.header('signature-key');
  const sigInput = c.req.header('signature-input');
  const label = sigInput?.split('=')[0]?.trim();
  const agentJwt = sigKey && label ? parseSignatureKey(sigKey, label) : null;

  if (agentJwt) {
    const agent = await verifyAgentToken(agentJwt, fetchAgentJwks);
    if (agent) {
      const jkt = await jwkThumbprint(agent.cnfJwk);
      const mission = parseMissionHeader(c.req.header('aauth-mission'));
      const resourceToken = await mintResourceToken(c.env, {
        resource: c.env.ISSUER,
        tokenEndpoint: `${c.env.ISSUER}/token`,
        agent: `${agent.iss}#${agent.sub}`,
        agentJkt: jkt,
        scope: 'inference',
        mission,
      });
      return Response.json(
        { error: { code: 'auth_token_required', message: 'take the resource-token to your Person Server' } },
        {
          status: 401,
          headers: {
            'www-authenticate': `AAuth resource_metadata="${c.env.ISSUER}/.well-known/aauth-resource.json"`,
            'aauth-requirement': `requirement=auth-token; resource-token="${resourceToken}"`,
          },
        },
      );
    }
  }
  return aauthUnauthorized(c, 'auth_token_required', 'agent-sign the request to receive a resource-token');
}
