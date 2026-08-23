import type { Context, MiddlewareHandler } from 'hono';
import { accountTuples, writeTuples } from './authz';
import type { AppEnv } from './types';

export interface SessionUser {
  id: string;
  balance_credits: number;
}

// No free credits: accounts start empty and top off via Stripe ($1 minimum).
const STARTER_BALANCE = 0;

/** Tailnet users are `ts:<login>`; AuthGravity users keep their UUID. */
export const tailnetUserId = (login: string) => `ts:${login}`;

/**
 * Who is signed in: the tailnet identity when the platform vouches for one
 * (self-hosted only, see TailnetBinding), else the AuthGravity session.
 */
export async function whoami(c: Context<AppEnv>): Promise<string | null> {
  if (c.env.TAILNET) {
    const who = await c.env.TAILNET.identity(c.req.raw).catch(() => null);
    if (who?.login) return tailnetUserId(who.login);
  }
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
  // Native sign-in screen (this worker's /login); AuthGravity is called from
  // the browser there, so nobody leaves the app to authenticate.
  const returnTo = encodeURIComponent(c.req.url);
  return c.redirect(`/login?return_to=${returnTo}`);
}

/** Session-gated pages: resolves the user or redirects to hosted login. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const userId = await whoami(c);
  if (!userId) return loginRedirect(c);
  c.set('user', await ensureUser(c, userId));
  await next();
};
