import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  buildAuthorizeUrl,
  challengeS256,
  discover,
  exchangeCode,
  generateVerifier,
  introspect,
  pushAuthorizationRequest,
  refreshGrant,
  registerClient,
  revoke,
  TpxError,
  type ClientAuth,
  type TokenResponse,
  type TpxDiscovery,
} from '@tokenpony/tpx';
import { chatPage, connectPage } from './ui';
import { GUIDE_SYSTEM_PROMPT } from './knowledge';

type AppEnv = { Bindings: Env };

interface StoredClient {
  client_id: string;
  client_secret?: string;
}

interface GrantCookie {
  rt: string;
  at: string;
  at_exp: number; // ms epoch
  budget: number; // USD (TPX v0.3)
  resource: string;
  as_issuer: string;
}

interface StateCookie {
  state: string;
  verifier: string;
  origin: string; // user-entered resource origin
  as_issuer: string;
}

const app = new Hono<AppEnv>();

const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' } as const;

function readJsonCookie<T>(c: Context<AppEnv>, name: string): T | null {
  const raw = getCookie(c, name);
  if (!raw) return null;
  try {
    return JSON.parse(atob(raw)) as T;
  } catch {
    return null;
  }
}

function grantCookieValue(value: unknown): string {
  return btoa(JSON.stringify(value));
}

function writeJsonCookie(c: Context<AppEnv>, name: string, value: unknown, maxAge: number) {
  setCookie(c, name, grantCookieValue(value), { ...COOKIE_OPTS, maxAge });
}

/** Get (or lazily create) this app's client registration with a provider. */
async function clientFor(env: Env, disco: TpxDiscovery): Promise<ClientAuth> {
  const kvKey = `client:v2:${disco.as.issuer}`;
  const cached = await env.PONYCHAT_KV.get<StoredClient>(kvKey, 'json');
  if (cached) return cached;
  const reg = await registerClient(disco.as, {
    client_name: 'Pony Chat',
    redirect_uris: [`${env.APP_URL}/callback`],
    token_endpoint_auth_method: 'client_secret_basic',
  });
  const client: StoredClient = { client_id: reg.client_id, client_secret: reg.client_secret };
  await env.PONYCHAT_KV.put(kvKey, JSON.stringify(client));
  return client;
}

function grantFromTokens(tokens: TokenResponse, resource: string, asIssuer: string): GrantCookie {
  return {
    rt: tokens.refresh_token,
    at: tokens.access_token,
    at_exp: Date.now() + tokens.expires_in * 1000,
    budget: tokens.authorization_details?.[0]?.budget ?? 0,
    resource,
    as_issuer: asIssuer,
  };
}

/**
 * Ensure the grant has a live access token, refreshing (with rotation)
 * when it is near expiry. Returns null when the grant is dead.
 */
async function freshGrant(
  c: Context<AppEnv>,
  grant: GrantCookie,
): Promise<{ grant: GrantCookie; refreshed: boolean } | null> {
  if (grant.at_exp - Date.now() > 60_000) return { grant, refreshed: false };
  try {
    const disco = await discover(grant.resource);
    const client = await clientFor(c.env, disco);
    const tokens = await refreshGrant(disco.as, client, grant.rt);
    return { grant: grantFromTokens(tokens, grant.resource, grant.as_issuer), refreshed: true };
  } catch (err) {
    console.log(JSON.stringify({ event: 'refresh_failed', error: String(err) }));
    return null;
  }
}

app.onError((err, c) => {
  console.log(JSON.stringify({ event: 'unhandled_error', path: c.req.path, error: String(err) }));
  return c.html(connectPage(c.env.DEFAULT_ISSUER, `Something went wrong: ${String(err)}`), 500);
});

app.get('/', async (c) => {
  const grant = readJsonCookie<GrantCookie>(c, 'tpx_grant3');
  if (!grant) return c.html(connectPage(c.env.DEFAULT_ISSUER));
  // Show live grant state from introspection when we can get it.
  let used = 0;
  let budget = grant.budget;
  try {
    const disco = await discover(grant.resource);
    const info = await introspect(disco.as, grant.at);
    if (info.active) {
      used = info.budget_used ?? 0;
      budget = info.authorization_details?.[0]?.budget ?? budget;
    }
  } catch {
    // introspection is advisory; the meter still accumulates client-side
  }
  return c.html(chatPage(grant.resource, budget, used));
});

app.post('/connect', async (c) => {
  const form = await c.req.parseBody();
  let origin: string;
  try {
    origin = new URL(String(form.issuer)).origin;
  } catch {
    return c.html(connectPage(c.env.DEFAULT_ISSUER, 'That provider URL is not valid.'), 400);
  }
  // USD budgets from the fixed dropdown; fail closed on tampered forms.
  const BUDGETS = [0.05, 0.1, 0.5];
  const budget = BUDGETS.includes(Number(form.budget)) ? Number(form.budget) : 0.1;

  let disco: TpxDiscovery;
  let client: ClientAuth;
  try {
    disco = await discover(origin);
    client = await clientFor(c.env, disco);
  } catch (err) {
    return c.html(
      connectPage(c.env.DEFAULT_ISSUER, `${origin} doesn't speak TPX: ${String(err)}`),
      502,
    );
  }

  const state = crypto.randomUUID();
  const verifier = generateVerifier();
  let requestUri: string;
  try {
    requestUri = await pushAuthorizationRequest(disco.as, client, {
      redirect_uri: `${c.env.APP_URL}/callback`,
      code_challenge: await challengeS256(verifier),
      resource: disco.resource,
      details: { type: 'llm-inference', budget },
      state,
    });
  } catch (err) {
    return c.html(connectPage(c.env.DEFAULT_ISSUER, `Authorization push failed: ${String(err)}`), 502);
  }

  writeJsonCookie(
    c,
    'tpx_state',
    { state, verifier, origin, as_issuer: disco.as.issuer } satisfies StateCookie,
    600,
  );
  return c.redirect(buildAuthorizeUrl(disco.as, client.client_id, requestUri));
});

