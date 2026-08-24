import { Hono } from 'hono';
import { esc, page } from './html';
import { randomToken, sha256Hex } from './util';
import { applicationTuples, checkPermission, writeTuples } from './authz';
import { revokeGrant } from './oauth';
import { requireSession } from './auth';
import { PACKS, checkoutAmountCents, hasPaidBefore, isMetered, postageCents } from './billing';
import { usd } from './pricing';
import type { AppEnv } from './types';

const fmt = (n: number) => n.toLocaleString('en-US');

export const dashboard = new Hono<AppEnv>();

dashboard.use('*', requireSession);

dashboard.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  const [keys, grants, usage, apps] = await Promise.all([
    db
      .prepare('SELECT id, label, revoked, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC')
      .bind(user.id)
      .all<{ id: string; label: string; revoked: number; created_at: string }>(),
    db
      .prepare(
        `SELECT g.id, g.budget_total, g.budget_used, g.status, g.created_at, a.name AS app_name
         FROM grants g JOIN apps a ON a.client_id = g.client_id
         WHERE g.user_id = ? ORDER BY g.created_at DESC`,
      )
      .bind(user.id)
      .all<{ id: string; budget_total: number; budget_used: number; status: string; created_at: string; app_name: string }>(),
    db
      .prepare(
        'SELECT model, prompt_tokens, cached_tokens, completion_tokens, credits, created_at FROM usage_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 15',
      )
      .bind(user.id)
      .all<{ model: string; prompt_tokens: number; cached_tokens: number; completion_tokens: number; credits: number; created_at: string }>(),
    db
      .prepare('SELECT client_id, name, redirect_uris, created_at FROM apps WHERE owner_user_id = ? ORDER BY created_at DESC')
      .bind(user.id)
      .all<{ client_id: string; name: string; redirect_uris: string; created_at: string }>(),
  ]);

  const metered = isMetered(c.env);
  const stripeReady = metered && Boolean(c.env.STRIPE_SECRET_KEY);
  const paid = c.req.query('paid');

  const first = metered && !(await hasPaidBefore(c.env.DB, user.id));
  const auto = metered
    ? await c.env.DB.prepare(
        'SELECT card_last4, stripe_payment_method_id, autotopup_threshold, autotopup_credits FROM users WHERE id = ?',
      )
        .bind(user.id)
        .first<{ card_last4: string | null; stripe_payment_method_id: string | null; autotopup_threshold: number | null; autotopup_credits: number | null }>()
    : null;
  const stampUsd = (postageCents(c.env) / 100).toFixed(2);
  const feeNote = first
    ? `Your first top-off is at cost: you pay only the card fees. After that, each top-off adds postage, the price of one US Forever stamp (currently $${stampUsd}).`
    : `Each top-off passes card fees through at cost and adds postage: one US Forever stamp, currently $${stampUsd}.`;
  const billing = stripeReady
    ? `<div class="row">${Object.entries(PACKS)
        .map(([id, p]) => {
          const total = (checkoutAmountCents(p.usd, first, postageCents(c.env)) / 100).toFixed(2);
          return `<form method="post" action="/billing/checkout" class="inline">
               <input type="hidden" name="pack" value="${id}">
               <button type="submit">Top off $${p.usd} · pay $${total}</button>
             </form>`;
        })
        .join('')}</div>
<p class="muted">${feeNote}</p>`
    : `<p class="muted">Top-offs aren't configured yet (Stripe keys pending).</p>`;

  const keyRows =
    keys.results.map(
      (k) => `<tr>
        <td>${esc(k.label)}</td>
        <td class="mono">${k.id.slice(0, 8)}…</td>
        <td>${k.revoked ? 'revoked' : 'active'}</td>
        <td>${k.revoked ? '' : `<form method="post" action="/dashboard/keys/${k.id}/revoke" class="inline"><button class="danger">Revoke</button></form>`}</td>
      </tr>`,
    ).join('') || '<tr><td colspan="4" class="muted">No API keys yet.</td></tr>';

  const grantRows =
    grants.results.map(
      (g) => `<tr>
        <td>${esc(g.app_name)}</td>
        <td>${usd(g.budget_used)} of ${usd(g.budget_total)}</td>
        <td>${g.status}</td>
        <td>${g.status === 'active' ? `<form method="post" action="/dashboard/grants/${g.id}/revoke" class="inline"><button class="danger">Revoke</button></form>` : ''}</td>
      </tr>`,
    ).join('') || '<tr><td colspan="4" class="muted">No connected apps. Try <a href="https://ponychat.tokenpony.dev">Pony Chat</a>.</td></tr>';

  const usageRows =
    usage.results.map(
      (u) => `<tr><td class="mono">${esc(u.model)}</td><td>${fmt(u.prompt_tokens)}${u.cached_tokens ? ` <span class="muted">(${fmt(u.cached_tokens)} cached)</span>` : ''}</td><td>${fmt(u.completion_tokens)}</td><td>${usd(u.credits)}</td><td class="muted">${u.created_at}Z</td></tr>`,
    ).join('') || '<tr><td colspan="5" class="muted">No usage yet.</td></tr>';

  const appRows =
    apps.results.map(
      (a) => `<tr><td>${esc(a.name)}</td><td class="mono">${esc(a.client_id)}</td><td class="mono">${esc((JSON.parse(a.redirect_uris) as string[]).join(', '))}</td></tr>`,
    ).join('') || '<tr><td colspan="3" class="muted">No registered apps.</td></tr>';

  const accountSection = metered
    ? `<h1>Balance: <span class="stat">${usd(user.balance_credits)}</span></h1>
<p class="muted">Models are metered in USD at live per-token rates; see <a href="/v1/models">/v1/models</a> for pricing.</p>
<p class="muted mono">${esc(user.id)}</p>
${billing}

<h2>Auto top-off</h2>
${
  auto?.stripe_payment_method_id
    ? `<p class="muted">Card on file: ····${esc(auto.card_last4 ?? '????')}. ${
        auto.autotopup_threshold && auto.autotopup_credits
          ? `<strong>On:</strong> when your balance drops below ${usd(auto.autotopup_threshold)}, we charge $${((checkoutAmountCents(auto.autotopup_credits / 1_000_000, false, postageCents(c.env))) / 100).toFixed(2)} to add ${usd(auto.autotopup_credits)} (includes postage).`
          : '<strong>Off.</strong> Enable it to refill automatically; auto top-offs are priced like any later top-off (face value + postage + card fees).'
      }</p>
