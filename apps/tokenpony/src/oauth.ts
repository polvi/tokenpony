import { Hono } from 'hono';
import type { Context } from 'hono';
import { esc, page } from './html';
import { digestsEqual, randomToken, sha256Hex } from './util';
import { grantTuples, writeTuples } from './authz';
import { loginRedirect, ensureUser, whoami } from './auth';
import { MODELS } from './models';
import { verifyDpopProof } from './dpop';
import { handleBudgetRelay } from './aauth/relay';
import type { AppEnv, Bindings } from './types';

// Budgets are credits (micro-USD): cap a single grant at $10.
const MAX_BUDGET = 10_000_000;
const CODE_TTL_MS = 5 * 60 * 1000;
const PAR_TTL_MS = 90 * 1000;
export const ACCESS_TOKEN_TTL_S = 3600;

// -- RFC 6749 flat errors ----------------------------------------------------

function oauthError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status });
}

// -- Metadata ----------------------------------------------------------------

export function protectedResourceMetadata(issuer: string) {
  return {
    resource: issuer,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    // TPX-A (seam contract section 8): the AAuth budget-state endpoint.
    budget_endpoint: `${issuer}/grant`,
  };
}

export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    pushed_authorization_request_endpoint: `${issuer}/par`,
    registration_endpoint: `${issuer}/register`,
    introspection_endpoint: `${issuer}/introspect`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
    authorization_details_types_supported: ['llm-inference'],
    dpop_signing_alg_values_supported: ['ES256'],
    authorization_response_iss_parameter_supported: true,
  };
}

// -- Clients -----------------------------------------------------------------

interface ClientRow {
  client_id: string;
  client_secret_hash: string;
  name: string;
  redirect_uris: string;
  token_endpoint_auth_method: string;
}

async function loadClient(db: D1Database, clientId: string): Promise<ClientRow | null> {
  return db
    .prepare(
      'SELECT client_id, client_secret_hash, name, redirect_uris, token_endpoint_auth_method FROM apps WHERE client_id = ?',
    )
    .bind(clientId)
    .first<ClientRow>();
}

function validRedirect(client: ClientRow, uri: string): boolean {
  return (JSON.parse(client.redirect_uris) as string[]).includes(uri);
}

/**
 * Resolve and authenticate the client per its registered
 * token_endpoint_auth_method: client_secret_basic via the Authorization
 * header, or `none` (public client, client_id in the body).
 */
async function authenticateClient(
  c: Context<AppEnv>,
  form: Record<string, string>,
): Promise<ClientRow | Response> {
  const basic = c.req.header('authorization');
  if (basic?.startsWith('Basic ')) {
    let id = '';
    let secret = '';
    try {
      const decoded = atob(basic.slice(6));
      const idx = decoded.indexOf(':');
      id = decodeURIComponent(decoded.slice(0, idx));
      secret = decodeURIComponent(decoded.slice(idx + 1));
    } catch {
      return oauthError(401, 'invalid_client', 'Malformed Authorization header');
    }
    const client = await loadClient(c.env.DB, id);
    if (
      !client ||
      client.token_endpoint_auth_method !== 'client_secret_basic' ||
      !client.client_secret_hash ||
      !digestsEqual(client.client_secret_hash, await sha256Hex(secret))
    )
      return oauthError(401, 'invalid_client', 'Client authentication failed');
    return client;
  }
  const clientId = form.client_id;
  if (!clientId) return oauthError(401, 'invalid_client', 'Missing client authentication');
  const client = await loadClient(c.env.DB, clientId);
  if (!client) return oauthError(401, 'invalid_client', 'Unknown client');
  if (client.token_endpoint_auth_method !== 'none')
    return oauthError(401, 'invalid_client', 'Client must authenticate');
  return client;
}

// -- Authorization details (RFC 9396, type llm-inference) --------------------

export interface LlmInferenceDetails {
  type: 'llm-inference';
  budget: number;
  models?: string[];
}

