export interface ModelEntry {
  /** Friendly id exposed on /v1/models */
  id: string;
  /** Workers AI model id */
  cf: string;
  /** Input/output convention of the underlying model */
  api: 'chat' | 'responses';
  owned_by: string;
  description: string;
}

export const MODELS: ModelEntry[] = [
  // Self-hosted on proc-0 (vLLM behind the platform's AI binding). The
  // `@proc/` namespace is what the proc-dev platform's env.AI.models() reports.
  {
    id: 'qwen3.8-27b',
    cf: '@proc/qwen3.8-27b',
    api: 'chat',
    owned_by: 'proc',
    description: 'Qwen 3.8 27B (FP8) self-hosted on proc-0 via vLLM, 131k context, tools + reasoning',
  },
  // kimi-k3 (moonshotai/kimi-k3, partner catalog) is plumbed and priced in
  // pricing.ts; re-add here once Unified Billing credits are purchased.
  {
    id: 'kimi-k2.7-code',
    cf: '@cf/moonshotai/kimi-k2.7-code',
    api: 'chat',
    owned_by: 'moonshotai',
    description: 'Kimi K2.7 Code, 1T MoE, 262k context, tools + vision',
  },
  {
    id: 'llama-3.3-70b',
    cf: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    api: 'chat',
    owned_by: 'meta',
    description: 'Llama 3.3 70B, fp8 fast serving',
  },
  {
    id: 'gpt-oss-120b',
    cf: '@cf/openai/gpt-oss-120b',
    api: 'responses',
    owned_by: 'openai',
    description: 'gpt-oss 120B open-weight reasoning model',
  },
  {
    id: 'qwen2.5-coder-32b',
    cf: '@cf/qwen/qwen2.5-coder-32b-instruct',
    api: 'chat',
    owned_by: 'alibaba',
    description: 'Qwen 2.5 Coder 32B',
  },
  {
    id: 'mistral-small-24b',
    cf: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    api: 'chat',
    owned_by: 'mistral',
    description: 'Mistral Small 3.1 24B',
  },
  {
    id: 'llama-3.1-8b',
    cf: '@cf/meta/llama-3.1-8b-instruct-fp8',
    api: 'chat',
    owned_by: 'meta',
    description: 'Llama 3.1 8B fp8, quick and cheap',
  },
];

/**
 * Namespaces that exist only behind a self-hosted platform's AI binding.
 * They never appear in a catalog unless MODEL_FILTER opts in, so their
 * entries can live in MODELS without leaking into the Cloudflare deployment.
 */
const PLATFORM_PREFIXES = ['@proc/'];

/**
 * The catalog a deployment actually serves. MODEL_FILTER (comma-separated
 * prefixes of the upstream `cf` id, e.g. "@proc/") narrows the static list
 * to what the AI binding behind this deployment really runs; unset means
 * everything Workers AI serves (platform-only namespaces excluded).
 * Everything that lists or accepts a model goes through here, so a
 * filtered-out id is unknown rather than silently served (and priced) as
 * something else.
 */
export function catalog(env: { MODEL_FILTER?: string }): ModelEntry[] {
  const prefixes = (env.MODEL_FILTER ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!prefixes.length)
    return MODELS.filter((m) => !PLATFORM_PREFIXES.some((p) => m.cf.startsWith(p)));
  return MODELS.filter((m) => prefixes.some((p) => m.cf.startsWith(p)));
}

export function resolveModel(id: string, env: { MODEL_FILTER?: string } = {}): ModelEntry | undefined {
  return catalog(env).find((m) => m.id === id || m.cf === id);
}