<form method="post" action="/dashboard/autotopup" class="row">
  <label class="muted">Below
    <select name="threshold">
      <option value="50000">$0.05</option>
      <option value="100000" selected>$0.10</option>
      <option value="500000">$0.50</option>
    </select>
  </label>
  <label class="muted">add
    <select name="pack">
      ${Object.entries(PACKS).map(([id, p]) => `<option value="${id}">$${p.usd}</option>`).join('')}
    </select>
  </label>
  <button type="submit" name="action" value="enable">${auto.autotopup_threshold ? 'Update' : 'Enable'}</button>
  ${auto.autotopup_threshold ? '<button type="submit" name="action" value="disable" class="quiet">Disable</button>' : ''}
</form>`
    : '<p class="muted">Complete a top-off first. Your card is saved securely with Stripe at checkout, and you can then have the barn refill itself.</p>'
}`
    : `<h1>Unmetered</h1>
<p class="muted">This deployment records usage and never charges; see <a href="/v1/models">/v1/models</a> for the catalog.</p>
<p class="muted mono">${esc(user.id)}</p>`;

  return c.html(
    page(
      'Dashboard · tokenpony',
      `${paid ? '<div class="card" style="border-color:var(--blue)"><strong>Payment received.</strong> Your balance updates when Stripe confirms; refresh in a moment.</div>' : ''}
<p class="eyebrow">Your account</p>
${accountSection}

<h2>Connected apps (TPX grants)</h2>
<table><tr><th>App</th><th>Budget used</th><th>Status</th><th></th></tr>${grantRows}</table>

<h2>Personal API keys</h2>
<p class="muted">Use directly against <code>${esc(c.env.ISSUER)}/v1</code> with any OpenAI SDK.</p>
<table><tr><th>Label</th><th>Id</th><th>Status</th><th></th></tr>${keyRows}</table>
<form method="post" action="/dashboard/keys" class="row" style="margin-top:.75rem">
  <input type="text" name="label" placeholder="key label" required maxlength="64">
  <button type="submit">Create key</button>
</form>

<h2>Recent usage</h2>
<table><tr><th>Model</th><th>Prompt tokens</th><th>Completion tokens</th><th>Cost</th><th>When (UTC)</th></tr>${usageRows}</table>

<h2>Developer: your registered apps</h2>
<table><tr><th>Name</th><th>client_id</th><th>redirect_uris</th></tr>${appRows}</table>
<form method="post" action="/dashboard/apps" class="row" style="margin-top:.75rem">
  <input type="text" name="name" placeholder="app name" required maxlength="64">
  <input type="url" name="redirect_uri" placeholder="https://yourapp.example/callback" required>
  <button type="submit">Register app</button>
</form>
<p class="muted">Registration is also open via <code>POST /register</code> (RFC 7591); see the <a href="https://tokenpony.dev/spec">spec</a>.</p>

<h2>Session</h2>
<form method="get" action="/logout"><button class="quiet">Log out</button></form>`,
    ),
  );
});

