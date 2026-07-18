import type { Context, MiddlewareHandler } from 'hono';
import { accountTuples, writeTuples } from './authz';
import type { AppEnv } from './types';

export interface SessionUser {
  id: string;
  balance_credits: number;
}

// No free credits: accounts start empty and top up via Stripe ($1 minimum).
const STARTER_BALANCE = 0;

/** Validate the AuthGravity session by forwarding the cookie (or bearer session id). */
export async function whoami(c: Context<AppEnv>): Promise<string | null> {
  const headers: Record<string, string> = {};
  const cookie = c.req.header('cookie');
  const auth = c.req.header('authorization');
  if (cookie) headers.cookie = cookie;
  if (auth) headers.authorization = auth;
  if (!cookie && !auth) return null;
  const res = await fetch(`${c.env.AUTHGRAVITY_URL}/v1/whoami`, { headers });
  if (!res.ok) return null;
  const body = (await res.json()) as { user_id?: string };
  return body.user_id ?? null;
}

export async function ensureUser(c: Context<AppEnv>, userId: string): Promise<SessionUser> {
  const inserted = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO users (id, balance_credits) VALUES (?, ?)',
  )
    .bind(userId, STARTER_BALANCE)
    .run();
  if (inserted.meta.changes > 0) {
    c.executionCtx.waitUntil(writeTuples(c.env, accountTuples(userId)));
  }
  const user = await c.env.DB.prepare('SELECT id, balance_credits FROM users WHERE id = ?')
    .bind(userId)
    .first<SessionUser>();
  return user!;
}

export function loginRedirect(c: Context<AppEnv>): Response {
  const returnTo = encodeURIComponent(c.req.url);
  return c.redirect(`${c.env.AUTHGRAVITY_URL}/login?return_to=${returnTo}`);
}

/** Session-gated pages: resolves the user or redirects to hosted login. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const userId = await whoami(c);
  if (!userId) return loginRedirect(c);
  c.set('user', await ensureUser(c, userId));
  await next();
};
