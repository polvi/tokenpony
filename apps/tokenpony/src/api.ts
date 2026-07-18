import { Hono } from 'hono';
import type { Context } from 'hono';
import { MODELS, resolveModel, type ModelEntry } from './models';
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

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Who is spending: a personal key or a TPP grant. */
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
      `SELECT k.id AS key_id, k.revoked, u.id AS user_id, u.balance_tokens
       FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?`,
    )
      .bind(hash)
      .first<{ key_id: string; revoked: number; user_id: string; balance_tokens: number }>();
    if (!row) return jsonError(401, 'invalid_token', 'Unknown API key');
    if (row.revoked) return jsonError(401, 'invalid_token', 'API key revoked');
    if (row.balance_tokens <= 0)
      return jsonError(402, 'balance_exhausted', 'Your tokenpony balance is empty — top up at https://api.tokenpony.dev/dashboard');
    return { userId: row.user_id, balance: row.balance_tokens, apiKeyId: row.key_id };
  }

  if (token.startsWith('tpp_')) {
    const row = await c.env.DB.prepare(
      `SELECT g.id AS grant_id, g.status, g.budget_total, g.budget_used, u.id AS user_id, u.balance_tokens
       FROM grants g JOIN users u ON u.id = g.user_id WHERE g.token_hash = ?`,
    )
      .bind(hash)
      .first<{
        grant_id: string;
        status: string;
        budget_total: number;
        budget_used: number;
        user_id: string;
        balance_tokens: number;
      }>();
    if (!row) return jsonError(401, 'invalid_token', 'Unknown grant token');
    if (row.status !== 'active')
      return jsonError(403, 'grant_revoked', 'The user revoked this grant');
    const remaining = row.budget_total - row.budget_used;
    if (remaining <= 0)
      return jsonError(402, 'budget_exhausted', 'Grant budget spent — request a new authorization');
    if (row.balance_tokens <= 0)
      return jsonError(402, 'balance_exhausted', "The user's provider balance is empty");
    return {
      userId: row.user_id,
      balance: row.balance_tokens,
      grant: { id: row.grant_id, remaining },
    };
  }

  return jsonError(401, 'invalid_token', 'Unrecognized token format');
}

async function debit(
  c: Context<AppEnv>,
  spender: Spender,
  model: string,
  usage: Usage,
): Promise<void> {
  const total = usage.total_tokens;
  const stmts = [
    c.env.DB.prepare('UPDATE users SET balance_tokens = balance_tokens - ? WHERE id = ?').bind(
      total,
      spender.userId,
    ),
    c.env.DB.prepare(
      `INSERT INTO usage_events (id, user_id, grant_id, api_key_id, model, prompt_tokens, completion_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      spender.userId,
      spender.grant?.id ?? null,
      spender.apiKeyId ?? null,
      model,
      usage.prompt_tokens,
      usage.completion_tokens,
    ),
  ];
  if (spender.grant) {
    stmts.push(
      c.env.DB.prepare('UPDATE grants SET budget_used = budget_used + ? WHERE id = ?').bind(
        total,
        spender.grant.id,
      ),
    );
  }
  await c.env.DB.batch(stmts);
}

function normalizeUsage(raw: unknown, prompt: string, completion: string): Usage {
  const u = raw as Partial<Usage> | undefined;
  const prompt_tokens = u?.prompt_tokens ?? estimateTokens(prompt);
  const completion_tokens = u?.completion_tokens ?? estimateTokens(completion);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
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

function completionEnvelope(model: string, content: string, usage: Usage) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage,
  };
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

api.get('/models', (c) =>
  c.json({
    object: 'list',
    data: MODELS.map((m) => ({
      id: m.id,
      object: 'model',
      owned_by: m.owned_by,
      description: m.description,
    })),
  }),
);

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
    return jsonError(404, 'model_not_found', `Unknown model '${body.model}' — see /v1/models`);

  // Cap completion size to what the spender can still afford (grant budget or balance).
  const affordable = Math.min(
    spender.grant?.remaining ?? Infinity,
    spender.balance,
    body.max_tokens ?? 2048,
  );
  const maxTokens = Math.max(64, Math.min(affordable, 4096));
  const promptText = body.messages.map((m) => m.content).join('\n');

  if (body.stream) {
    return streamCompletion(c, spender, model, body, maxTokens, promptText);
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
    result = (await c.env.AI.run(model.cf as Parameters<Ai['run']>[0], aiInput as never)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    console.log(JSON.stringify({ event: 'ai_error', model: model.cf, error: String(err) }));
    return jsonError(502, 'upstream_error', `Inference failed: ${String(err)}`);
  }

  const content =
    model.api === 'chat' ? String(result.response ?? '') : fromResponsesOutput(result);
  const usage = normalizeUsage(result.usage, promptText, content);
  await debit(c, spender, model.id, usage);
  return c.json(completionEnvelope(model.id, content, usage));
});

async function streamCompletion(
  c: Context<AppEnv>,
  spender: Spender,
  model: ModelEntry,
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
    )) as unknown as ReadableStream;
  } catch (err) {
    console.log(JSON.stringify({ event: 'ai_error', model: model.cf, error: String(err) }));
    return jsonError(502, 'upstream_error', `Inference failed: ${String(err)}`);
  }

  const id = `chatcmpl-${crypto.randomUUID()}`;
  let completionText = '';
  let reportedUsage: Partial<Usage> | undefined;
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
          if (chunk.usage) reportedUsage = chunk.usage as Partial<Usage>;
          const rawDelta =
            model.api === 'chat'
              ? chunk.response
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
      const usage = normalizeUsage(reportedUsage, promptText, completionText);
      controller.enqueue(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model.id,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage,
        })}\n\ndata: [DONE]\n\n`,
      );
      settle();
    },
  });

  // Meter after the stream finishes; usage is known only at flush time.
  c.executionCtx.waitUntil(
    done.then(() =>
      debit(c, spender, model.id, normalizeUsage(reportedUsage, promptText, completionText)),
    ),
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
