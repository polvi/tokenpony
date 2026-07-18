import type { Context } from 'hono';
import type { AppEnv, Bindings } from './types';

/**
 * AuthGravity relationship-based authorization (Zanzibar-style).
 *
 * Schema (tenant tokenpony.dev):
 *   account:<user_id>      owner/viewer            → admin, view
 *   application:<client_id> owner/editor/viewer/account → admin, edit, view, use
 *   grant:<grant_id>       account/application/approver → admin, view, revoke, spend
 *
 * Tuples are written best-effort from the management plane (signup, app
 * registration, grant issuance). Writes need the AUTHGRAVITY_SERVICE_TOKEN
 * secret (agk_…); without it everything degrades to the local D1 checks.
 */

interface TupleUpdate {
  op: 'touch' | 'create' | 'delete';
  object: string;
  relation: string;
  subject: string;
}

export async function writeTuples(env: Bindings, updates: TupleUpdate[]): Promise<void> {
  if (!env.AUTHGRAVITY_SERVICE_TOKEN) return;
  try {
    const res = await fetch(`${env.AUTHGRAVITY_URL}/v1/authz/relationships`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.AUTHGRAVITY_SERVICE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ updates }),
    });
    if (!res.ok) {
      console.log(
        JSON.stringify({ event: 'authz_write_failed', status: res.status, body: await res.text() }),
      );
    }
  } catch (err) {
    console.log(JSON.stringify({ event: 'authz_write_error', error: String(err) }));
  }
}

/**
 * Check a permission for the calling user's session by forwarding their
 * credentials. Returns null when authz can't answer (unconfigured tenant,
 * network error) so callers can fall back to local checks.
 */
export async function checkPermission(
  c: Context<AppEnv>,
  object: string,
  permission: string,
): Promise<boolean | null> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const cookie = c.req.header('cookie');
  const auth = c.req.header('authorization');
  if (cookie) headers.cookie = cookie;
  if (auth) headers.authorization = auth;
  try {
    const res = await fetch(`${c.env.AUTHGRAVITY_URL}/v1/authz/check`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ object, permission }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { allowed?: boolean };
    return typeof body.allowed === 'boolean' ? body.allowed : null;
  } catch (err) {
    console.log(JSON.stringify({ event: 'authz_check_error', error: String(err) }));
    return null;
  }
}

export const accountTuples = (userId: string): TupleUpdate[] => [
  { op: 'touch', object: `account:${userId}`, relation: 'owner', subject: `user:${userId}` },
];

export const applicationTuples = (clientId: string, ownerUserId: string): TupleUpdate[] => [
  { op: 'touch', object: `application:${clientId}`, relation: 'owner', subject: `user:${ownerUserId}` },
  { op: 'touch', object: `application:${clientId}`, relation: 'account', subject: `account:${ownerUserId}` },
];

export const grantTuples = (
  grantId: string,
  userId: string,
  clientId: string,
): TupleUpdate[] => [
  { op: 'touch', object: `grant:${grantId}`, relation: 'account', subject: `account:${userId}` },
  { op: 'touch', object: `grant:${grantId}`, relation: 'application', subject: `application:${clientId}` },
  { op: 'touch', object: `grant:${grantId}`, relation: 'approver', subject: `user:${userId}` },
];
