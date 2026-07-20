/**
 * tpx-local: a TPX v0.2 provider shim for a local OpenAI-compatible server
 * (built for Jan.ai on localhost:1337).
 *
 * Runs on your machine with Bun and implements the provider surface a TPX
 * client (Pony Chat) exercises: RFC 9728/8414 discovery, RFC 7591 dynamic
 * registration, PAR + PKCE + RAR authorization with a consent page, token
 * issuance with rotating refresh tokens, introspection with budget_used,
 * revocation, and the metered inference API proxied to the local upstream.
 *
 * Local inference is free, so every model publishes zero credit rates and
 * completions report usage.credits_charged: 0. The grant budget is still a
 * real damage cap; it just never depletes.
 *
 * Hosted Pony Chat fetches the provider server-side, so localhost is not
 * reachable from it. Expose this shim with a tunnel and paste the tunnel URL
 * into the connect box:
 *
 *   bun run src/index.ts
 *   cloudflared tunnel --url http://localhost:1338
 *
 * Issuer and resource identifiers are derived per-request from Host and
 * x-forwarded-proto, so the random tunnel hostname needs no configuration.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import type { Context } from 'hono';

const PORT = Number(process.env.PORT ?? 1338);
const UPSTREAM = (process.env.UPSTREAM ?? 'http://localhost:1337').replace(/\/$/, '');
const STATE_PATH = new URL('../state.json', import.meta.url).pathname;

const ACCESS_TOKEN_TTL = 3600; // seconds (spec 7.2: SHOULD NOT exceed 3600)
const CODE_TTL = 300_000; // ms (spec 6.4: codes expire after 5 minutes)
const PAR_TTL = 600_000; // ms

// -- State -------------------------------------------------------------------

interface StoredClient {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_basic';
}

interface Grant {
  id: string;
  client_id: string;
  budget: number;
  budget_used: number;
  models?: string[];
  refresh_token: string;
  /** Rotated-out refresh tokens; presenting one is reuse and revokes the grant. */
  used_refresh_tokens: string[];
  status: 'active' | 'revoked';
}

interface State {
  clients: Record<string, StoredClient>;
  grants: Record<string, Grant>;
}

function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State;
  } catch {
    return { clients: {}, grants: {} };
  }
}

const state = loadState();

