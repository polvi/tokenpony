import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { amountToCredits } from '../pricing';
import { bindOrCheckBudget } from './missions';
import { mintAuthToken, verifySelfJws, type BudgetEntry, type MissionRef } from './jws';
import { verifyAgentToken } from './httpsig';
import { verifyAttestation } from './jws';
import { fetchAgentJwks, fetchPersonJwks } from './psfetch';
import { jwkThumbprint } from './keys';
import type { JWK } from 'jose';

/**
 * PS -> AS budget relay (seam contract section 4). The Person Server POSTs
 * {resource_token, agent_token, budget_attestation} to our /token endpoint; we
 * verify the chain, bind the mission's budget, and mint the budgeted aa-auth+jwt.
 * Returns null when the request is not an AAuth relay (fall through to OAuth).
 */

function relayError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status });
}

function sameMission(a: unknown, b: MissionRef): boolean {
  const m = a as MissionRef | undefined;
  return !!m && m.approver === b.approver && m.s256 === b.s256;
}

export async function handleBudgetRelay(c: Context<AppEnv>): Promise<Response | null> {
  const ct = c.req.header('content-type') ?? '';
  if (!ct.includes('application/json')) return null; // OAuth /token is form-encoded
  let body: { resource_token?: string; agent_token?: string; budget_attestation?: string };
  try {
    body = await c.req.json();
  } catch {
    return relayError(400, 'invalid_request', 'Body must be JSON');
  }
  if (!body.budget_attestation && !body.resource_token) return null; // not a relay
  if (!body.resource_token || !body.agent_token || !body.budget_attestation)
    return relayError(400, 'invalid_request', 'resource_token, agent_token, budget_attestation required');

  const issuer = c.env.ISSUER;
  const tokenUrl = `${issuer}/token`;

  // (1) our own resource_token: signature, unexpired, mission ref + agent binding, iss == us.
  const rt = await verifySelfJws(c.env, body.resource_token, 'aa-resource+jwt');
  if (!rt) return relayError(401, 'invalid_resource_token', 'resource_token failed verification');
  if (rt.iss !== issuer) return relayError(401, 'invalid_resource_token', 'resource_token iss mismatch');
  const missionRef = rt.mission as MissionRef | undefined;
  if (!missionRef?.approver || !missionRef?.s256)
    return relayError(400, 'invalid_resource_token', 'resource_token has no mission ref');
  const rtAgentJkt = rt.agent_jkt as string | undefined;
  const rtAgent = rt.agent as string | undefined;
  if (!rtAgentJkt || !rtAgent) return relayError(400, 'invalid_resource_token', 'resource_token missing agent binding');

  // (2) agent_token via its JWKS; thumbprint(cnf) == resource_token.agent_jkt.
  const agent = await verifyAgentToken(body.agent_token, fetchAgentJwks);
  if (!agent) return relayError(401, 'invalid_agent_token', 'agent_token failed verification');
  const cnfJkt = await jwkThumbprint(agent.cnfJwk);
  if (cnfJkt !== rtAgentJkt) return relayError(401, 'invalid_agent_token', 'agent key does not match resource_token');

  // (3) budget_attestation against the PS JWKS.
  const attClaims0 = await peekAttestation(body.budget_attestation);
  if (!attClaims0?.iss) return relayError(401, 'invalid_attestation', 'attestation has no iss');
  const psJwks: JWK[] = await fetchPersonJwks(attClaims0.iss);
  if (!psJwks.length) return relayError(401, 'invalid_attestation', 'cannot fetch PS JWKS');
  const att = await verifyAttestation(body.budget_attestation, psJwks);
  if (!att) return relayError(401, 'invalid_attestation', 'attestation signature failed');
  if (att.aud !== tokenUrl) return relayError(401, 'invalid_attestation', 'attestation aud mismatch');
  if (att.agent_jkt !== rtAgentJkt) return relayError(401, 'invalid_attestation', 'attestation agent_jkt mismatch');
  if (!sameMission(att.mission, missionRef)) return relayError(401, 'invalid_attestation', 'attestation mission mismatch');
  const budget = att.budget as BudgetEntry | undefined;
  if (!budget || budget.currency !== 'USD') return relayError(400, 'invalid_budget', 'budget must be USD');
  if (budget.resource !== issuer || att.resource !== issuer)
    return relayError(400, 'invalid_budget', 'budget.resource must equal this resource origin');

  // Single-use attestation jti (relay replay protection).
  const jti = String(att.jti ?? '');
  if (!jti) return relayError(400, 'invalid_attestation', 'attestation has no jti');
  const exp = typeof att.exp === 'number' ? att.exp : Math.floor(Date.now() / 1000) + 60;
  const ins = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO aauth_attestations (jti, expires_at) VALUES (?, ?)',
  )
    .bind(jti, exp)
    .run();
  if (ins.meta.changes === 0) return relayError(401, 'invalid_attestation', 'attestation replayed');

  // (4) bind the budget (first token wins) and mint.
  let budgetTotal: number;
  try {
    budgetTotal = amountToCredits(budget.amount);
  } catch (e) {
    return relayError(400, 'invalid_budget', String((e as Error).message));
  }
  const bound = await bindOrCheckBudget(c.env.DB, {
    ref: missionRef,
    budget,
    budgetTotal,
    agentIss: agent.iss,
    agentSub: agent.sub,
  });
  if ('error' in bound) {
    if (bound.error === 'budget_mismatch')
      return relayError(409, 'budget_mismatch', 'a different budget is already bound to this mission');
    return relayError(500, 'mission_error', bound.error);
  }
  const mission = bound.mission;
  if (mission.status !== 'active')
    return relayError(403, `mission_${mission.status}`, 'mission is not active');

  const minted = await mintAuthToken(c.env, {
    resource: issuer,
    agent: rtAgent,
    mission: missionRef,
    budget,
    cnfJwk: agent.cnfJwk,
    scope: 'inference',
  });
  await c.env.DB.prepare(
    'INSERT INTO aauth_tokens (id, mission_id, jti, cnf_jkt, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(crypto.randomUUID(), mission.id, minted.jti, cnfJkt, minted.exp, Date.now())
    .run();

  const funded = mission.user_id !== null;
  const fundingUrl = `${issuer}/fund?approver=${encodeURIComponent(missionRef.approver)}&s256=${encodeURIComponent(missionRef.s256)}`;
  return Response.json({
    auth_token: minted.token,
    token_type: 'AAuth',
    expires_in: minted.exp - Math.floor(Date.now() / 1000),
    funded,
    ...(funded ? {} : { funding_url: fundingUrl }),
  });
}

/** Decode (unverified) just to read the attestation's iss before fetching JWKS. */
async function peekAttestation(jwt: string): Promise<{ iss?: string } | null> {
  try {
    const p = jwt.split('.')[1];
    const b64 = p.replaceAll('-', '+').replaceAll('_', '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(pad)) as { iss?: string };
  } catch {
    return null;
  }
}
