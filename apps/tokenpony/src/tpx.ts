import { Hono } from 'hono';
import { esc, page } from './html';
import { digestsEqual, jsonError, randomToken, sha256Hex } from './util';
import { grantTuples, writeTuples } from './authz';
import { loginRedirect, ensureUser, whoami } from './auth';
import type { AppEnv } from './types';

const MAX_BUDGET = 10_000_000;
const CODE_TTL_MS = 5 * 60 * 1000;

export function discoveryDoc(issuer: string) {
  return {
    tpx_version: '0.1',
    issuer,
    authorization_endpoint: `${issuer}/tpx/authorize`,
    token_endpoint: `${issuer}/tpx/token`,
    registration_endpoint: `${issuer}/tpx/register`,
    api_base: `${issuer}/v1`,
    models_endpoint: `${issuer}/v1/models`,
  };
}

interface AppRow {
  client_id: string;
  client_secret_hash: string;
  name: string;
  redirect_uris: string;
}

async function loadApp(c: { env: { DB: D1Database } }, clientId: string): Promise<AppRow | null> {
  return c.env.DB.prepare(
    'SELECT client_id, client_secret_hash, name, redirect_uris FROM apps WHERE client_id = ?',
  )
    .bind(clientId)
    .first<AppRow>();
}

function validRedirect(app: AppRow, uri: string): boolean {
  return (JSON.parse(app.redirect_uris) as string[]).includes(uri);
}

export const tpx = new Hono<AppEnv>();

// -- Dynamic client registration (open in the PoC) ---------------------------

tpx.post('/register', async (c) => {
  let body: { name?: string; redirect_uris?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(400, 'invalid_request', 'Body must be JSON');
  }
  const name = body.name?.trim();
  const uris = body.redirect_uris;
  if (!name || !Array.isArray(uris) || uris.length === 0)
    return jsonError(400, 'invalid_request', '`name` and `redirect_uris` are required');
  for (const uri of uris) {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return jsonError(400, 'invalid_request', `Invalid redirect_uri: ${uri}`);
    }
    const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !isLocal)
      return jsonError(400, 'invalid_request', 'redirect_uris must be https (or localhost)');
  }

  const clientId = randomToken('app_');
  const clientSecret = randomToken('cs_');
  await c.env.DB.prepare(
    'INSERT INTO apps (client_id, client_secret_hash, name, redirect_uris) VALUES (?, ?, ?, ?)',
  )
    .bind(clientId, await sha256Hex(clientSecret), name, JSON.stringify(uris))
    .run();
  return c.json({ client_id: clientId, client_secret: clientSecret });
});

// -- Authorization + consent -------------------------------------------------

tpx.get('/authorize', async (c) => {
  const q = c.req.query();
  const app = q.client_id ? await loadApp(c, q.client_id) : null;
  if (!app) return jsonError(400, 'invalid_client', 'Unknown client_id');
  if (!q.redirect_uri || !validRedirect(app, q.redirect_uri))
    return jsonError(400, 'invalid_request', 'redirect_uri is not registered for this client');
  const budget = Number(q.budget);
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET)
    return jsonError(400, 'invalid_request', `budget must be an integer 1..${MAX_BUDGET}`);
  if (!q.state) return jsonError(400, 'invalid_request', 'state is required');

  const userId = await whoami(c);
  if (!userId) return loginRedirect(c);
  const user = await ensureUser(c, userId);

  const hidden = ['client_id', 'redirect_uri', 'state', 'budget']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k]!)}">`)
    .join('');

  return c.html(
    page(
      'Authorize · tokenpony',
      `<p class="eyebrow">Authorization request</p>
<h1>${esc(app.name)} is asking for a token budget.</h1>
<div class="card">
  <p><strong>${esc(app.name)}</strong> wants to spend up to
     <strong>${budget.toLocaleString('en-US')} tokens</strong> from your tokenpony balance.</p>
  <p class="muted">Your balance: ${user.balance_tokens.toLocaleString('en-US')} tokens.
     The app never sees your keys or your identity, only this metered budget.
     You can revoke it any time from your dashboard.</p>
  <div class="row" style="margin-top:1rem">
    <form method="post" action="/tpx/decision">${hidden}
      <input type="hidden" name="decision" value="approve">
      <button type="submit">Approve ${budget.toLocaleString('en-US')} tokens</button>
    </form>
    <form method="post" action="/tpx/decision">${hidden}
      <input type="hidden" name="decision" value="deny">
      <button type="submit" class="quiet">Deny</button>
    </form>
  </div>
</div>
<p class="muted">Redirects to <code>${esc(q.redirect_uri)}</code></p>`,
    ),
  );
});

