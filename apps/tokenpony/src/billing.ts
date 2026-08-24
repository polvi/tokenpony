import { Hono } from 'hono';
import { jsonError } from './util';
import { requireSession } from './auth';
import type { AppEnv, Bindings } from './types';

/**
 * Deployment metering mode. `METERING=off` (self-hosted, internal use) keeps
 * the usage ledger and budget caps but never gates on balance, debits it, or
 * talks to Stripe, and the /billing routes disappear. Anything else meters.
 */
export const isMetered = (env: { METERING?: string }) => env.METERING !== 'off';

// Credits sell at face value: $1 buys 1,000,000 credits' worth of inference.
export const PACKS: Record<string, { usd: number; credits: number }> = {
  demo: { usd: 1, credits: 1_000_000 },
  saddlebag: { usd: 5, credits: 5_000_000 },
  wagon: { usd: 20, credits: 20_000_000 },
};

// Stripe's standard US card pricing. We pass it through at cost on every
// purchase so a top-off can never lose money.
const STRIPE_PCT = 0.029;
const STRIPE_FIXED_CENTS = 30;

/** Charge such that, after Stripe's cut, we net exactly `netCents`. */
export function grossForNet(netCents: number): number {
  return Math.ceil((netCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_PCT));
}

/**
 * The business model: the first top-off is at cost (card fees only); every
 * later top-off nets us one US Forever stamp of margin, "postage".
 */
export function checkoutAmountCents(
  packUsd: number,
  firstPurchase: boolean,
  postage: number,
): number {
  const faceCents = packUsd * 100;
  return grossForNet(faceCents + (firstPurchase ? 0 : postage));
}

export function postageCents(env: { POSTAGE_CENTS?: string }): number {
  return Number(env.POSTAGE_CENTS ?? 82);
}

export async function hasPaidBefore(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND status = 'paid'")
    .bind(userId)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

async function stripe(
  env: Bindings,
  path: string,
  params?: URLSearchParams,
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: params ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(params && { 'content-type': 'application/x-www-form-urlencoded' }),
    },
    body: params,
  });
  return { ok: res.ok, body: (await res.json()) as Record<string, unknown> };
}

/** Get or lazily create the user's Stripe Customer (needed to save a card). */
async function ensureCustomer(env: Bindings, userId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT stripe_customer_id FROM users WHERE id = ?')
    .bind(userId)
    .first<{ stripe_customer_id: string | null }>();
  if (row?.stripe_customer_id) return row.stripe_customer_id;
  const { ok, body } = await stripe(env, 'customers', new URLSearchParams({ 'metadata[user_id]': userId }));
  if (!ok || typeof body.id !== 'string') {
    console.log(JSON.stringify({ event: 'stripe_customer_error', error: (body.error as { message?: string })?.message }));
    return null;
  }
  await env.DB.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?')
    .bind(body.id, userId)
    .run();
  return body.id;
}

export const billing = new Hono<AppEnv>();

billing.use('*', async (c, next) => {
  if (!isMetered(c.env))
    return jsonError(404, 'not_found', 'Billing is disabled on this deployment');
  await next();
});

billing.post('/checkout', requireSession, async (c) => {
  if (!c.env.STRIPE_SECRET_KEY)
    return jsonError(503, 'billing_unavailable', 'Stripe is not configured yet');
  const user = c.get('user');
  const form = await c.req.parseBody();
  const pack = PACKS[String(form.pack)];
  if (!pack) return jsonError(400, 'invalid_request', 'Unknown pack');

  const first = !(await hasPaidBefore(c.env.DB, user.id));
  const amount = checkoutAmountCents(pack.usd, first, postageCents(c.env));
  const label = first ? 'first top-off, at cost' : 'includes postage';
  const customer = await ensureCustomer(c.env, user.id);

  const params = new URLSearchParams({
    mode: 'payment',
    success_url: `${c.env.ISSUER}/dashboard?paid=1`,
    cancel_url: `${c.env.ISSUER}/dashboard`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': `tokenpony top-off: $${pack.usd} of inference (${label})`,
    'metadata[user_id]': user.id,
    'metadata[credits]': String(pack.credits),
    // Save the card for later off-session charges (auto top-off).
    'payment_intent_data[setup_future_usage]': 'off_session',
  });
  if (customer) params.set('customer', customer);

  const { ok, body: session } = await stripe(c.env, 'checkout/sessions', params);
  if (!ok || typeof session.url !== 'string' || typeof session.id !== 'string') {
    console.log(JSON.stringify({ event: 'stripe_error', error: (session.error as { message?: string })?.message }));
    return jsonError(502, 'billing_error', (session.error as { message?: string })?.message ?? 'Stripe checkout failed');
  }
  await c.env.DB.prepare(
    'INSERT INTO payments (id, stripe_session_id, user_id, credits) VALUES (?, ?, ?, ?)',
  )
    .bind(crypto.randomUUID(), session.id, user.id, pack.credits)
    .run();
  return c.redirect(session.url);
});