/** Strict fail-closed validation of the authorization_details parameter. */
function parseAuthorizationDetails(raw: string): LlmInferenceDetails | string {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return 'authorization_details must be JSON';
  }
  if (!Array.isArray(arr) || arr.length !== 1)
    return 'authorization_details must be an array with exactly one llm-inference object';
  const d = arr[0] as Record<string, unknown>;
  if (d.type !== 'llm-inference') return "authorization_details[0].type must be 'llm-inference'";
  for (const key of Object.keys(d)) {
    if (!['type', 'budget', 'models'].includes(key)) return `Unrecognized llm-inference field '${key}'`;
  }
  if (typeof d.budget !== 'number' || !Number.isInteger(d.budget) || d.budget < 1 || d.budget > MAX_BUDGET)
    return `budget must be an integer 1..${MAX_BUDGET}`;
  if (d.models !== undefined) {
    if (!Array.isArray(d.models) || d.models.length === 0 || !d.models.every((m) => typeof m === 'string'))
      return 'models must be a non-empty array of strings';
    const known = new Set(MODELS.map((m) => m.id));
    for (const m of d.models as string[]) {
      if (!known.has(m)) return `Unknown model '${m}'`;
    }
  }
  const out: LlmInferenceDetails = { type: 'llm-inference', budget: d.budget };
  if (d.models) out.models = d.models as string[];
  return out;
}

export function detailsJson(budget: number, models: string[] | null): LlmInferenceDetails[] {
  const d: LlmInferenceDetails = { type: 'llm-inference', budget };
  if (models && models.length) d.models = models;
  return [d];
}

// -- Authorization request validation ----------------------------------------

interface AuthRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  details: LlmInferenceDetails;
}

async function validateAuthRequest(
  env: Bindings,
  q: Record<string, string | undefined>,
): Promise<{ ok: AuthRequest } | { err: string; desc: string }> {
  if (q.response_type !== 'code') return { err: 'unsupported_response_type', desc: "response_type must be 'code'" };
  const client = q.client_id ? await loadClient(env.DB, q.client_id) : null;
  if (!client) return { err: 'invalid_request', desc: 'Unknown client_id' };
  if (!q.redirect_uri || !validRedirect(client, q.redirect_uri))
    return { err: 'invalid_request', desc: 'redirect_uri is not registered for this client' };
  if (!q.code_challenge || q.code_challenge_method !== 'S256')
    return { err: 'invalid_request', desc: 'PKCE with S256 is required' };
  if (q.resource && q.resource !== env.ISSUER)
    return { err: 'invalid_target', desc: `Unknown resource; this provider serves ${env.ISSUER}` };
  if (!q.authorization_details)
    return { err: 'invalid_request', desc: 'authorization_details is required' };
  const details = parseAuthorizationDetails(q.authorization_details);
  if (typeof details === 'string')
    return { err: 'invalid_authorization_details', desc: details };
  return {
    ok: {
      client_id: client.client_id,
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      state: q.state,
      details,
    },
  };
}

// -- Grant lifecycle helpers -------------------------------------------------

export async function revokeGrant(db: D1Database, grantId: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE grants SET status = 'revoked' WHERE id = ?").bind(grantId),
    db.prepare("UPDATE refresh_tokens SET status = 'revoked' WHERE grant_id = ?").bind(grantId),
    db.prepare('DELETE FROM access_tokens WHERE grant_id = ?').bind(grantId),
  ]);
}

interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer' | 'DPoP';
  expires_in: number;
  refresh_token: string;
  authorization_details: LlmInferenceDetails[];
}

