import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  buildAuthorizeUrl,
  discover,
  exchangeCode,
  registerClient,
  type TpxDiscovery,
} from '@tokenpony/tpx';
import { chatPage, connectPage } from './ui';

type AppEnv = { Bindings: Env };

interface StoredClient {
  client_id: string;
  client_secret: string;
}

interface GrantCookie {
  token: string;
  api_base: string;
  issuer: string;
  budget: number;
}

interface StateCookie {
  state: string;
  issuer: string;
}

const app = new Hono<AppEnv>();

const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' } as const;

function readJsonCookie<T>(c: Parameters<typeof getCookie>[0], name: string): T | null {
  const raw = getCookie(c, name);
  if (!raw) return null;
  try {
    return JSON.parse(atob(raw)) as T;
  } catch {
    return null;
  }
}

function writeJsonCookie(c: Parameters<typeof setCookie>[0], name: string, value: unknown, maxAge: number) {
  setCookie(c, name, btoa(JSON.stringify(value)), { ...COOKIE_OPTS, maxAge });
}

/** Get (or lazily create) this app's client registration with a provider. */
async function clientFor(env: Env, discovery: TpxDiscovery): Promise<StoredClient> {
  const kvKey = `client:${discovery.issuer}`;
  const cached = await env.PONYCHAT_KV.get<StoredClient>(kvKey, 'json');
  if (cached) return cached;
  const reg = await registerClient(discovery, {
    name: 'Pony Chat',
    redirect_uris: [`${env.APP_URL}/callback`],
  });
  await env.PONYCHAT_KV.put(kvKey, JSON.stringify(reg));
  return reg;
}

app.onError((err, c) => {
  console.log(JSON.stringify({ event: 'unhandled_error', path: c.req.path, error: String(err) }));
  return c.html(connectPage(c.env.DEFAULT_ISSUER, `Something went wrong: ${String(err)}`), 500);
});

app.get('/', (c) => {
  const grant = readJsonCookie<GrantCookie>(c, 'tpx_grant');
  if (!grant) return c.html(connectPage(c.env.DEFAULT_ISSUER));
  return c.html(chatPage(grant.issuer, grant.budget));
});

app.post('/connect', async (c) => {
  const form = await c.req.parseBody();
  let issuer: string;
  try {
    issuer = new URL(String(form.issuer)).origin;
  } catch {
    return c.html(connectPage(c.env.DEFAULT_ISSUER, 'That provider URL is not valid.'), 400);
  }
  const budget = Number(form.budget) || 100_000;

  let discovery: TpxDiscovery;
  let client: StoredClient;
  try {
    discovery = await discover(issuer);
    client = await clientFor(c.env, discovery);
  } catch (err) {
    return c.html(
      connectPage(c.env.DEFAULT_ISSUER, `${issuer} doesn't speak TPX: ${String(err)}`),
      502,
    );
  }

  const state = crypto.randomUUID();
  writeJsonCookie(c, 'tpx_state', { state, issuer } satisfies StateCookie, 600);
  return c.redirect(
    buildAuthorizeUrl(discovery, {
      client_id: client.client_id,
      redirect_uri: `${c.env.APP_URL}/callback`,
      state,
      budget,
    }),
  );
});

app.get('/callback', async (c) => {
  const saved = readJsonCookie<StateCookie>(c, 'tpx_state');
  deleteCookie(c, 'tpx_state', COOKIE_OPTS);
  const { code, state, error } = c.req.query();

  if (error === 'access_denied')
    return c.html(connectPage(c.env.DEFAULT_ISSUER, 'You denied the request — no grant issued.'));
  if (!saved || !code || state !== saved.state)
    return c.html(connectPage(c.env.DEFAULT_ISSUER, 'State mismatch — try connecting again.'), 400);

  try {
    const discovery = await discover(saved.issuer);
    const client = await clientFor(c.env, discovery);
    const grant = await exchangeCode(discovery, {
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: `${c.env.APP_URL}/callback`,
    });
    writeJsonCookie(
      c,
      'tpx_grant',
      {
        token: grant.access_token,
        api_base: grant.api_base,
        issuer: saved.issuer,
        budget: grant.budget,
      } satisfies GrantCookie,
      60 * 60 * 24 * 30,
    );
    return c.redirect('/');
  } catch (err) {
    return c.html(connectPage(c.env.DEFAULT_ISSUER, `Token exchange failed: ${String(err)}`), 502);
  }
});

app.post('/disconnect', (c) => {
  deleteCookie(c, 'tpx_grant', COOKIE_OPTS);
  return c.redirect('/');
});

// Proxy the provider's model list (grant token stays in the HttpOnly cookie).
app.get('/models', async (c) => {
  const grant = readJsonCookie<GrantCookie>(c, 'tpx_grant');
  if (!grant) return c.json({ error: { code: 'not_connected', message: 'Connect a provider' } }, 401);
  const res = await fetch(`${grant.api_base}/models`);
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

// Proxy chat completions, streaming SSE straight through.
app.post('/chat', async (c) => {
  const grant = readJsonCookie<GrantCookie>(c, 'tpx_grant');
  if (!grant) return c.json({ error: { code: 'not_connected', message: 'Connect a provider' } }, 401);
  const body = await c.req.json<{ model: string; messages: unknown[] }>();
  const res = await fetch(`${grant.api_base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${grant.token}`,
    },
    body: JSON.stringify({ model: body.model, messages: body.messages, stream: true }),
  });
  return new Response(res.body, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
});

export default app;
