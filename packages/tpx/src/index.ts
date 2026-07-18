/**
 * @tokenpony/tpx: client SDK for the Token Pony Express (TPX) v0.2.
 *
 * TPX v0.2 is an OAuth 2.0 profile (OAuth 2.1 baseline) for metered LLM
 * inference grants. See https://tokenpony.dev/spec.
 */

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported?: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint?: string;
  registration_endpoint?: string;
  introspection_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  authorization_details_types_supported?: string[];
}

export interface TpxDiscovery {
  resource: string;
  as: AuthorizationServerMetadata;
}

export interface LlmInferenceDetails {
  type: 'llm-inference';
  budget: number;
  models?: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  authorization_details: LlmInferenceDetails[];
}

export interface IntrospectionResponse {
  active: boolean;
  client_id?: string;
  token_type?: string;
  exp?: number;
  authorization_details?: LlmInferenceDetails[];
  budget_used?: number;
}

export interface ClientRegistration {
  client_id: string;
  client_secret?: string;
  token_endpoint_auth_method: string;
}

export class TpxError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TpxError';
  }
}

async function readError(res: Response): Promise<TpxError> {
  let code = 'unknown_error';
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as {
      // OAuth endpoints use the flat RFC 6749 shape; the inference API nests.
      error?: string | { code: string; message: string };
      error_description?: string;
    };
    if (typeof body.error === 'string') {
      code = body.error;
      message = body.error_description ?? code;
    } else if (body.error) {
      code = body.error.code;
      message = body.error.message;
    }
  } catch {
    // keep status text
  }
  return new TpxError(res.status, code, message);
}

// -- Discovery (RFC 9728 -> RFC 8414) ----------------------------------------

export async function discover(resourceOrigin: string): Promise<TpxDiscovery> {
  const prRes = await fetch(new URL('/.well-known/oauth-protected-resource', resourceOrigin));
  if (!prRes.ok) throw await readError(prRes);
  const pr = (await prRes.json()) as ProtectedResourceMetadata;
  const asOrigin = pr.authorization_servers?.[0];
  if (!asOrigin) throw new TpxError(500, 'invalid_metadata', 'No authorization_servers listed');
  const asRes = await fetch(new URL('/.well-known/oauth-authorization-server', asOrigin));
  if (!asRes.ok) throw await readError(asRes);
  const as = (await asRes.json()) as AuthorizationServerMetadata;
  if (!as.authorization_details_types_supported?.includes('llm-inference'))
    throw new TpxError(500, 'not_tpx', 'Authorization server does not support llm-inference grants');
  return { resource: pr.resource, as };
}

// -- Registration (RFC 7591) -------------------------------------------------

export async function registerClient(
  as: AuthorizationServerMetadata,
  opts: {
    client_name: string;
    redirect_uris: string[];
    token_endpoint_auth_method?: 'none' | 'client_secret_basic';
  },
): Promise<ClientRegistration> {
  if (!as.registration_endpoint)
    throw new TpxError(400, 'registration_unsupported', 'No registration_endpoint in metadata');
  const res = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: opts.client_name,
      redirect_uris: opts.redirect_uris,
      token_endpoint_auth_method: opts.token_endpoint_auth_method ?? 'client_secret_basic',
      grant_types: ['authorization_code', 'refresh_token'],
    }),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

// -- PKCE --------------------------------------------------------------------

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function generateVerifier(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
}