async function issueTokens(
  db: D1Database,
  grant: { id: string; budget_total: number; models: string | null },
  jkt: string | null,
): Promise<IssuedTokens> {
  const at = randomToken('tpx_at_');
  const rt = randomToken('tpx_rt_');
  await db.batch([
    db
      .prepare(
        "INSERT INTO access_tokens (id, grant_id, token_hash, dpop_jkt, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))",
      )
      .bind(crypto.randomUUID(), grant.id, await sha256Hex(at), jkt, `+${ACCESS_TOKEN_TTL_S} seconds`),
    db
      .prepare('INSERT INTO refresh_tokens (id, grant_id, token_hash, dpop_jkt) VALUES (?, ?, ?, ?)')
      .bind(crypto.randomUUID(), grant.id, await sha256Hex(rt), jkt),
  ]);
  return {
    access_token: at,
    token_type: jkt ? 'DPoP' : 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: rt,
    authorization_details: detailsJson(grant.budget_total, grant.models ? (JSON.parse(grant.models) as string[]) : null),
  };
}

// -- Routes ------------------------------------------------------------------

export const oauth = new Hono<AppEnv>();

oauth.post('/register', async (c) => {
  let body: {
    client_name?: string;
    redirect_uris?: string[];
    token_endpoint_auth_method?: string;
    grant_types?: string[];
  };
  try {
    body = await c.req.json();
  } catch {
    return oauthError(400, 'invalid_client_metadata', 'Body must be JSON');
  }
  const name = body.client_name?.trim();
  const uris = body.redirect_uris;
  const method = body.token_endpoint_auth_method ?? 'client_secret_basic';
  if (!name) return oauthError(400, 'invalid_client_metadata', 'client_name is required');
  if (!Array.isArray(uris) || uris.length === 0)
    return oauthError(400, 'invalid_redirect_uri', 'redirect_uris is required');
  for (const uri of uris) {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return oauthError(400, 'invalid_redirect_uri', `Invalid redirect_uri: ${uri}`);
    }
    const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !isLocal)
      return oauthError(400, 'invalid_redirect_uri', 'redirect_uris must be https (or localhost)');
  }
  if (!['none', 'client_secret_basic'].includes(method))
    return oauthError(400, 'invalid_client_metadata', "token_endpoint_auth_method must be 'none' or 'client_secret_basic'");
  if (body.grant_types && !body.grant_types.every((g) => ['authorization_code', 'refresh_token'].includes(g)))
    return oauthError(400, 'invalid_client_metadata', 'Unsupported grant_types');

  const clientId = randomToken('app_');
  // Public clients get no secret, per OAuth 2.1.
  const secret = method === 'none' ? null : randomToken('cs_');
  await c.env.DB.prepare(
    'INSERT INTO apps (client_id, client_secret_hash, name, redirect_uris, token_endpoint_auth_method) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(clientId, secret ? await sha256Hex(secret) : '', name, JSON.stringify(uris), method)
    .run();
  return c.json(
    {
      client_id: clientId,
      ...(secret && { client_secret: secret }),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
    },
    201,
  );
});

oauth.post('/par', async (c) => {
  const form = Object.fromEntries(
    Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]),
  );
  if (form.request_uri) return oauthError(400, 'invalid_request', 'request_uri not allowed at PAR');
  const client = await authenticateClient(c, form);
  if (client instanceof Response) return client;
  if (form.client_id && form.client_id !== client.client_id)
    return oauthError(400, 'invalid_request', 'client_id mismatch');
  const validated = await validateAuthRequest(c.env, { ...form, client_id: client.client_id });
  if ('err' in validated) return oauthError(400, validated.err, validated.desc);

  const requestUri = `urn:ietf:params:oauth:request_uri:${randomToken('')}`;
  await c.env.DB.prepare(
    "INSERT INTO par_requests (request_uri, client_id, params, expires_at) VALUES (?, ?, ?, datetime('now', '+90 seconds'))",
  )
    .bind(requestUri, client.client_id, JSON.stringify(validated.ok))
    .run();
  return c.json({ request_uri: requestUri, expires_in: PAR_TTL_MS / 1000 }, 201);
});

