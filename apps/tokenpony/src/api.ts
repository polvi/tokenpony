import { Hono } from 'hono';
import type { Context } from 'hono';
import { maybeAutoTopup } from './billing';
import { verifyDpopProof } from './dpop';
import { MODELS, resolveModel, type ModelEntry } from './models';
import { creditsFor, getPrices, priceFor, type ModelPrice, type TokenCounts } from './pricing';
import { estimateTokens, jsonError, sha256Hex } from './util';
import { commit, missionModels, release, reserve } from './aauth/missions';
import { authenticateAAuth, aauthUnauthorized, buildAAuthChallenge } from './aauth/verify';
import type { AppEnv } from './types';

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
}

/** Who is spending: a personal key, a TPX grant, or an AAuth mission. Credits (micro-USD). */
interface Spender {
  userId: string;
  balance: number;
  apiKeyId?: string;
  grant?: { id: string; remaining: number; models?: string[] | null };
  mission?: { id: string; remaining: number; models: string[] | null };
}

/** RFC 6750/9728 challenge on 401s so clients can bootstrap discovery. */
function unauthorized(c: Context<AppEnv>, message: string, invalidToken = true): Response {
  const challenge = [
    'Bearer',
    ...(invalidToken ? ['error="invalid_token"'] : []),
    `resource_metadata="${c.env.ISSUER}/.well-known/oauth-protected-resource"`,
  ];
  return Response.json(
    { error: { code: 'invalid_token', message } },
    {
      status: 401,
      headers: {
        'www-authenticate': `${challenge[0]} ${challenge.slice(1).join(', ')}`,
      },
    },
  );
}

async function authenticateAAuthSpender(c: Context<AppEnv>): Promise<Spender | Response> {
  const auth = await authenticateAAuth(c);
  if (auth.kind === 'none') return unauthorized(c, 'Missing access token', false);
  if (auth.kind === 'error') return aauthUnauthorized(c, auth.code, auth.message);
  const m = auth.mission;
  if (m.user_id === null) {
    const fundingUrl = `${c.env.ISSUER}/fund?approver=${encodeURIComponent(m.approver)}&s256=${encodeURIComponent(m.s256)}`;
    return Response.json(
      {
        error: { code: 'mission_unfunded', message: 'this mission has no funding account yet' },
        funding_url: fundingUrl,
      },
      { status: 402 },
    );
  }
  const user = await c.env.DB.prepare('SELECT balance_credits FROM users WHERE id = ?')
    .bind(m.user_id)
    .first<{ balance_credits: number }>();
  if (!user) return jsonError(402, 'balance_exhausted', 'funding account not found');
  return {
    userId: m.user_id,
    balance: user.balance_credits,
    mission: { id: m.id, remaining: m.budget_total - m.budget_used - m.reserved, models: missionModels(m) },
  };
}

