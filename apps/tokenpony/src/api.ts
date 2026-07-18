import { Hono } from 'hono';
import type { Context } from 'hono';
import { MODELS, resolveModel, type ModelEntry } from './models';
import { creditsFor, getPrices, priceFor, type ModelPrice, type TokenCounts } from './pricing';
import { estimateTokens, jsonError, sha256Hex } from './util';
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
  temperature?: number;
}

/** Who is spending: a personal key or a TPX grant. Amounts are credits (micro-USD). */
interface Spender {
  userId: string;
  balance: number;
  apiKeyId?: string;
  grant?: { id: string; remaining: number };
}

async function authenticate(c: Context<AppEnv>): Promise<Spender | Response> {
  const header = c.req.header('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return jsonError(401, 'invalid_token', 'Missing Authorization: Bearer token');
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
      return jsonError(402, 'balance_exhausted', 'Your tokenpony credit balance is empty; top up at https://api.tokenpony.dev/dashboard');
    return { userId: row.user_id, balance: row.balance_credits, apiKeyId: row.key_id };
  }

  if (token.startsWith('tpx_')) {
    const row = await c.env.DB.prepare(
      `SELECT g.id AS grant_id, g.status, g.budget_total, g.budget_used, u.id AS user_id, u.balance_credits
       FROM grants g JOIN users u ON u.id = g.user_id WHERE g.token_hash = ?`,
    )
      .bind(hash)
      .first<{
        grant_id: string;
        status: string;
        budget_total: number;
        budget_used: number;
        user_id: string;
        balance_credits: number;
      }>();
    if (!row) return jsonError(401, 'invalid_token', 'Unknown grant token');
    if (row.status !== 'active')
      return jsonError(403, 'grant_revoked', 'The user revoked this grant');
    const remaining = row.budget_total - row.budget_used;
    if (remaining <= 0)
      return jsonError(402, 'budget_exhausted', 'Grant budget spent; request a new authorization');
    if (row.balance_credits <= 0)
      return jsonError(402, 'balance_exhausted', "The user's provider balance is empty");
    return {
      userId: row.user_id,
      balance: row.balance_credits,
      grant: { id: row.grant_id, remaining },
    };
  }

  return jsonError(401, 'invalid_token', 'Unrecognized token format');
}

async function debit(
  c: Context<AppEnv>,
  spender: Spender,
  model: string,
  counts: TokenCounts,
  credits: number,
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

/** OpenAI-compatible usage block, extended with tokenpony's credit charge. */
function usageBlock(counts: TokenCounts, credits: number) {
  return {
    prompt_tokens: counts.prompt_tokens,
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

  const price = await priceFor(c.env, model.cf);

  // Cap the completion to what the spender can still afford at this model's
  // output rate (credits per token equals USD per M tokens).
  const affordableCredits = Math.min(spender.grant?.remaining ?? Infinity, spender.balance);
  const affordableOutput = Math.floor(affordableCredits / price.outputPerM);
  const maxTokens = Math.max(16, Math.min(body.max_tokens ?? 2048, affordableOutput, 8192));
  const promptText = body.messages.map((m) => m.content).join('\n');

  if (body.stream) {
    return streamCompletion(c, spender, model, price, body, maxTokens, promptText);
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
    return jsonError(502, 'upstream_error', `Inference failed: ${String(err)}`);
  }

  const content = model.api === 'chat' ? chatContent(result) : fromResponsesOutput(result);
  const counts = normalizeCounts(result.usage, promptText, content);
  const credits = creditsFor(price, counts);
  await debit(c, spender, model.id, counts, credits);
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
      return debit(c, spender, model.id, counts, creditsFor(price, counts));
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