/** Remember the card a completed checkout saved, for auto top-off charges. */
async function rememberCard(env: Bindings, userId: string, paymentIntentId: string): Promise<void> {
  const { ok, body: pi } = await stripe(env, `payment_intents/${paymentIntentId}`);
  if (!ok || typeof pi.payment_method !== 'string') return;
  const { body: pm } = await stripe(env, `payment_methods/${pi.payment_method}`);
  const last4 = (pm.card as { last4?: string } | undefined)?.last4 ?? null;
  await env.DB.prepare(
    'UPDATE users SET stripe_payment_method_id = ?, card_last4 = ? WHERE id = ?',
  )
    .bind(pi.payment_method, last4, userId)
    .run();
}

/**
 * Auto top-off: if the user opted in, their balance is under the threshold,
 * and a card is on file, charge one pack off-session and credit it.
 * Called via waitUntil after debits; a 10-minute in-flight guard prevents
 * duplicate charges from concurrent requests.
 */
export async function maybeAutoTopup(env: Bindings, userId: string): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) return;
  const u = await env.DB.prepare(
    `SELECT balance_credits, stripe_customer_id, stripe_payment_method_id,
            autotopup_threshold, autotopup_credits
     FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{
      balance_credits: number;
      stripe_customer_id: string | null;
      stripe_payment_method_id: string | null;
      autotopup_threshold: number | null;
      autotopup_credits: number | null;
    }>();
  if (
    !u ||
    !u.autotopup_threshold ||
    !u.autotopup_credits ||
    !u.stripe_customer_id ||
    !u.stripe_payment_method_id ||
    u.balance_credits >= u.autotopup_threshold
  )
    return;

  const guard = await env.DB.prepare(
    `UPDATE users SET autotopup_at = datetime('now')
     WHERE id = ? AND (autotopup_at IS NULL OR autotopup_at < datetime('now', '-10 minutes'))`,
  )
    .bind(userId)
    .run();
  if (guard.meta.changes === 0) return;

  const faceCents = Math.round(u.autotopup_credits / 10_000);
  const amount = grossForNet(faceCents + postageCents(env));
  const { ok, body: pi } = await stripe(
    env,
    'payment_intents',
    new URLSearchParams({
      amount: String(amount),
      currency: 'usd',
      customer: u.stripe_customer_id,
      payment_method: u.stripe_payment_method_id,
      off_session: 'true',
      confirm: 'true',
      description: `tokenpony auto top-off: $${(u.autotopup_credits / 1_000_000).toFixed(2)} of inference (includes postage)`,
      'metadata[user_id]': userId,
      'metadata[credits]': String(u.autotopup_credits),
      'metadata[autotopup]': '1',
    }),
  );

  if (ok && pi.status === 'succeeded' && typeof pi.id === 'string') {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO payments (id, stripe_session_id, user_id, credits, status) VALUES (?, ?, ?, ?, 'paid')",
      ).bind(crypto.randomUUID(), pi.id, userId, u.autotopup_credits),
      env.DB.prepare(
        'UPDATE users SET balance_credits = balance_credits + ?, autotopup_at = NULL WHERE id = ?',
      ).bind(u.autotopup_credits, userId),
    ]);
    console.log(
      JSON.stringify({ event: 'autotopup_charged', user: userId, credits: u.autotopup_credits, cents: amount }),
    );
  } else {
    // Failed off-session charge (declined, expired, needs 3DS): disable
    // auto top-off so we never retry-hammer a bad card. The user re-enables
    // from the dashboard after a fresh manual top-off.
    const error = (pi.error as { code?: string; message?: string } | undefined) ?? { code: String(pi.status) };
    await env.DB.prepare(
      'UPDATE users SET autotopup_at = NULL, autotopup_threshold = NULL WHERE id = ?',
    )
      .bind(userId)
      .run();
    console.log(JSON.stringify({ event: 'autotopup_failed_disabled', user: userId, error: error.code ?? error.message }));
  }
}

async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => kv.split('=', 2) as [string, string]),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  // Reject events older than 5 minutes to limit replay.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const enc = new TextEncoder();
  const a = enc.encode(expected);
  const b = enc.encode(v1);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

billing.post('/webhook', async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET)
    return jsonError(503, 'billing_unavailable', 'Stripe is not configured yet');
  const payload = await c.req.text();
  const sig = c.req.header('stripe-signature') ?? '';
  if (!(await verifyStripeSignature(payload, sig, c.env.STRIPE_WEBHOOK_SECRET)))
    return jsonError(400, 'invalid_signature', 'Bad stripe-signature');

  const event = JSON.parse(payload) as {
    type: string;
    data: { object: { id: string; payment_intent?: string; customer?: string } };
  };
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const payment = await c.env.DB.prepare(
      'SELECT id, user_id, credits, status FROM payments WHERE stripe_session_id = ?',
    )
      .bind(session.id)
      .first<{ id: string; user_id: string; credits: number; status: string }>();
    if (payment && payment.status !== 'paid') {
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE payments SET status = 'paid' WHERE id = ?").bind(payment.id),
        c.env.DB.prepare('UPDATE users SET balance_credits = balance_credits + ? WHERE id = ?').bind(
          payment.credits,
          payment.user_id,
        ),
      ]);
      console.log(
        JSON.stringify({ event: 'payment_credited', user: payment.user_id, credits: payment.credits }),
      );
      if (session.payment_intent) {
        c.executionCtx.waitUntil(rememberCard(c.env, payment.user_id, session.payment_intent));
      }
    }
  }
  return c.json({ received: true });
});
