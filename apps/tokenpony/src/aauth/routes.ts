import { Hono } from 'hono';
import type { AppEnv, Bindings } from '../types';
import { esc, page } from '../html';
import { requireSession } from '../auth';
import { getJwks } from './keys';
import { authenticateAAuth, aauthUnauthorized } from './verify';
import { budgetState, getMission } from './missions';

/** RFC 9728-style resource metadata, extended for TPX-A (seam contract section 8). */
export async function aauthResourceMetadata(env: Bindings) {
  return {
    resource: env.ISSUER,
    jwks: await getJwks(env),
    jwks_uri: `${env.ISSUER}/.well-known/aauth-resource.json`,
    budget_endpoint: `${env.ISSUER}/grant`,
    token_endpoint: `${env.ISSUER}/token`,
    signature_algorithms_supported: ['ed25519'],
  };
}

export const aauth = new Hono<AppEnv>();

// -- budget_endpoint (seam contract section 6) -------------------------------
aauth.get('/grant', async (c) => {
  const auth = await authenticateAAuth(c);
  if (auth.kind === 'none') return aauthUnauthorized(c, 'auth_token_required', 'present an AAuth auth token');
  if (auth.kind === 'error') return aauthUnauthorized(c, auth.code, auth.message);
  return c.json(budgetState(auth.mission), 200, { 'cache-control': 'no-store' });
});

// -- Funding claim (seam contract section 5) ---------------------------------
aauth.use('/fund', requireSession);
aauth.use('/fund/*', requireSession);

aauth.get('/fund', async (c) => {
  const approver = c.req.query('approver') ?? '';
  const s256 = c.req.query('s256') ?? '';
  const mission = await getMission(c.env.DB, { approver, s256 });
  if (!mission)
    return c.html(page('Fund a mission · tokenpony', '<h1>Mission not found.</h1><p>This funding link is invalid or expired.</p>'), 404);

  const amountUsd = (mission.budget_total / 1_000_000).toFixed(2);
  const claimed = mission.user_id !== null;
  const state = mission.status;
  return c.html(
    page(
      'Fund a mission · tokenpony',
      `<p class="eyebrow">Agent funding request</p>
<h1>Back an agent's budget</h1>
<div class="card">
  <p>An agent holds an approved mission for up to
     <strong>${mission.budget_total.toLocaleString('en-US')} credits</strong> (about $${amountUsd}).
     Funding it draws that spend from <em>your</em> tokenpony balance as the agent works.</p>
  <p class="muted mono">approver: ${esc(mission.approver)}<br>mission: ${esc(mission.s256)}</p>
  ${
    claimed
      ? '<p><strong>Already funded.</strong> This mission is linked to an account.</p>'
      : state !== 'active'
        ? `<p><strong>Mission is ${esc(state)}.</strong> Nothing to fund.</p>`
        : `<form method="post" action="/fund/claim">
             <input type="hidden" name="approver" value="${esc(mission.approver)}">
             <input type="hidden" name="s256" value="${esc(mission.s256)}">
             <button type="submit">Fund from my balance</button>
           </form>`
  }
</div>
<p class="muted">Your balance: ${c.get('user').balance_credits.toLocaleString('en-US')} credits.
   You can stop backing this mission any time by revoking it from your dashboard.</p>`,
    ),
  );
});

aauth.post('/fund/claim', async (c) => {
  const user = c.get('user');
  const form = await c.req.parseBody();
  const approver = String(form.approver ?? '');
  const s256 = String(form.s256 ?? '');
  // CAS: first claim wins, only while active and unclaimed.
  const res = await c.env.DB.prepare(
    "UPDATE aauth_missions SET user_id = ? WHERE approver = ? AND s256 = ? AND user_id IS NULL AND status = 'active'",
  )
    .bind(user.id, approver, s256)
    .run();
  if (res.meta.changes === 0)
    return c.html(page('Fund a mission · tokenpony', '<h1>Could not fund.</h1><p>The mission is already funded, revoked, or not found. <a href="/dashboard">Back to dashboard</a>.</p>'), 409);
  return c.html(
    page(
      'Mission funded · tokenpony',
      `<p class="eyebrow">Funded</p><h1>You are backing this mission.</h1>
<p>Spend now draws from your balance up to the approved cap. Manage or revoke it from your
<a href="/dashboard">dashboard</a>.</p>`,
    ),
  );
});