export async function challengeS256(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

// -- Client authentication ---------------------------------------------------

export interface ClientAuth {
  client_id: string;
  client_secret?: string;
}

function authHeaders(auth: ClientAuth): Record<string, string> {
  if (!auth.client_secret) return {};
  return {
    authorization: `Basic ${btoa(`${encodeURIComponent(auth.client_id)}:${encodeURIComponent(auth.client_secret)}`)}`,
  };
}

function withClientId(params: URLSearchParams, auth: ClientAuth): URLSearchParams {
  if (!auth.client_secret) params.set('client_id', auth.client_id);
  return params;
}

// -- Authorization (PAR + PKCE + RAR) ----------------------------------------

export async function pushAuthorizationRequest(
  as: AuthorizationServerMetadata,
  auth: ClientAuth,
  opts: {
    redirect_uri: string;
    code_challenge: string;
    resource: string;
    details: LlmInferenceDetails;
    state?: string;
  },
): Promise<string> {
  if (!as.pushed_authorization_request_endpoint)
    throw new TpxError(400, 'par_unsupported', 'No PAR endpoint in metadata');
  const params = withClientId(
    new URLSearchParams({
      response_type: 'code',
      client_id: auth.client_id,
      redirect_uri: opts.redirect_uri,
      code_challenge: opts.code_challenge,
      code_challenge_method: 'S256',
      resource: opts.resource,
      authorization_details: JSON.stringify([opts.details]),
      ...(opts.state && { state: opts.state }),
    }),
    auth,
  );
  const res = await fetch(as.pushed_authorization_request_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...authHeaders(auth) },
    body: params,
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { request_uri: string };
  return body.request_uri;
}

export function buildAuthorizeUrl(
  as: AuthorizationServerMetadata,
  clientId: string,
  requestUri: string,
): string {
  const url = new URL(as.authorization_endpoint);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('request_uri', requestUri);
  return url.toString();
}

// -- Tokens ------------------------------------------------------------------

export async function exchangeCode(
  as: AuthorizationServerMetadata,
  auth: ClientAuth,
  opts: { code: string; redirect_uri: string; code_verifier: string },
): Promise<TokenResponse> {
  const res = await fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...authHeaders(auth) },
    body: withClientId(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: opts.code,
        redirect_uri: opts.redirect_uri,
        code_verifier: opts.code_verifier,
      }),
      auth,
    ),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function refreshGrant(
  as: AuthorizationServerMetadata,
  auth: ClientAuth,
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...authHeaders(auth) },
    body: withClientId(
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      auth,
    ),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function introspect(
  as: AuthorizationServerMetadata,
  token: string,
): Promise<IntrospectionResponse> {
  if (!as.introspection_endpoint)
    throw new TpxError(400, 'introspection_unsupported', 'No introspection endpoint in metadata');
  const res = await fetch(as.introspection_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function revoke(
  as: AuthorizationServerMetadata,
  auth: ClientAuth,
  token: string,
): Promise<void> {
  if (!as.revocation_endpoint) return;
  await fetch(as.revocation_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...authHeaders(auth) },
    body: withClientId(new URLSearchParams({ token }), auth),
  });
}

// -- Inference API -----------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatUsage {
  prompt_tokens: number;
  cached_tokens?: number;
  completion_tokens: number;
  total_tokens: number;
  credits_charged?: number;
}

/** Non-streaming chat completion against `{resource}/chat/completions`. */
export async function chat(
  resource: string,
  accessToken: string,
  opts: { model: string; messages: ChatMessage[]; max_tokens?: number },
): Promise<{ content: string; usage?: ChatUsage }> {
  const res = await fetch(`${resource}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage?: ChatUsage;
  };
  return { content: body.choices[0]?.message?.content ?? '', usage: body.usage };
}

/** Streaming chat completion; yields content deltas, reports usage at the end. */
export async function* chatStream(
  resource: string,
  accessToken: string,
  opts: { model: string; messages: ChatMessage[]; max_tokens?: number },
  onUsage?: (usage: ChatUsage) => void,
): AsyncGenerator<string> {
  const res = await fetch(`${resource}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ ...opts, stream: true }),
  });
  if (!res.ok) throw await readError(res);

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') return;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
          usage?: ChatUsage;
        };
        if (chunk.usage && onUsage) onUsage(chunk.usage);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield String(delta);
      } catch {
        // ignore malformed keep-alive lines
      }
    }
  }
}