function saveState() {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// Short-lived artifacts stay in memory: after a restart, access tokens 401,
// the client refreshes with its persisted refresh token, and life goes on.
interface PendingAuthz {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  budget: number;
  models?: string[];
  exp: number;
}
const pendingAuthz = new Map<string, PendingAuthz>();

interface AuthCode {
  grant_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  exp: number;
}
const codes = new Map<string, AuthCode>();
const accessTokens = new Map<string, { grant_id: string; exp: number }>();

// -- Helpers -----------------------------------------------------------------

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function randomToken(prefix: string): string {
  return `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(24)).buffer as ArrayBuffer)}`;
}

async function s256(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

/** The issuer is whatever origin the request arrived on (tunnel-friendly). */
function issuerOf(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host;
  return `${proto}://${host}`;
}

/** Flat RFC 6749 error shape for OAuth endpoints. */
function oauthError(c: Context, status: 400 | 401, error: string, description: string) {
  return c.json({ error, error_description: description }, status);
}

/** Nested error shape for the inference API. */
function apiError(c: Context, status: number, code: string, message: string, headers?: Record<string, string>) {
  return c.json({ error: { code, message } }, status as 401, headers);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Authenticate the OAuth client per its registered method: HTTP Basic with
 * form-encoded credentials (RFC 6749 2.3.1) or bare client_id for public
 * clients.
 */
function authenticateClient(c: Context, form: URLSearchParams): StoredClient | null {
  const authz = c.req.header('authorization');
  if (authz?.startsWith('Basic ')) {
    let id: string, secret: string;
    try {
      const [rawId, ...rest] = atob(authz.slice(6)).split(':');
      id = decodeURIComponent(rawId ?? '');
      secret = decodeURIComponent(rest.join(':'));
    } catch {
      return null;
    }
    const client = state.clients[id];
    return client?.client_secret === secret ? client : null;
  }
  const id = form.get('client_id');
  const client = id ? state.clients[id] : undefined;
  return client && client.token_endpoint_auth_method === 'none' ? client : null;
}

/** Parse an authorization_details value, failing closed per RFC 9396. */
function parseLlmInference(raw: string): { budget: number; models?: string[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'authorization_details is not valid JSON' };
  }
  if (!Array.isArray(parsed) || parsed.length !== 1)
    return { error: 'authorization_details must be an array of exactly one object' };
  const d = parsed[0] as Record<string, unknown>;
  if (d?.type !== 'llm-inference') return { error: 'authorization_details type must be llm-inference' };
  for (const key of Object.keys(d))
    if (!['type', 'budget', 'models'].includes(key)) return { error: `Unrecognized field '${key}'` };
  if (typeof d.budget !== 'number' || !Number.isInteger(d.budget) || d.budget <= 0)
    return { error: 'budget must be a positive integer' };
  if (d.models !== undefined && (!Array.isArray(d.models) || d.models.some((m) => typeof m !== 'string')))
    return { error: 'models must be an array of strings' };
  return { budget: d.budget, models: d.models as string[] | undefined };
}

function grantedDetails(grant: Grant) {
  return [{ type: 'llm-inference', budget: grant.budget, ...(grant.models && { models: grant.models }) }];
}

function issueTokens(grant: Grant) {
  const access_token = randomToken('tpx_at_');
  accessTokens.set(access_token, { grant_id: grant.id, exp: Date.now() + ACCESS_TOKEN_TTL * 1000 });
  if (grant.refresh_token) grant.used_refresh_tokens.push(grant.refresh_token);
  grant.refresh_token = randomToken('tpx_rt_');
  saveState();
  return {
    access_token,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: grant.refresh_token,
    authorization_details: grantedDetails(grant),
  };
}

function revokeGrant(grant: Grant) {
  grant.status = 'revoked';
  for (const [at, ref] of accessTokens) if (ref.grant_id === grant.id) accessTokens.delete(at);
  saveState();
}

const app = new Hono();

// -- Discovery (RFC 9728 + RFC 8414) -----------------------------------------

app.get('/.well-known/oauth-protected-resource', (c) => {
  const issuer = issuerOf(c);
  return c.json({
    resource: issuer,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
  });
});

app.get('/.well-known/oauth-authorization-server', (c) => {
  const issuer = issuerOf(c);
  return c.json({
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
    authorization_response_iss_parameter_supported: true,
  });
});

// -- Registration (RFC 7591) -------------------------------------------------

app.post('/register', async (c) => {
  let body: {
    client_name?: string;
    redirect_uris?: string[];
    token_endpoint_auth_method?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return oauthError(c, 400, 'invalid_client_metadata', 'Body must be JSON');
  }
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0)
    return oauthError(c, 400, 'invalid_redirect_uri', 'redirect_uris is required');
  const method = body.token_endpoint_auth_method ?? 'client_secret_basic';
  if (method !== 'none' && method !== 'client_secret_basic')
    return oauthError(c, 400, 'invalid_client_metadata', `Unsupported token_endpoint_auth_method '${method}'`);

  const client: StoredClient = {
    client_id: randomToken('app_').slice(0, 12),
    ...(method === 'client_secret_basic' && { client_secret: randomToken('secret_') }),
    client_name: String(body.client_name ?? 'Unnamed app'),
    redirect_uris: body.redirect_uris.map(String),
    token_endpoint_auth_method: method,
  };
  state.clients[client.client_id] = client;
  saveState();
  console.log(`registered client ${client.client_id} (${client.client_name})`);
  return c.json(client, 201);
});

// -- Authorization (PAR + PKCE + RAR) ----------------------------------------

app.post('/par', async (c) => {
  const form = new URLSearchParams(await c.req.text());
  const client = authenticateClient(c, form);
  if (!client) return oauthError(c, 401, 'invalid_client', 'Client authentication failed');
  if (form.get('response_type') !== 'code')
    return oauthError(c, 400, 'unsupported_response_type', 'Only response_type=code is supported');
  const redirectUri = form.get('redirect_uri') ?? '';
  if (!client.redirect_uris.includes(redirectUri))
    return oauthError(c, 400, 'invalid_request', 'redirect_uri is not registered for this client');
  const codeChallenge = form.get('code_challenge');
  if (!codeChallenge || form.get('code_challenge_method') !== 'S256')
    return oauthError(c, 400, 'invalid_request', 'PKCE with S256 is required');
  const resource = form.get('resource');
  if (resource && resource !== issuerOf(c))
    return oauthError(c, 400, 'invalid_target', `Unknown resource; this provider serves ${issuerOf(c)}`);
  const details = parseLlmInference(form.get('authorization_details') ?? '');
  if ('error' in details) return oauthError(c, 400, 'invalid_authorization_details', details.error);

  const id = randomToken('').slice(0, 22);
  pendingAuthz.set(id, {
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    state: form.get('state') ?? undefined,
    budget: details.budget,
    models: details.models,
    exp: Date.now() + PAR_TTL,
  });
  return c.json({ request_uri: `urn:ietf:params:oauth:request_uri:${id}`, expires_in: PAR_TTL / 1000 }, 201);
});

function pendingFor(clientId: string | undefined, requestUri: string | undefined) {
  const id = requestUri?.split(':').pop() ?? '';
  const pending = pendingAuthz.get(id);
  if (!pending || pending.exp < Date.now() || pending.client_id !== clientId) return null;
  return { id, pending };
}

app.get('/authorize', (c) => {
  const found = pendingFor(c.req.query('client_id'), c.req.query('request_uri'));
  if (!found) return c.html('<p>Unknown or expired authorization request. Start over in the app.</p>', 400);
  const { id, pending } = found;
  const client = state.clients[pending.client_id];
  const usd = (pending.budget / 1_000_000).toFixed(2);
  return c.html(`<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve grant</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1rem; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 1.5rem; }
  b.budget { font-variant-numeric: tabular-nums; }
  button { font: inherit; padding: .5rem 1.25rem; border-radius: 6px; border: 1px solid #888; cursor: pointer; }
  button.approve { background: #1a7f37; border-color: #1a7f37; color: #fff; }
  form { display: inline-block; margin-right: .5rem; margin-top: 1rem; }
  .note { color: #555; font-size: .875rem; }
</style>
<div class="card">
  <h1>tpx-local</h1>
  <p><b>${escapeHtml(client?.client_name ?? pending.client_id)}</b> requests an inference grant of
  <b class="budget">${pending.budget.toLocaleString('en-US')}</b> credits ($${usd}).</p>
  ${pending.models ? `<p>Limited to models: ${escapeHtml(pending.models.join(', '))}</p>` : ''}
  <p class="note">Inference runs on your machine at ${escapeHtml(UPSTREAM)}, so usage costs 0 credits. The budget is a cap, not a payment.</p>
  <form method="post" action="/authorize/decision"><input type="hidden" name="request" value="${id}"><input type="hidden" name="decision" value="approve"><button class="approve">Approve</button></form>
  <form method="post" action="/authorize/decision"><input type="hidden" name="request" value="${id}"><input type="hidden" name="decision" value="deny"><button>Deny</button></form>
</div>`);
});

app.post('/authorize/decision', async (c) => {
  const form = new URLSearchParams(await c.req.text());
  const pending = pendingAuthz.get(form.get('request') ?? '');
  if (!pending || pending.exp < Date.now())
    return c.html('<p>Unknown or expired authorization request. Start over in the app.</p>', 400);
  pendingAuthz.delete(form.get('request') ?? '');

  const redirect = new URL(pending.redirect_uri);
  if (pending.state) redirect.searchParams.set('state', pending.state);
  redirect.searchParams.set('iss', issuerOf(c)); // RFC 9207

  if (form.get('decision') !== 'approve') {
    redirect.searchParams.set('error', 'access_denied');
    return c.redirect(redirect.toString());
  }

  const grant: Grant = {
    id: randomToken('grant_').slice(0, 14),
    client_id: pending.client_id,
    budget: pending.budget,
    budget_used: 0,
    models: pending.models,
    refresh_token: '',
    used_refresh_tokens: [],
    status: 'active',
  };
  state.grants[grant.id] = grant;
  saveState();

  const code = randomToken('code_');
  codes.set(code, {
    grant_id: grant.id,
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_challenge: pending.code_challenge,
    exp: Date.now() + CODE_TTL,
  });
  redirect.searchParams.set('code', code);
  console.log(`granted ${grant.budget} credits to ${pending.client_id} (${grant.id})`);
  return c.redirect(redirect.toString());
});

// -- Tokens ------------------------------------------------------------------

app.post('/token', async (c) => {
  const form = new URLSearchParams(await c.req.text());
  const client = authenticateClient(c, form);
  if (!client) return oauthError(c, 401, 'invalid_client', 'Client authentication failed');

  const grantType = form.get('grant_type');
  if (grantType === 'authorization_code') {
    const code = form.get('code') ?? '';
    const entry = codes.get(code);
    codes.delete(code); // single-use
    if (!entry || entry.exp < Date.now() || entry.client_id !== client.client_id)
      return oauthError(c, 400, 'invalid_grant', 'Unknown, expired, or reused code');
    const grant = state.grants[entry.grant_id];
    if (!grant || grant.status !== 'active')
      return oauthError(c, 400, 'invalid_grant', 'Grant is no longer active');
    if (form.get('redirect_uri') !== entry.redirect_uri)
      return oauthError(c, 400, 'invalid_grant', 'redirect_uri mismatch');
    const verifier = form.get('code_verifier') ?? '';
    if ((await s256(verifier)) !== entry.code_challenge)
      return oauthError(c, 400, 'invalid_grant', 'PKCE verification failed');
    return c.json(issueTokens(grant));
  }

  if (grantType === 'refresh_token') {
    const rt = form.get('refresh_token') ?? '';
    const grants = Object.values(state.grants);
    const reused = grants.find((g) => g.used_refresh_tokens.includes(rt));
    if (reused) {
      // Spec 7.3: detected reuse of a rotated refresh token revokes the grant.
      revokeGrant(reused);
      console.log(`refresh token reuse detected; revoked ${reused.id}`);
      return oauthError(c, 400, 'invalid_grant', 'Refresh token reuse detected; grant revoked');
    }
    const grant = grants.find((g) => g.refresh_token === rt && g.client_id === client.client_id);
    if (!grant || grant.status !== 'active')
      return oauthError(c, 400, 'invalid_grant', 'Unknown or revoked refresh token');
    return c.json(issueTokens(grant));
  }

  return oauthError(c, 400, 'unsupported_grant_type', `Unsupported grant_type '${grantType}'`);
});

// -- Grant state (RFC 7662 + RFC 7009) ---------------------------------------

app.post('/introspect', async (c) => {
  const form = new URLSearchParams(await c.req.text());
  const ref = accessTokens.get(form.get('token') ?? '');
  const grant = ref && state.grants[ref.grant_id];
  if (!ref || !grant || ref.exp < Date.now() || grant.status !== 'active')
    return c.json({ active: false });
  return c.json({
    active: true,
    client_id: grant.client_id,
    token_type: 'Bearer',
    exp: Math.floor(ref.exp / 1000),
    authorization_details: grantedDetails(grant),
    budget_used: grant.budget_used,
  });
});

app.post('/revoke', async (c) => {
  const form = new URLSearchParams(await c.req.text());
  const token = form.get('token') ?? '';
  const byRt = Object.values(state.grants).find(
    (g) => g.refresh_token === token || g.used_refresh_tokens.includes(token),
  );
  const grant = byRt ?? (accessTokens.get(token) && state.grants[accessTokens.get(token)!.grant_id]);
  if (grant && grant.status === 'active') {
    revokeGrant(grant);
    console.log(`revoked ${grant.id}`);
  }
  return c.body(null, 200); // RFC 7009: 200 even for unknown tokens
});

// -- Inference API -----------------------------------------------------------

function authenticateBearer(c: Context): Grant | Response {
  const issuer = issuerOf(c);
  const challenge = (parts: string[]) =>
    [`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`, ...parts].join(', ');
  const header = c.req.header('authorization');
  const token = header?.replace(/^(Bearer|DPoP) /, '');
  if (!token)
    return apiError(c, 401, 'unauthorized', 'Access token required', {
      'WWW-Authenticate': challenge([]),
    });
  const ref = accessTokens.get(token);
  const grant = ref && state.grants[ref.grant_id];
  if (!ref || !grant || ref.exp < Date.now() || grant.status !== 'active')
    return apiError(c, 401, 'invalid_token', 'Token expired, unknown, or revoked', {
      'WWW-Authenticate': challenge(['error="invalid_token"']),
    });
  return grant;
}

const ZERO_PRICING = {
  usd_per_m_input_tokens: 0,
  usd_per_m_cached_input_tokens: 0,
  usd_per_m_output_tokens: 0,
  credits_per_token: { input: '0', cached_input: '0', output: '0' },
  source: 'local',
};

async function listModels(c: Context) {
  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM}/v1/models`);
  } catch {
    return apiError(c, 502, 'upstream_unreachable', `Cannot reach ${UPSTREAM}; is Jan running with its local API server on?`);
  }
  if (!upstream.ok)
    return apiError(c, 502, 'upstream_error', `${UPSTREAM}/v1/models returned ${upstream.status}`);
  const body = (await upstream.json()) as { data?: { id: string; owned_by?: string }[] };
  return c.json({
    object: 'list',
    data: (body.data ?? []).map((m) => ({
      id: m.id,
      object: 'model',
      owned_by: m.owned_by ?? 'local',
      pricing: ZERO_PRICING,
    })),
  });
}

/** Inject usage.credits_charged: 0 into SSE chunks that carry usage. */
function annotateSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let buffer = '';
  const encoder = new TextEncoder();
  const annotateLine = (line: string): string => {
    if (!line.startsWith('data: ')) return line;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') return line;
    try {
      const chunk = JSON.parse(payload) as { usage?: Record<string, unknown> };
      if (!chunk.usage) return line;
      chunk.usage.credits_charged = 0;
      return `data: ${JSON.stringify(chunk)}`;
    } catch {
      return line;
    }
  };
  return body.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).pipeThrough(
    new TransformStream<string, string>({
      transform(text, controller) {
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) controller.enqueue(`${annotateLine(line)}\n`);
      },
      flush(controller) {
        if (buffer) controller.enqueue(annotateLine(buffer));
      },
    }),
  ).pipeThrough(
    new TransformStream<string, Uint8Array>({
      transform(text, controller) {
        controller.enqueue(encoder.encode(text));
      },
    }),
  );
}

async function chatCompletions(c: Context) {
  const grant = authenticateBearer(c);
  if (grant instanceof Response) return grant;

  let body: { model?: string; stream?: boolean; stream_options?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, 'invalid_request', 'Body must be JSON');
  }
  if (grant.models && body.model && !grant.models.includes(body.model))
    return apiError(c, 403, 'model_not_allowed', `Grant is limited to: ${grant.models.join(', ')}`);

  const streaming = body.stream === true;
  const post = (payload: unknown) =>
    fetch(`${UPSTREAM}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

  let upstream: Response;
  try {
    upstream = streaming
      ? await post({ ...body, stream_options: { include_usage: true, ...body.stream_options } })
      : await post(body);
    // Some local servers reject stream_options; retry the request untouched.
    if (streaming && !upstream.ok) upstream = await post(body);
  } catch {
    return apiError(c, 502, 'upstream_unreachable', `Cannot reach ${UPSTREAM}; is Jan running with its local API server on?`);
  }

  if (!upstream.ok)
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });

  if (streaming && upstream.headers.get('content-type')?.includes('text/event-stream'))
    return new Response(annotateSse(upstream.body!), {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });

  const json = (await upstream.json()) as { usage?: Record<string, unknown> };
  if (json.usage) json.usage.credits_charged = 0;
  return c.json(json);
}

