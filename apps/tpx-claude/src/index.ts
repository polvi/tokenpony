/**
 * tpx-claude: a TPX v0.2 provider shim backed by your own Claude Code login.
 *
 * Personal use only. Each completion spawns headless Claude Code (`claude -p`)
 * on this machine, so requests draw on your Claude subscription through the
 * CLI's own auth; this shim never reads, stores, or forwards credentials.
 * Grant approval requires a PIN printed to this terminal, so even when the
 * shim is tunneled so your own hosted apps can reach it, nobody else can mint
 * a grant. Do not share grants or publish the tunnel URL.
 *
 * The spawned session is stripped bare: no tools, no MCP servers, no skills,
 * no settings, a replaced system prompt, and an empty working directory, so a
 * connected app can only ever get chat completions out of it.
 *
 * Subscription usage has no marginal price, so models publish zero credit
 * rates and completions report usage.credits_charged: 0 with real token
 * counts. The grant budget is a cap, not a payment.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiError,
  createTpxProvider,
  randomToken,
  type Grant,
} from '@tokenpony/tpx-provider';
import type { Context } from 'hono';

const PORT = Number(process.env.PORT ?? 1339);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const CANDIDATES = (process.env.MODELS ?? 'fable,opus,sonnet,haiku').split(',').map((m) => m.trim());
const COMPLETION_TIMEOUT_MS = 300_000;
const STATE_PATH = new URL('../state.json', import.meta.url).pathname;
const MODELS_CACHE_PATH = new URL('../models.json', import.meta.url).pathname;
const MODELS_CACHE_TTL_MS = 24 * 3600 * 1000;

const PIN =
  process.env.PIN ?? String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));

// The subprocess runs in an empty scratch directory so that, even if a flag
// regresses, there is no project for a session to see.
const EMPTY_CWD = mkdtempSync(join(tmpdir(), 'tpx-claude-'));

const FRAMING =
  'You are the assistant inside a chat application. Reply to the last user message with the assistant reply only, as plain text or markdown.';

// -- OpenAI request mapping ---------------------------------------------------

interface ChatMessage {
  role: string;
  content: string | { type?: string; text?: string }[];
}

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map((part) => part.text ?? '').join('');
}

/** Render an OpenAI messages array into a system prompt and a single prompt. */
function renderMessages(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = [FRAMING, ...messages.filter((m) => m.role === 'system').map((m) => textOf(m.content))]
    .join('\n\n')
    .trim();
  const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (turns.length === 1 && turns[0].role === 'user')
    return { system, prompt: textOf(turns[0].content) };
  const transcript = turns
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${textOf(m.content)}`)
    .join('\n\n');
  return { system, prompt: `The conversation so far:\n\n${transcript}` };
}

// -- Headless Claude Code -----------------------------------------------------

interface StreamEventLine {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  model?: string; // resolved full model id, on the init event
  event?: {
    type: string;
    delta?: { type: string; text?: string };
  };
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
}

function spawnClaude(model: string, system: string, prompt: string) {
  // No tools, no MCP, no skills, no settings, replaced system prompt: the
  // session is a pure completion. --bare would also drop the subscription
  // login, so the surface is stripped flag by flag instead.
  const proc = Bun.spawn(
    [
      CLAUDE_BIN,
      '-p',
      '--model',
      model,
      '--tools',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--setting-sources',
      '',
      '--system-prompt',
      system,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--no-session-persistence',
    ],
    { cwd: EMPTY_CWD, stdin: new TextEncoder().encode(prompt), stdout: 'pipe', stderr: 'pipe' },
  );
  const timeout = setTimeout(() => proc.kill(), COMPLETION_TIMEOUT_MS);
  proc.exited.finally(() => clearTimeout(timeout));
  return proc;
}

/** Parse the newline-delimited stream-json output into typed events. */
async function* claudeEvents(stdout: ReadableStream<Uint8Array>): AsyncGenerator<StreamEventLine> {
  const reader = stdout
    .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
    .getReader();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as StreamEventLine;
      } catch {
        // ignore non-JSON diagnostics
      }
    }
  }
}

function usageOf(result: StreamEventLine) {
  const u = result.usage ?? {};
  const prompt_tokens =
    (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const completion_tokens = u.output_tokens ?? 0;
  return {
    prompt_tokens,
    cached_tokens: u.cache_read_input_tokens ?? 0,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    credits_charged: 0,
  };
}

// -- Model verification -------------------------------------------------------

interface VerifiedModel {
  alias: string; // the configured name, e.g. 'sonnet'
  id: string; // the resolved full id from the init event, e.g. 'claude-sonnet-5'
}

/**
 * Attempt a tiny completion to learn whether this login can use the model and
 * what full id the alias resolves to. Unavailable models fail fast (the CLI
 * reports is_error with zero cost); available ones spend a few dozen tokens.
 */
async function probeModel(alias: string): Promise<VerifiedModel | null> {
  const proc = spawnClaude(alias, FRAMING, 'Reply with only: ok');
  let id = alias;
  for await (const event of claudeEvents(proc.stdout)) {
    if (event.subtype === 'init' && event.model) id = event.model;
    if (event.type === 'result') return event.is_error ? null : { alias, id };
  }
  return null;
}

async function verifyModels(): Promise<VerifiedModel[]> {
  try {
    const cache = JSON.parse(readFileSync(MODELS_CACHE_PATH, 'utf8')) as {
      candidates: string[];
      checked_at: number;
      models: VerifiedModel[];
    };
    if (
      cache.candidates.join(',') === CANDIDATES.join(',') &&
      Date.now() - cache.checked_at < MODELS_CACHE_TTL_MS
    )
      return cache.models;
  } catch {
    // no cache yet
  }
  const models = (await Promise.all(CANDIDATES.map(probeModel))).filter(
    (m): m is VerifiedModel => m !== null,
  );
  writeFileSync(
    MODELS_CACHE_PATH,
    JSON.stringify({ candidates: CANDIDATES, checked_at: Date.now(), models }, null, 2),
  );
  return models;
}

const verifiedModels = verifyModels().then((models) => {
  if (models.length === 0)
    console.log('no models verified; is the claude CLI logged in? (claude /login)');
  else
    console.log(
      `verified models: ${models.map((m) => `${m.alias} -> ${m.id}`).join(', ')}` +
        (models.length < CANDIDATES.length
          ? ` (dropped: ${CANDIDATES.filter((c) => !models.some((m) => m.alias === c)).join(', ')})`
          : ''),
    );
  resolvedModels = models;
  return models;
});
let resolvedModels: VerifiedModel[] | null = null;

// -- Inference handlers -------------------------------------------------------

const ZERO_PRICING = {
  usd_per_m_input_tokens: 0,
  usd_per_m_cached_input_tokens: 0,
  usd_per_m_output_tokens: 0,
  credits_per_token: { input: '0', cached_input: '0', output: '0' },
  source: 'subscription',
};

async function listModels(c: Context) {
  const models = await verifiedModels;
  return c.json({
    object: 'list',
    data: models.map((m) => ({ id: m.id, object: 'model', owned_by: 'anthropic', pricing: ZERO_PRICING })),
  });
}

async function chatCompletions(c: Context, grant: Grant) {
  let body: { model?: string; messages?: ChatMessage[]; stream?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, 'invalid_request', 'Body must be JSON');
  }
  const model = body.model ?? '';
  const models = await verifiedModels;
  if (!models.some((m) => m.id === model || m.alias === model))
    return apiError(c, 404, 'model_not_found', `Unknown model '${model}'; see /v1/models`);
  if (grant.models && !grant.models.includes(model))
    return apiError(c, 403, 'model_not_allowed', `Grant is limited to: ${grant.models.join(', ')}`);
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    return apiError(c, 400, 'invalid_request', 'messages is required');

  const { system, prompt } = renderMessages(body.messages);
  const proc = spawnClaude(model, system, prompt);
  const id = `chatcmpl-${randomToken('')}`;
  const created = Math.floor(Date.now() / 1000);

  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra,
    })}\n\n`;

  if (body.stream === true) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (s: string) => controller.enqueue(encoder.encode(s));
        let finished = false;
        try {
          send(chunk({ role: 'assistant' }));
          for await (const event of claudeEvents(proc.stdout)) {
            if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
              const delta = event.event.delta;
              if (delta?.type === 'text_delta' && delta.text) send(chunk({ content: delta.text }));
            }
            if (event.type === 'result') {
              finished = true;
              if (event.is_error) {
                send(`data: ${JSON.stringify({ error: { code: 'upstream_error', message: event.result ?? 'Claude Code failed' } })}\n\n`);
              } else {
                send(
                  `data: ${JSON.stringify({
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    usage: usageOf(event),
                  })}\n\n`,
                );
              }
            }
          }
          if (!finished) {
            const stderr = await new Response(proc.stderr).text();
            send(`data: ${JSON.stringify({ error: { code: 'upstream_error', message: stderr.slice(0, 300) || 'Claude Code exited without a result' } })}\n\n`);
          }
          send('data: [DONE]\n\n');
        } finally {
          controller.close();
          proc.kill();
        }
      },
      cancel() {
        proc.kill();
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }

  let result: StreamEventLine | undefined;
  for await (const event of claudeEvents(proc.stdout)) {
    if (event.type === 'result') result = event;
  }
  if (!result || result.is_error) {
    const stderr = await new Response(proc.stderr).text();
    return apiError(
      c,
      502,
      'upstream_error',
      result?.result ?? stderr.slice(0, 300) ?? 'Claude Code exited without a result',
    );
  }
  return c.json({
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content: result.result ?? '' }, finish_reason: 'stop' },
    ],
    usage: usageOf(result),
  });
}

