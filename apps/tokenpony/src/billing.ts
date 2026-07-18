import { Hono } from 'hono';
import { jsonError } from './util';
import { requireSession } from './auth';
import type { AppEnv } from './types';

// Credits are micro-USD: the $5 pack is at par, the $20 pack carries a bonus.
export const PACKS: Record<string, { usd: number; credits: number }> = {
  demo: { usd: 1, credits: 1_000_000 },
  saddlebag: { usd: 5, credits: 5_000_000 },
  wagon: { usd: 20, credits: 25_000_000 },
};

export const billing = new Hono<AppEnv>();

billing.post('/checkout', requireSession, async (c) => {
  if (!c.env.STRIPE_SECRET_KEY)
    return jsonError(503, 'billing_unavailable', 'Stripe is not configured yet');
  const user = c.get('user');
  const form = await c.req.parseBody();
  const pack = PACKS[String(form.pack)];
  if (!pack) return jsonError(400, 'invalid_request', 'Unknown pack');

  const params = new URLSearchParams({
    mode: 'payment',
    success_url: `${c.env.ISSUER}/dashboard?paid=1`,
    cancel_url: `${c.env.ISSUER}/dashboard`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(pack.usd * 100),
    'line_items[0][price_data][product_data][name]': `tokenpony: ${pack.credits.toLocaleString('en-US')} credits`,
    'metadata[user_id]': user.id,
    'metadata[credits]': String(pack.credits),
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const session = (await res.json()) as { id?: string; url?: string; error?: { message: string } };
  if (!res.ok || !session.url || !session.id) {
    console.log(JSON.stringify({ event: 'stripe_error', error: session.error?.message }));
    return jsonError(502, 'billing_error', session.error?.message ?? 'Stripe checkout failed');
  }
  await c.env.DB.prepare(
    'INSERT INTO payments (id, stripe_session_id, user_id, credits) VALUES (?, ?, ?, ?)',
  )
    .bind(crypto.randomUUID(), session.id, user.id, pack.credits)
    .run();
  return c.redirect(session.url);
});

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
    data: { object: { id: string; metadata?: { user_id?: string; tokens?: string } } };
  };
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const payment = await c.env.DB.prepare(
      "SELECT id, user_id, credits, status FROM payments WHERE stripe_session_id = ?",
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
    }
  }
  return c.json({ received: true });
});