dashboard.post('/autotopup', async (c) => {
  if (!isMetered(c.env)) return c.redirect('/dashboard');
  const user = c.get('user');
  const form = await c.req.parseBody();
  if (form.action === 'disable') {
    await c.env.DB.prepare(
      'UPDATE users SET autotopup_threshold = NULL, autotopup_credits = NULL WHERE id = ?',
    )
      .bind(user.id)
      .run();
    return c.redirect('/dashboard');
  }
  const threshold = Number(form.threshold);
  const pack = PACKS[String(form.pack)];
  const hasCard = await c.env.DB.prepare(
    'SELECT stripe_payment_method_id FROM users WHERE id = ?',
  )
    .bind(user.id)
    .first<{ stripe_payment_method_id: string | null }>();
  if (!pack || !Number.isInteger(threshold) || threshold < 1 || threshold > 1_000_000 || !hasCard?.stripe_payment_method_id) {
    return c.redirect('/dashboard');
  }
  await c.env.DB.prepare(
    'UPDATE users SET autotopup_threshold = ?, autotopup_credits = ? WHERE id = ?',
  )
    .bind(threshold, pack.credits, user.id)
    .run();
  return c.redirect('/dashboard');
});

dashboard.post('/keys', async (c) => {
  const user = c.get('user');
  const form = await c.req.parseBody();
  const label = String(form.label ?? 'unnamed').slice(0, 64);
  const key = randomToken('sk_');
  await c.env.DB.prepare('INSERT INTO api_keys (id, user_id, key_hash, label) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), user.id, await sha256Hex(key), label)
    .run();
  return c.html(
    page(
      'API key created · tokenpony',
      `<p class="eyebrow">API key created</p>
<h1>Copy it now; it won't be shown again.</h1>
<div class="reveal">${esc(key)}</div>
<p style="margin-top:1rem"><code>curl ${esc(c.env.ISSUER)}/v1/chat/completions -H "Authorization: Bearer ${esc(key)}" …</code></p>
<p><a class="btn" href="/dashboard">Back to dashboard</a></p>`,
    ),
  );
});

dashboard.post('/keys/:id/revoke', async (c) => {
  await c.env.DB.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), c.get('user').id)
    .run();
  return c.redirect('/dashboard');
});

dashboard.post('/grants/:id/revoke', async (c) => {
  const grantId = c.req.param('id');
  // Ask AuthGravity's relationship graph first; fall back to the local
  // ownership guard in the UPDATE when authz can't answer.
  const allowed = await checkPermission(c, `grant:${grantId}`, 'revoke');
  if (allowed === false) {
    return c.html(page('Not allowed · tokenpony', '<h1>You cannot revoke this grant.</h1><p><a href="/dashboard">Back</a></p>'), 403);
  }
  const owned = await c.env.DB.prepare('SELECT id FROM grants WHERE id = ? AND user_id = ?')
    .bind(grantId, c.get('user').id)
    .first();
  if (owned) await revokeGrant(c.env.DB, grantId);
  return c.redirect('/dashboard');
});

dashboard.post('/apps', async (c) => {
  const user = c.get('user');
  const form = await c.req.parseBody();
  const name = String(form.name ?? '').trim();
  const redirectUri = String(form.redirect_uri ?? '').trim();
  try {
    const u = new URL(redirectUri);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw new Error('not https');
  } catch {
    return c.html(page('Invalid redirect URI · tokenpony', '<h1>redirect_uri must be a valid https URL.</h1><p><a href="/dashboard">Back</a></p>'), 400);
  }
  if (!name) return c.redirect('/dashboard');

  const clientId = randomToken('app_');
  const clientSecret = randomToken('cs_');
  await c.env.DB.prepare(
    "INSERT INTO apps (client_id, client_secret_hash, name, redirect_uris, owner_user_id, token_endpoint_auth_method) VALUES (?, ?, ?, ?, ?, 'client_secret_basic')",
  )
    .bind(clientId, await sha256Hex(clientSecret), name, JSON.stringify([redirectUri]), user.id)
    .run();
  c.executionCtx.waitUntil(writeTuples(c.env, applicationTuples(clientId, user.id)));
  return c.html(
    page(
      'App registered · tokenpony',
      `<p class="eyebrow">App registered</p>
<h1>${esc(name)}</h1>
<p>Copy the client secret now; it won't be shown again.</p>
<p class="mono">client_id</p><div class="reveal">${esc(clientId)}</div>
<p class="mono" style="margin-top:1rem">client_secret</p><div class="reveal">${esc(clientSecret)}</div>
<p style="margin-top:1rem"><a class="btn" href="/dashboard">Back to dashboard</a></p>`,
    ),
  );
});