async function resolveAuthRequest(
  c: Context<AppEnv>,
  q: Record<string, string | undefined>,
): Promise<{ ok: AuthRequest; requestUri?: string } | Response> {
  if (q.request_uri) {
    const row = await c.env.DB.prepare(
      "SELECT client_id, params FROM par_requests WHERE request_uri = ? AND expires_at > datetime('now')",
    )
      .bind(q.request_uri)
      .first<{ client_id: string; params: string }>();
    if (!row || (q.client_id && q.client_id !== row.client_id))
      return oauthError(400, 'invalid_request', 'Unknown or expired request_uri');
    return { ok: JSON.parse(row.params) as AuthRequest, requestUri: q.request_uri };
  }
  const validated = await validateAuthRequest(c.env, q);
  if ('err' in validated) return oauthError(400, validated.err, validated.desc);
  // Store direct requests like pushed ones so the consent form only ever
  // carries an opaque reference.
  const requestUri = `urn:ietf:params:oauth:request_uri:${randomToken('')}`;
  await c.env.DB.prepare(
    "INSERT INTO par_requests (request_uri, client_id, params, expires_at) VALUES (?, ?, ?, datetime('now', '+600 seconds'))",
  )
    .bind(requestUri, validated.ok.client_id, JSON.stringify(validated.ok))
    .run();
  return { ok: validated.ok, requestUri };
}

oauth.get('/authorize', async (c) => {
  const resolved = await resolveAuthRequest(c, c.req.query());
  if (resolved instanceof Response) return resolved;
  const req = resolved.ok;
  const client = (await loadClient(c.env.DB, req.client_id))!;

  const userId = await whoami(c);
  if (!userId) return loginRedirect(c);
  const user = await ensureUser(c, userId);

  const budget = req.details.budget;
  const usdApprox = (budget / 1_000_000).toFixed(2);
  const modelNote = req.details.models
    ? `<p class="muted">Limited to models: <code>${esc(req.details.models.join(', '))}</code></p>`
    : '';

  return c.html(
    page(
      'Authorize · tokenpony',
      `<p class="eyebrow">Authorization request</p>
<h1>${esc(client.name)} is asking for a credit budget.</h1>
<div class="card">
  <p><strong>${esc(client.name)}</strong> wants to spend up to
     <strong>${budget.toLocaleString('en-US')} credits</strong> (about $${usdApprox}) from your tokenpony balance.</p>
  ${modelNote}
  <p class="muted">Your balance: ${user.balance_credits.toLocaleString('en-US')} credits.
     The app never sees your keys or your identity, only this metered budget.
     You can revoke it any time from your dashboard.</p>
  <div class="row" style="margin-top:1rem">
    <form method="post" action="/authorize/decision">
      <input type="hidden" name="request_uri" value="${esc(resolved.requestUri!)}">
      <input type="hidden" name="decision" value="approve">
      <button type="submit">Approve ${budget.toLocaleString('en-US')} credits</button>
    </form>
    <form method="post" action="/authorize/decision">
      <input type="hidden" name="request_uri" value="${esc(resolved.requestUri!)}">
      <input type="hidden" name="decision" value="deny">
      <button type="submit" class="quiet">Deny</button>
    </form>
  </div>
</div>
<p class="muted">Redirects to <code>${esc(req.redirect_uri)}</code></p>`,
    ),
  );
});