app.get('/callback', async (c) => {
  const saved = readJsonCookie<StateCookie>(c, 'tpx_state');
  deleteCookie(c, 'tpx_state', COOKIE_OPTS);
  const { code, state, error, iss } = c.req.query();

  if (error === 'access_denied')
    return c.html(connectPage(c.env.DEFAULT_ISSUER, 'You denied the request, so no grant was issued.'));
  if (!saved || !code || state !== saved.state)
    return c.html(connectPage(c.env.DEFAULT_ISSUER, 'State mismatch. Try connecting again.'), 400);
  // RFC 9207: the code must come from the issuer this flow started with.
  if (iss !== saved.as_issuer)
    return c.html(connectPage(c.env.DEFAULT_ISSUER, 'Issuer mismatch. Try connecting again.'), 400);

  try {
    const disco = await discover(saved.origin);
    const client = await clientFor(c.env, disco);
    const tokens = await exchangeCode(disco.as, client, {
      code,
      redirect_uri: `${c.env.APP_URL}/callback`,
      code_verifier: saved.verifier,
    });
    writeJsonCookie(
      c,
      'tpx_grant3',
      grantFromTokens(tokens, disco.resource, disco.as.issuer),
      60 * 60 * 24 * 30,
    );
    return c.redirect('/');
  } catch (err) {
    return c.html(connectPage(c.env.DEFAULT_ISSUER, `Token exchange failed: ${String(err)}`), 502);
  }
});

app.post('/disconnect', async (c) => {
  const grant = readJsonCookie<GrantCookie>(c, 'tpx_grant3');
  deleteCookie(c, 'tpx_grant3', COOKIE_OPTS);
  // Good citizenship (spec 9.2): revoke the grant we no longer need.
  if (grant) {
    try {
      const disco = await discover(grant.resource);
      const client = await clientFor(c.env, disco);
      c.executionCtx.waitUntil(revoke(disco.as, client, grant.rt));
    } catch {
      // cookie is gone either way
    }
  }
  return c.redirect('/');
});

// Proxy the provider's model list (tokens stay in the HttpOnly cookie).
app.get('/models', async (c) => {
  const grant = readJsonCookie<GrantCookie>(c, 'tpx_grant3');
  if (!grant) return c.json({ error: { code: 'not_connected', message: 'Connect a provider' } }, 401);
  const res = await fetch(`${grant.resource}/models`);
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

// Proxy chat completions, streaming SSE straight through, refreshing the
// short-lived access token as needed.
app.post('/chat', async (c) => {
  const stored = readJsonCookie<GrantCookie>(c, 'tpx_grant3');
  if (!stored) return c.json({ error: { code: 'not_connected', message: 'Connect a provider' } }, 401);
  const fresh = await freshGrant(c, stored);
  if (!fresh) {
    deleteCookie(c, 'tpx_grant3', COOKIE_OPTS);
    return c.json({ error: { code: 'grant_dead', message: 'Grant expired or was revoked. Reconnect to continue.' } }, 401);
  }
  let { grant, refreshed } = fresh;

  const body = await c.req.json<{ model: string; messages: unknown[] }>();
  // Pony Chat doubles as the TPX guide: the knowledge prompt rides along on
  // every request, whichever provider (hosted or local shim) serves it.
  const messages = [{ role: 'system', content: GUIDE_SYSTEM_PROMPT }, ...body.messages];
  const upstream = () =>
    fetch(`${grant.resource}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${grant.at}` },
      body: JSON.stringify({ model: body.model, messages, stream: true }),
    });

  let res = await upstream();
  if (res.status === 401) {
    // Token died early (for example the user revoked and re-granted):
    // one refresh, one retry, per spec 8.4.
    try {
      const disco = await discover(grant.resource);
      const client = await clientFor(c.env, disco);
      const tokens = await refreshGrant(disco.as, client, grant.rt);
      grant = grantFromTokens(tokens, grant.resource, grant.as_issuer);
      refreshed = true;
      res = await upstream();
    } catch (err) {
      if (err instanceof TpxError && err.code === 'invalid_grant') {
        deleteCookie(c, 'tpx_grant3', COOKIE_OPTS);
        return c.json({ error: { code: 'grant_dead', message: 'Grant expired or was revoked. Reconnect to continue.' } }, 401);
      }
      throw err;
    }
  }

  const headers = new Headers({
    'content-type': res.headers.get('content-type') ?? 'text/event-stream',
    'cache-control': 'no-cache',
  });
  if (refreshed) {
    // Rotation happened mid-request; persist the new tokens on this response.
    const maxAge = 60 * 60 * 24 * 30;
    headers.append(
      'set-cookie',
      `tpx_grant3=${grantCookieValue(grant)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
  }
  return new Response(res.body, { status: res.status, headers });
});

export default app;
