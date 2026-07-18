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

export function resolveModel(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id || m.cf === id);
}