oauth.post('/authorize/decision', async (c) => {
  const form = await c.req.parseBody();
  const requestUri = String(form.request_uri ?? '');
  const row = await c.env.DB.prepare(
    "SELECT client_id, params FROM par_requests WHERE request_uri = ? AND expires_at > datetime('now')",
  )
    .bind(requestUri)
    .first<{ client_id: string; params: string }>();
  if (!row) return oauthError(400, 'invalid_request', 'Unknown or expired request');
  const req = JSON.parse(row.params) as AuthRequest;

  const userId = await whoami(c);
  if (!userId) return loginRedirect(c);
  await ensureUser(c, userId);
  // One decision per pushed request.
  await c.env.DB.prepare('DELETE FROM par_requests WHERE request_uri = ?').bind(requestUri).run();

  const dest = new URL(req.redirect_uri);
  if (req.state) dest.searchParams.set('state', req.state);
  dest.searchParams.set('iss', c.env.ISSUER);

  if (form.decision !== 'approve') {
    dest.searchParams.set('error', 'access_denied');
    return c.redirect(dest.toString());
  }

  const code = randomToken('tpxc_');
  await c.env.DB.prepare(
    `INSERT INTO auth_codes (code, client_id, user_id, budget, redirect_uri, expires_at, code_challenge, models)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      code,
      req.client_id,
      userId,
      req.details.budget,
      req.redirect_uri,
      new Date(Date.now() + CODE_TTL_MS).toISOString(),
      req.code_challenge,
      req.details.models ? JSON.stringify(req.details.models) : null,
    )
    .run();
  dest.searchParams.set('code', code);
  return c.redirect(dest.toString());
});

async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const computed = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return computed === challenge;
}

oauth.post('/token', async (c) => {
  // AAuth budget relay (JSON body) rides on the same endpoint (seam contract
  // section 4: the resource token's aud is this /token URL). Form-encoded bodies
  // fall through to the standard OAuth 2.1 grant flows below.
  const relay = await handleBudgetRelay(c);
  if (relay) return relay;

  const form = Object.fromEntries(
    Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]),
  );
  const client = await authenticateClient(c, form);
  if (client instanceof Response) return client;

  // Optional DPoP binding for the tokens being issued.
  let jkt: string | null = null;
  const proof = c.req.header('dpop');
  if (proof) {
    jkt = await verifyDpopProof({ proof, htm: 'POST', htu: `${c.env.ISSUER}/token` });
    if (!jkt) return oauthError(400, 'invalid_dpop_proof', 'DPoP proof failed validation');
  }

  if (form.grant_type === 'authorization_code') {
    if (!form.code || !form.redirect_uri || !form.code_verifier)
      return oauthError(400, 'invalid_request', 'code, redirect_uri, code_verifier required');
    const row = await c.env.DB.prepare('SELECT * FROM auth_codes WHERE code = ?')
      .bind(form.code)
      .first<{
        code: string;
        client_id: string;
        user_id: string;
        budget: number;
        redirect_uri: string;
        expires_at: string;
        used: number;
        code_challenge: string | null;
        models: string | null;
        grant_id: string | null;
      }>();
    if (!row || row.client_id !== client.client_id || row.redirect_uri !== form.redirect_uri)
      return oauthError(400, 'invalid_grant', 'Unknown authorization code');
    if (row.used) {
      // Code replay: kill whatever the first exchange produced.
      if (row.grant_id) await revokeGrant(c.env.DB, row.grant_id);
      return oauthError(400, 'invalid_grant', 'Authorization code already used');
    }
    if (Date.parse(row.expires_at) < Date.now())
      return oauthError(400, 'invalid_grant', 'Authorization code expired');
    if (!row.code_challenge || !(await pkceMatches(form.code_verifier, row.code_challenge)))
      return oauthError(400, 'invalid_grant', 'PKCE verification failed');

    const grantId = crypto.randomUUID();
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE auth_codes SET used = 1, grant_id = ? WHERE code = ?').bind(grantId, row.code),
      // token_hash is a vestigial v0.1 column (NOT NULL UNIQUE); grants are
      // now represented by refresh/access tokens. Fill it with a unique nonce.
      c.env.DB.prepare(
        'INSERT INTO grants (id, token_hash, client_id, user_id, budget_total, models) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(grantId, `v2:${grantId}`, row.client_id, row.user_id, row.budget, row.models),
    ]);
    c.executionCtx.waitUntil(writeTuples(c.env, grantTuples(grantId, row.user_id, row.client_id)));
    return c.json(
      await issueTokens(c.env.DB, { id: grantId, budget_total: row.budget, models: row.models }, jkt),
    );
  }

  if (form.grant_type === 'refresh_token') {
    if (!form.refresh_token) return oauthError(400, 'invalid_request', 'refresh_token required');
    const hash = await sha256Hex(form.refresh_token);
    const rt = await c.env.DB.prepare(
      `SELECT r.id, r.grant_id, r.status, r.dpop_jkt, g.client_id, g.status AS grant_status, g.budget_total, g.budget_used, g.models
       FROM refresh_tokens r JOIN grants g ON g.id = r.grant_id WHERE r.token_hash = ?`,
    )
      .bind(hash)
      .first<{
        id: string;
        grant_id: string;
        status: string;
        dpop_jkt: string | null;
        client_id: string;
        grant_status: string;
        budget_total: number;
        budget_used: number;
        models: string | null;
      }>();
    if (!rt || rt.client_id !== client.client_id)
      return oauthError(400, 'invalid_grant', 'Unknown refresh token');
    if (rt.status !== 'active') {
      // Rotated-token reuse means theft; burn the grant.
      await revokeGrant(c.env.DB, rt.grant_id);
      console.log(JSON.stringify({ event: 'refresh_reuse_detected', grant: rt.grant_id }));
      return oauthError(400, 'invalid_grant', 'Refresh token reuse detected; grant revoked');
    }
    if (rt.grant_status !== 'active') return oauthError(400, 'invalid_grant', 'Grant revoked');
    if (rt.budget_used >= rt.budget_total)
      return oauthError(400, 'invalid_grant', 'Grant budget exhausted');
    if (rt.dpop_jkt && rt.dpop_jkt !== jkt)
      return oauthError(400, 'invalid_dpop_proof', 'Refresh token is bound to a different key');

    await c.env.DB.prepare("UPDATE refresh_tokens SET status = 'rotated' WHERE id = ?").bind(rt.id).run();
    return c.json(
      await issueTokens(
        c.env.DB,
        { id: rt.grant_id, budget_total: rt.budget_total, models: rt.models },
        rt.dpop_jkt ?? jkt,
      ),
    );
  }

  return oauthError(400, 'unsupported_grant_type', "grant_type must be 'authorization_code' or 'refresh_token'");
});

oauth.post('/introspect', async (c) => {
  const form = Object.fromEntries(
    Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]),
  );
  if (!form.token) return oauthError(400, 'invalid_request', 'token required');
  const hash = await sha256Hex(form.token);
  const at = await c.env.DB.prepare(
    `SELECT a.expires_at, a.dpop_jkt, g.client_id, g.status, g.budget_total, g.budget_used, g.models
     FROM access_tokens a JOIN grants g ON g.id = a.grant_id WHERE a.token_hash = ?`,
  )
    .bind(hash)
    .first<{
      expires_at: string;
      dpop_jkt: string | null;
      client_id: string;
      status: string;
      budget_total: number;
      budget_used: number;
      models: string | null;
    }>();
  if (!at || at.status !== 'active' || Date.parse(`${at.expires_at}Z`) < Date.now())
    return c.json({ active: false });
  return c.json({
    active: true,
    client_id: at.client_id,
    token_type: at.dpop_jkt ? 'DPoP' : 'Bearer',
    exp: Math.floor(Date.parse(`${at.expires_at}Z`) / 1000),
    authorization_details: detailsJson(at.budget_total, at.models ? (JSON.parse(at.models) as string[]) : null),
    budget_used: at.budget_used,
  });
});

oauth.post('/revoke', async (c) => {
  const form = Object.fromEntries(
    Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]),
  );
  if (!form.token) return oauthError(400, 'invalid_request', 'token required');
  const hash = await sha256Hex(form.token);
  const rt = await c.env.DB.prepare('SELECT grant_id FROM refresh_tokens WHERE token_hash = ?')
    .bind(hash)
    .first<{ grant_id: string }>();
  if (rt) {
    await revokeGrant(c.env.DB, rt.grant_id);
  } else {
    // Revoking an access token kills that token only, per RFC 7009.
    await c.env.DB.prepare('DELETE FROM access_tokens WHERE token_hash = ?').bind(hash).run();
  }
  return c.body(null, 200);
});
