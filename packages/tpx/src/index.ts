/**
 * @tokenpony/tpx — client SDK for the Token Pony Express (TPX) v0.1.
 *
 * TPX lets an app request a metered LLM token budget from a provider the
 * user chooses and pays. See https://tokenpony.dev/spec.
 */

export const TPX_VERSION = '0.1';

export interface TpxDiscovery {
  tpx_version: string;
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  api_base: string;
  models_endpoint: string;
}

export interface TpxClientRegistration {
  client_id: string;
  client_secret: string;
}

export interface TpxGrant {
  access_token: string;
  token_type: 'bearer';
  budget: number;
  budget_used: number;
  api_base: string;
}

export interface TpxErrorBody {
  error: { code: string; message: string };
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

async function throwOnError(res: Response): Promise<void> {
  if (res.ok) return;
  let code = 'unknown_error';
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as TpxErrorBody;
    code = body.error.code;
    message = body.error.message;
  } catch {
    // non-JSON error body; keep the status text
  }
  throw new TpxError(res.status, code, message);
}

/** Resolve a provider's capabilities from its issuer origin. */
export async function discover(issuer: string): Promise<TpxDiscovery> {
  const res = await fetch(new URL('/.well-known/tpx', issuer));
  await throwOnError(res);
  return res.json();
}

/** One-time dynamic client registration with a provider. */
export async function registerClient(
  discovery: TpxDiscovery,
  opts: { name: string; redirect_uris: string[] },
): Promise<TpxClientRegistration> {
  const res = await fetch(discovery.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  await throwOnError(res);
  return res.json();
}

/** Build the URL to send the user to for budget approval. */
export function buildAuthorizeUrl(
  discovery: TpxDiscovery,
  opts: { client_id: string; redirect_uri: string; state: string; budget: number },
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('client_id', opts.client_id);
  url.searchParams.set('redirect_uri', opts.redirect_uri);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('budget', String(opts.budget));
  return url.toString();
}

/** Exchange the authorization code from the redirect for a grant. */
export async function exchangeCode(
  discovery: TpxDiscovery,
  opts: { code: string; client_id: string; client_secret: string; redirect_uri: string },
): Promise<TpxGrant> {
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', ...opts }),
  });
  await throwOnError(res);
  return res.json();
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Non-streaming chat completion against a provider's OpenAI-compatible API.
 * Works with both `tpx_` grant tokens and provider-native `sk_` keys.
 */
export async function chat(
  apiBase: string,
  token: string,
  opts: { model: string; messages: ChatMessage[]; max_tokens?: number },
): Promise<{ content: string; usage?: ChatUsage }> {
  const res = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(opts),
  });
  await throwOnError(res);
  const body = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage?: ChatUsage;
  };
  return { content: body.choices[0]?.message?.content ?? '', usage: body.usage };
}

/**
 * Streaming chat completion. Yields content deltas; the final SSE chunk's
 * usage (if the provider reports it) is returned via `onUsage`.
 */
export async function* chatStream(
  apiBase: string,
  token: string,
  opts: { model: string; messages: ChatMessage[]; max_tokens?: number },
  onUsage?: (usage: ChatUsage) => void,
): AsyncGenerator<string> {
  const res = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ...opts, stream: true }),
  });
  await throwOnError(res);

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
        if (delta) yield delta;
      } catch {
        // ignore malformed keep-alive lines
      }
    }
  }
}
