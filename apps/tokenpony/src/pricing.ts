import type { Bindings } from './types';

/**
 * Per-model unit prices in USD per million tokens. Because 1 credit is
 * US$0.000001, "$X per M tokens" is exactly X credits per token, so these
 * numbers double as credits-per-token rates.
 */
export interface ModelPrice {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
}

/**
 * Prices for models the Workers AI catalog can't report dynamically.
 * moonshotai/kimi-k3 is a partner-catalog model (AI Gateway unified billing)
 * and doesn't appear in env.AI.models(); rates from the Cloudflare dashboard.
 */
const STATIC_PRICES: Record<string, ModelPrice> = {
  'moonshotai/kimi-k3': { inputPerM: 3.0, cachedInputPerM: 0.3, outputPerM: 15.0 },
};

/**
 * Used only when a model is missing from both the live catalog and
 * STATIC_PRICES. Deliberately priced high so an unpriced model can't leak
 * cheap inference; fix by adding a static entry.
 */
const DEFAULT_PRICE: ModelPrice = { inputPerM: 5.0, cachedInputPerM: 5.0, outputPerM: 20.0 };

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Isolate-lifetime cache of the live price list. Not request state: it's a
// pure read-through cache of Cloudflare catalog data.
let cached: { at: number; prices: Record<string, ModelPrice> } | null = null;
let refreshing: Promise<Record<string, ModelPrice>> | null = null;

function parsePriceProperty(value: unknown): ModelPrice | null {
  if (!Array.isArray(value)) return null;
  const price: ModelPrice = { ...DEFAULT_PRICE };
  let sawInput = false;
  let sawOutput = false;
  for (const entry of value as { unit?: string; price?: number; currency?: string }[]) {
    if (typeof entry.price !== 'number' || entry.currency !== 'USD' || !entry.unit) continue;
    const unit = entry.unit.toLowerCase();
    if (!unit.includes('tokens')) continue;
    if (unit.includes('cached')) {
      price.cachedInputPerM = entry.price;
    } else if (unit.includes('input')) {
      price.inputPerM = entry.price;
      sawInput = true;
    } else if (unit.includes('output')) {
      price.outputPerM = entry.price;
      sawOutput = true;
    }
  }
  if (!sawInput || !sawOutput) return null;
  // Models without a cached-input rate bill cached tokens as normal input.
  if (!value.some((e: { unit?: string }) => e.unit?.toLowerCase().includes('cached'))) {
    price.cachedInputPerM = price.inputPerM;
  }
  return price;
}

async function fetchLivePrices(env: Bindings): Promise<Record<string, ModelPrice>> {
  const prices: Record<string, ModelPrice> = {};
  for (let page = 1; page <= 5; page++) {
    const models = await env.AI.models({ task: 'Text Generation', per_page: 100, page });
    for (const m of models) {
      const raw = m.properties.find((p) => p.property_id === 'price')?.value;
      const parsed = parsePriceProperty(raw as unknown);
      if (parsed) prices[m.name] = parsed;
    }
    if (models.length < 100) break;
  }
  return prices;
}

/**
 * Live price list from the Workers AI catalog, cached for 6 hours per
 * isolate. Serves the stale copy (or static fallbacks) if the refresh fails.
 */
export async function getPrices(env: Bindings): Promise<Record<string, ModelPrice>> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.prices;
  refreshing ??= fetchLivePrices(env)
    .then((prices) => {
      cached = { at: Date.now(), prices };
      return prices;
    })
    .catch((err) => {
      console.log(JSON.stringify({ event: 'pricing_refresh_failed', error: String(err) }));
      return cached?.prices ?? {};
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function priceFor(env: Bindings, cfModel: string): Promise<ModelPrice> {
  const live = await getPrices(env);
  return live[cfModel] ?? STATIC_PRICES[cfModel] ?? DEFAULT_PRICE;
}

export interface TokenCounts {
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
}

/** Cost in credits (micro-USD), rounded up so we never round in our favor last. */
export function creditsFor(price: ModelPrice, t: TokenCounts): number {
  const freshInput = Math.max(0, t.prompt_tokens - t.cached_tokens);
  return Math.ceil(
    freshInput * price.inputPerM +
      t.cached_tokens * price.cachedInputPerM +
      t.completion_tokens * price.outputPerM,
  );
}

export const usd = (credits: number) => `$${(credits / 1_000_000).toFixed(credits < 10_000 ? 4 : 2)}`;

/** Integer micro-USD to the USD number reported on the wire. */
export const microToUsd = (micro: number) => micro / 1_000_000;

/**
 * USD-per-M-token rate to a USD-per-token decimal string (OpenRouter pricing
 * shape). Goes through an integer so the output never uses scientific
 * notation; exact for catalog rates with <= 6 decimals per M.
 */
export function perTokenPrice(perM: number): string {
  const pico = Math.round(perM * 1_000_000); // integer USD per 1e12 tokens
  if (pico === 0) return '0';
  const s = String(pico).padStart(13, '0');
  return `${Number(s.slice(0, -12))}.${s.slice(-12)}`.replace(/\.?0+$/, '');
}

// -- TPX-A budget amount <-> credits (seam contract section 6) ----------------
// 1 credit = US$0.000001, so credits = amount * 1_000_000, exact both ways.
const MAX_CREDITS = 9_007_199_254_740_991; // 2^53 - 1

/** Parse a USD decimal amount string into credits. Throws on malformed input. */
export function amountToCredits(amount: string): number {
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error('amount must be a USD decimal, <= 6 places');
  const [whole, frac = ''] = amount.split('.');
  const micro = frac.padEnd(6, '0');
  const credits = Number(whole) * 1_000_000 + Number(micro);
  if (!Number.isSafeInteger(credits) || credits < 1 || credits > MAX_CREDITS)
    throw new Error('amount out of range');
  return credits;
}

/** Format credits back to a USD decimal string (6 places, trimmed). */
export function creditsToAmount(credits: number): string {
  const whole = Math.floor(credits / 1_000_000);
  const frac = String(credits % 1_000_000).padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