// -- Provider -----------------------------------------------------------------

const app = createTpxProvider({
  statePath: STATE_PATH,
  title: 'tpx-claude',
  consentNote:
    'This provider is one person’s own Claude subscription, gated by a PIN shown only in their terminal. Usage costs 0 credits; the budget is a cap, not a payment.',
  consentExtraHtml: '<input type="password" name="pin" placeholder="PIN from the terminal" required autocomplete="off"> ',
  approveGate: (form) => form.get('pin') === PIN,
  listModels,
  chatCompletions,
  statusHtml: () => `<p>A TPX v0.2 provider backed by this machine’s own Claude Code login (headless
<code>claude -p</code>, subscription auth handled entirely by the CLI). Personal use only: grant
approval requires the PIN printed in the terminal, and spawned sessions have no tools, no MCP
servers, and an empty working directory.</p>
<p>Models: ${(resolvedModels ?? []).map((m) => `<code>${m.id}</code>`).join(', ') || 'verifying against this login, refresh shortly'}.
All completions report <code>credits_charged: 0</code>.</p>`,
});

console.log(`tpx-claude listening on http://localhost:${PORT}, verifying models: ${CANDIDATES.join(', ')}`);
console.log(`grant approval PIN: ${PIN}`);

export default {
  port: PORT,
  // Long completions idle between output chunks while the model thinks.
  idleTimeout: 240,
  fetch: app.fetch,
};