async function authenticate(c: Context<AppEnv>): Promise<Spender | Response> {
  const header = c.req.header('authorization') ?? '';
  // AAuth (TPX-A): budgeted auth token in `Authorization: AAuth <jwt>`.
  if (/^AAuth\s+/i.test(header)) return authenticateAAuthSpender(c);
  // Agent-signed request with no auth token yet -> resource-token challenge.
  if (!header && c.req.header('signature-key')) return buildAAuthChallenge(c);
  const token = header.replace(/^(Bearer|DPoP)\s+/i, '').trim();
  if (!token) return unauthorized(c, 'Missing access token', false);
  const hash = await sha256Hex(token);

  if (token.startsWith('sk_')) {
    const row = await c.env.DB.prepare(
      `SELECT k.id AS key_id, k.revoked, u.id AS user_id, u.balance_credits
       FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?`,
    )
      .bind(hash)
      .first<{ key_id: string; revoked: number; user_id: string; balance_credits: number }>();
    if (!row) return jsonError(401, 'invalid_token', 'Unknown API key');
    if (row.revoked) return jsonError(401, 'invalid_token', 'API key revoked');
    if (row.balance_credits <= 0)
      return jsonError(402, 'balance_exhausted', 'Your tokenpony credit balance is empty; top off at https://api.tokenpony.dev/dashboard');
    return { userId: row.user_id, balance: row.balance_credits, apiKeyId: row.key_id };
  }

  if (token.startsWith('tpx_at_')) {
    const row = await c.env.DB.prepare(
      `SELECT a.expires_at, a.dpop_jkt, g.id AS grant_id, g.status, g.budget_total, g.budget_used, g.models,
              u.id AS user_id, u.balance_credits
       FROM access_tokens a
       JOIN grants g ON g.id = a.grant_id
       JOIN users u ON u.id = g.user_id
       WHERE a.token_hash = ?`,
    )
      .bind(hash)
      .first<{
        expires_at: string;
        dpop_jkt: string | null;
        grant_id: string;
        status: string;
        budget_total: number;
        budget_used: number;
        models: string | null;
        user_id: string;
        balance_credits: number;
      }>();
    if (!row) return unauthorized(c, 'Unknown access token');
    if (Date.parse(`${row.expires_at}Z`) < Date.now())
      return unauthorized(c, 'Access token expired');
    // A revoked grant is an invalid token (v0.2 collapses 403 grant_revoked).
    if (row.status !== 'active') return unauthorized(c, 'Grant revoked');
    if (row.dpop_jkt) {
      const proof = c.req.header('dpop');
      const jkt = proof
        ? await verifyDpopProof({
            proof,
            htm: c.req.method,
            htu: c.req.url,
            accessToken: token,
          })
        : null;
      if (!jkt || jkt !== row.dpop_jkt)
        return unauthorized(c, 'DPoP proof missing or bound to a different key');
    }
    const remaining = row.budget_total - row.budget_used;
    if (remaining <= 0)
      return jsonError(402, 'budget_exhausted', 'Grant budget spent; request a new authorization');
    if (row.balance_credits <= 0)
      return jsonError(402, 'balance_exhausted', "The user's provider balance is empty");
    return {
      userId: row.user_id,
      balance: row.balance_credits,
      grant: {
        id: row.grant_id,
        remaining,
        models: row.models ? (JSON.parse(row.models) as string[]) : null,
      },
    };
  }

  return unauthorized(c, 'Unrecognized token format');
}