tpx.post('/decision', async (c) => {
  const form = await c.req.parseBody();
  const clientId = String(form.client_id ?? '');
  const redirectUri = String(form.redirect_uri ?? '');
  const state = String(form.state ?? '');
  const budget = Number(form.budget);

  const app = await loadApp(c, clientId);
  if (!app || !validRedirect(app, redirectUri) || !state)
    return jsonError(400, 'invalid_request', 'Invalid authorization parameters');
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET)
    return jsonError(400, 'invalid_request', 'Invalid budget');

  const userId = await whoami(c);
  if (!userId) return loginRedirect(c);
  await ensureUser(c, userId);

  const dest = new URL(redirectUri);
  dest.searchParams.set('state', state);

  if (form.decision !== 'approve') {
    dest.searchParams.set('error', 'access_denied');
    return c.redirect(dest.toString());
  }

  const code = randomToken('tpxc_');
  await c.env.DB.prepare(
    'INSERT INTO auth_codes (code, client_id, user_id, budget, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(code, clientId, userId, budget, redirectUri, new Date(Date.now() + CODE_TTL_MS).toISOString())
    .run();
  dest.searchParams.set('code', code);
  return c.redirect(dest.toString());
});

// -- Token exchange ----------------------------------------------------------

tpx.post('/token', async (c) => {
  let body: {
    grant_type?: string;
    code?: string;
    client_id?: string;
    client_secret?: string;
    redirect_uri?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(400, 'invalid_request', 'Body must be JSON');
  }
  if (body.grant_type !== 'authorization_code')
    return jsonError(400, 'unsupported_grant_type', "Only 'authorization_code' is supported");
  if (!body.code || !body.client_id || !body.client_secret || !body.redirect_uri)
    return jsonError(400, 'invalid_request', 'code, client_id, client_secret, redirect_uri required');

  const app = await loadApp(c, body.client_id);
  if (!app || !digestsEqual(app.client_secret_hash, await sha256Hex(body.client_secret)))
    return jsonError(401, 'invalid_client', 'Bad client credentials');

  const row = await c.env.DB.prepare('SELECT * FROM auth_codes WHERE code = ?')
    .bind(body.code)
    .first<{
      code: string;
      client_id: string;
      user_id: string;
      budget: number;
      redirect_uri: string;
      expires_at: string;
      used: number;
    }>();
  if (!row || row.client_id !== body.client_id || row.redirect_uri !== body.redirect_uri)
    return jsonError(400, 'invalid_grant', 'Unknown authorization code');
  if (row.used) return jsonError(400, 'invalid_grant', 'Authorization code already used');
  if (Date.parse(row.expires_at) < Date.now())
    return jsonError(400, 'invalid_grant', 'Authorization code expired');

  const token = randomToken('tpx_');
  const grantId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE auth_codes SET used = 1 WHERE code = ?').bind(row.code),
    c.env.DB.prepare(
      'INSERT INTO grants (id, token_hash, client_id, user_id, budget_total) VALUES (?, ?, ?, ?, ?)',
    ).bind(grantId, await sha256Hex(token), row.client_id, row.user_id, row.budget),
  ]);
  c.executionCtx.waitUntil(writeTuples(c.env, grantTuples(grantId, row.user_id, row.client_id)));

  return c.json({
    access_token: token,
    token_type: 'bearer',
    budget: row.budget,
    budget_used: 0,
    api_base: `${c.env.ISSUER}/v1`,
  });
});