// Spec 8.2: API endpoints are relative to the resource identifier; serve both
// bare and /v1-prefixed paths like the reference provider.
for (const prefix of ['', '/v1']) {
  app.get(`${prefix}/models`, listModels);
  app.post(`${prefix}/chat/completions`, chatCompletions);
}

// -- Status page -------------------------------------------------------------

app.get('/', (c) => {
  const issuer = issuerOf(c);
  const grants = Object.values(state.grants).filter((g) => g.status === 'active');
  return c.html(`<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tpx-local</title>
<style>body { font: 16px/1.6 system-ui, sans-serif; max-width: 38rem; margin: 3rem auto; padding: 0 1rem; } code { background: #eee; padding: .1rem .3rem; border-radius: 4px; }</style>
<h1>tpx-local</h1>
<p>A TPX v0.2 provider backed by the local OpenAI endpoint at <code>${escapeHtml(UPSTREAM)}</code>.
All inference is free: models publish zero credit rates.</p>
<p>Issuer for this request: <code>${escapeHtml(issuer)}</code> (<a href="/.well-known/oauth-protected-resource">discovery</a>, <a href="/models">models</a>)</p>
<p>Active grants: ${grants.length}, registered clients: ${Object.keys(state.clients).length}</p>
<p>To use from hosted Pony Chat, expose this server with
<code>cloudflared tunnel --url http://localhost:${PORT}</code> and paste the tunnel URL into the connect box.</p>`);
});

app.notFound((c) => apiError(c, 404, 'not_found', `No route for ${c.req.method} ${c.req.path}`));

console.log(`tpx-local listening on http://localhost:${PORT}, proxying ${UPSTREAM}`);

export default {
  port: PORT,
  // Streaming completions from a slow local model can idle between chunks.
  idleTimeout: 240,
  fetch: app.fetch,
};