async function debit(
  c: Context<AppEnv>,
  spender: Spender,
  model: string,
  counts: TokenCounts,
  credits: number,
  reserved?: number,
): Promise<void> {
  const stmts = [
    c.env.DB.prepare('UPDATE users SET balance_credits = balance_credits - ? WHERE id = ?').bind(
      credits,
      spender.userId,
    ),
    c.env.DB.prepare(
      `INSERT INTO usage_events (id, user_id, grant_id, api_key_id, model, prompt_tokens, cached_tokens, completion_tokens, credits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      spender.userId,
      spender.grant?.id ?? null,
      spender.apiKeyId ?? null,
      model,
      counts.prompt_tokens,
      counts.cached_tokens,
      counts.completion_tokens,
      credits,
    ),
  ];
  if (spender.grant) {
    stmts.push(
      c.env.DB.prepare('UPDATE grants SET budget_used = budget_used + ? WHERE id = ?').bind(
        credits,
        spender.grant.id,
      ),
    );
  }
  await c.env.DB.batch(stmts);
  // AAuth mission: commit the actual charge against the reservation, release the rest.
  if (spender.mission && reserved !== undefined) {
    await commit(c.env.DB, spender.mission.id, reserved, credits);
  }
  // Refill the balance off-session if the user opted into auto top-off.
  c.executionCtx.waitUntil(maybeAutoTopup(c.env, spender.userId));
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cached_tokens?: number;
}

function normalizeCounts(raw: unknown, prompt: string, completion: string): TokenCounts {
  const u = (raw ?? {}) as RawUsage;
  const prompt_tokens = u.prompt_tokens ?? estimateTokens(prompt);
  const completion_tokens = u.completion_tokens ?? estimateTokens(completion);
  const cached_tokens = u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
  return { prompt_tokens, cached_tokens, completion_tokens };
}

/** OpenAI-compatible usage block, extended per TPX v0.2 (Section 8.3). */
function usageBlock(counts: TokenCounts, credits: number) {
  return {
    prompt_tokens: counts.prompt_tokens,
    cached_tokens: counts.cached_tokens,
    completion_tokens: counts.completion_tokens,
    total_tokens: counts.prompt_tokens + counts.completion_tokens,
    prompt_tokens_details: { cached_tokens: counts.cached_tokens },
    credits_charged: credits,
  };
}

/** Convert chat messages to the Responses-API input used by gpt-oss models. */
function toResponsesInput(messages: ChatMessage[]): { instructions?: string; input: string } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages.filter((m) => m.role !== 'system');
  const input =
    rest.length === 1
      ? rest[0].content
      : rest.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n');
  return { instructions: system.join('\n') || undefined, input };
}

/** Extract text from a Responses-API result object. */
function fromResponsesOutput(result: Record<string, unknown>): string {
  if (typeof result.output_text === 'string') return result.output_text;
  const output = result.output as
    | { type?: string; content?: { type?: string; text?: string }[] }[]
    | undefined;
  if (!output) return '';
  return output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' && part.text)
    .map((part) => part.text)
    .join('');
}

/** Pull assistant text from either Workers AI ({response}) or OpenAI ({choices}) shapes. */
function chatContent(result: Record<string, unknown>): string {
  if (typeof result.response === 'string') return result.response;
  const choices = result.choices as { message?: { content?: string } }[] | undefined;
  return choices?.[0]?.message?.content ?? String(result.response ?? '');
}

/**
 * Partner-catalog models (no @cf/ prefix) bill via AI Gateway Unified
 * Billing and must be routed through a gateway; @cf models run direct.
 */
function gatewayOptions(c: Context<AppEnv>, model: ModelEntry) {
  if (model.cf.startsWith('@cf/')) return undefined;
  return { gateway: { id: c.env.AI_GATEWAY_ID } } as never;
}

function sseChunk(model: string, id: string, delta: Record<string, unknown>, extra?: Record<string, unknown>) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}\n\n`;
}

export const api = new Hono<AppEnv>();

api.get('/models', async (c) => {
  const prices = await getPrices(c.env);
  return c.json({
    object: 'list',
    data: await Promise.all(
      MODELS.map(async (m) => ({
        id: m.id,
        object: 'model',
        owned_by: m.owned_by,
        description: m.description,
        pricing: await priceFor(c.env, m.cf).then((p) => ({
          usd_per_m_input_tokens: p.inputPerM,
          usd_per_m_cached_input_tokens: p.cachedInputPerM,
          usd_per_m_output_tokens: p.outputPerM,
          // TPX-A section 4.3: per-token rates in credits, as strings.
          credits_per_token: {
            input: String(p.inputPerM),
            cached_input: String(p.cachedInputPerM),
            output: String(p.outputPerM),
          },
          source: prices[m.cf] ? 'cloudflare_catalog' : 'static',
        })),
      })),
    ),
  });
});

api.post('/chat/completions', async (c) => {
  const spender = await authenticate(c);
  if (spender instanceof Response) return spender;

  let body: ChatRequest;
  try {
    body = await c.req.json<ChatRequest>();
  } catch {
    return jsonError(400, 'invalid_request', 'Body must be JSON');
  }
  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0)
    return jsonError(400, 'invalid_request', '`model` and `messages` are required');

  const model = resolveModel(body.model);
  if (!model)
    return jsonError(404, 'model_not_found', `Unknown model '${body.model}'; see /v1/models`);
  // Model restriction. The AAuth path uses TPX-A's code `model_not_allowed`.
  const restrictModels = spender.mission?.models ?? spender.grant?.models ?? null;
  if (restrictModels && !restrictModels.includes(model.id))
    return jsonError(
      403,
      spender.mission ? 'model_not_allowed' : 'model_not_permitted',
      `This grant is limited to: ${restrictModels.join(', ')}`,
    );

  const price = await priceFor(c.env, model.cf);

  // AAuth requests MUST bound their cost (reservation basis).
  const maxReq = body.max_completion_tokens ?? body.max_tokens;
  if (spender.mission && maxReq === undefined)
    return jsonError(400, 'max_tokens_required', 'AAuth requests must send max_completion_tokens');

  // Cap the completion to what the spender can still afford at this model's
  // output rate (credits per token equals USD per M tokens).
  const affordableCredits = Math.min(
    spender.grant?.remaining ?? Infinity,
    spender.mission?.remaining ?? Infinity,
    spender.balance,
  );
  const affordableOutput = Math.floor(affordableCredits / price.outputPerM);
  const maxTokens = Math.max(16, Math.min(maxReq ?? 2048, affordableOutput, 8192));
  const promptText = body.messages.map((m) => m.content).join('\n');

  // Reserve the worst-case charge before inference (AAuth path, seam contract section 6).
  let reserved: number | undefined;
  if (spender.mission) {
    reserved = creditsFor(price, {
      prompt_tokens: estimateTokens(promptText),
      cached_tokens: 0,
      completion_tokens: maxTokens,
    });
    if (reserved > spender.balance)
      return jsonError(402, 'balance_exhausted', "The funder's balance can't cover this request");
    if (!(await reserve(c.env.DB, spender.mission.id, reserved)))
      return jsonError(402, 'budget_exhausted', 'This grant cannot cover the requested maximum cost.');
  }

  if (body.stream) {
    return streamCompletion(c, spender, model, price, body, maxTokens, promptText, reserved);
  }

  const aiInput =
    model.api === 'chat'
      ? {
          messages: body.messages,
          max_tokens: maxTokens,
          ...(body.temperature !== undefined && { temperature: body.temperature }),
        }
      : toResponsesInput(body.messages);

  let result: Record<string, unknown>;
  try {
    result = (await c.env.AI.run(
      model.cf as Parameters<Ai['run']>[0],
      aiInput as never,
      gatewayOptions(c, model),
    )) as Record<string, unknown>;
  } catch (err) {
    console.log(JSON.stringify({ event: 'ai_error', model: model.cf, error: String(err) }));
    if (spender.mission && reserved !== undefined) await release(c.env.DB, spender.mission.id, reserved);
    return jsonError(502, 'upstream_error', `Inference failed: ${String(err)}`);
  }

  const content = model.api === 'chat' ? chatContent(result) : fromResponsesOutput(result);
  const counts = normalizeCounts(result.usage, promptText, content);
  const credits = creditsFor(price, counts);
  await debit(c, spender, model.id, counts, credits, reserved);
  return c.json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: usageBlock(counts, credits),
  });
});

