/**
 * tpx-local: a TPX v0.3 provider shim for a local OpenAI-compatible server
 * (built for Jan.ai on localhost:1337).
 *
 * The provider surface (discovery, registration, PAR + PKCE + RAR, consent,
 * tokens, introspection, revocation) comes from @tokenpony/tpx-provider; this
 * app supplies the Jan upstream. Local inference is free, so every model
 * publishes zero USD rates and completions report usage.cost: 0.
 * The grant budget is still a real damage cap; it just never depletes.
 *
 * Hosted Pony Chat fetches the provider server-side, so localhost is not
 * reachable from it. Expose this shim with a tunnel and paste the tunnel URL
 * into the connect box:
 *
 *   bun run src/index.ts
 *   cloudflared tunnel --url http://localhost:1338
 */

import {
  annotateSse,
  apiError,
  createTpxProvider,
  escapeHtml,
  type Grant,
  type Meter,
} from '@tokenpony/tpx-provider';
import type { Context } from 'hono';

const PORT = Number(process.env.PORT ?? 1338);
const UPSTREAM = (process.env.UPSTREAM ?? 'http://localhost:1337').replace(/\/$/, '');
const STATE_PATH = new URL('../state.json', import.meta.url).pathname;

// OpenRouter pricing shape: USD per token as decimal strings, "0" = free.
const ZERO_PRICING = {
  prompt: '0',
  completion: '0',
  request: '0',
  input_cache_read: '0',
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

async function chatCompletions(c: Context, grant: Grant, meter: Meter) {
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

  meter.debit(0); // free inference; keeps the metering seam exercised
  if (streaming && upstream.headers.get('content-type')?.includes('text/event-stream'))
    return new Response(annotateSse(upstream.body!, 0), {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });

  const json = (await upstream.json()) as { usage?: Record<string, unknown> };
  if (json.usage) json.usage.cost = 0;
  return c.json(json);
}

const app = createTpxProvider({
  statePath: STATE_PATH,
  title: 'tpx-local',
  consentNote: `Inference runs on your machine at ${UPSTREAM}, so usage costs $0. The budget is a cap, not a payment.`,
  listModels,
  chatCompletions,
  statusHtml: () => `<p>A TPX v0.3 provider backed by the local OpenAI endpoint at <code>${escapeHtml(UPSTREAM)}</code>.
All inference is free: models publish zero USD rates.</p>
<p>To use from hosted Pony Chat, expose this server with
<code>cloudflared tunnel --url http://localhost:${PORT}</code> and paste the tunnel URL into the connect box.</p>`,
});

console.log(`tpx-local listening on http://localhost:${PORT}, proxying ${UPSTREAM}`);

export default {
  port: PORT,
  // Streaming completions from a slow local model can idle between chunks.
  idleTimeout: 240,
  fetch: app.fetch,
};