async function streamCompletion(
  c: Context<AppEnv>,
  spender: Spender,
  model: ModelEntry,
  price: ModelPrice,
  body: ChatRequest,
  maxTokens: number,
  promptText: string,
  reserved?: number,
): Promise<Response> {
  const aiInput =
    model.api === 'chat'
      ? { messages: body.messages, max_tokens: maxTokens, stream: true }
      : { ...toResponsesInput(body.messages), stream: true };

  let upstream: ReadableStream;
  try {
    upstream = (await c.env.AI.run(
      model.cf as Parameters<Ai['run']>[0],
      aiInput as never,
      gatewayOptions(c, model),
    )) as unknown as ReadableStream;
  } catch (err) {
    console.log(JSON.stringify({ event: 'ai_error', model: model.cf, error: String(err) }));
    if (spender.mission && reserved !== undefined) await release(c.env.DB, spender.mission.id, reserved);
    return jsonError(502, 'upstream_error', `Inference failed: ${String(err)}`);
  }

  const id = `chatcmpl-${crypto.randomUUID()}`;
  let completionText = '';
  let reportedUsage: unknown;
  let settled = false;
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
  });

  let buffer = '';
  const transform = new TransformStream<string, string>({
    start(controller) {
      controller.enqueue(sseChunk(model.id, id, { role: 'assistant', content: '' }));
    },
    transform(text, controller) {
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload) as Record<string, unknown>;
          if (chunk.usage) reportedUsage = chunk.usage;
          const openaiDelta = (chunk.choices as { delta?: { content?: unknown } }[] | undefined)?.[0]
            ?.delta?.content;
          const rawDelta =
            model.api === 'chat'
              ? (chunk.response ?? openaiDelta)
              : chunk.type === 'response.output_text.delta'
                ? chunk.delta
                : undefined;
          // Workers AI emits numeric tokens as bare JSON numbers; clients expect strings.
          if (rawDelta !== undefined && rawDelta !== null && rawDelta !== '') {
            const delta = String(rawDelta);
            completionText += delta;
            controller.enqueue(sseChunk(model.id, id, { content: delta }));
          }
        } catch {
          // ignore malformed lines
        }
      }
    },
    flush(controller) {
      const counts = normalizeCounts(reportedUsage, promptText, completionText);
      const credits = creditsFor(price, counts);
      controller.enqueue(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model.id,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: usageBlock(counts, credits),
        })}\n\ndata: [DONE]\n\n`,
      );
      settle();
    },
  });

  // Meter after the stream finishes; usage is known only at flush time.
  c.executionCtx.waitUntil(
    done.then(() => {
      const counts = normalizeCounts(reportedUsage, promptText, completionText);
      return debit(c, spender, model.id, counts, creditsFor(price, counts), reserved);
    }),
  );

  const readable = upstream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(transform)
    .pipeThrough(new TextEncoderStream());

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
}
