import { Hono } from 'hono';
import { esc, page } from './html';
import { whoami } from './auth';
import type { AppEnv } from './types';

// Native AuthGravity screens (per authgravity.tokenpony.dev/llms.txt, path A):
// the UI is two buttons, Create Account and Login, in tokenpony's own look.
// The browser talks straight to AuthGravity with credentials:'include'; the
// session_id cookie is first-party because both hosts share tokenpony.dev.

export const authPages = new Hono<AppEnv>();

/** Only same-origin destinations; anything else falls back to the dashboard. */
function safeReturnTo(reqUrl: string, raw: string | undefined): string {
  if (!raw) return '/dashboard';
  const origin = new URL(reqUrl).origin;
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin) return '/dashboard';
    return u.pathname + u.search;
  } catch {
    return '/dashboard';
  }
}

/** Embed a string into an inline <script> safely. */
const js = (s: string) => JSON.stringify(s).replaceAll('<', '\\u003c');

authPages.get('/login', async (c) => {
  const returnTo = safeReturnTo(c.req.url, c.req.query('return_to'));
  if (await whoami(c)) return c.redirect(returnTo);
  const ep = c.env.AUTHGRAVITY_URL;
  const recoverUrl = `${ep}/recover?return_to=${encodeURIComponent(c.req.url)}`;

  return c.html(
    page(
      'Sign in · tokenpony',
      `<div style="max-width:28rem;margin:2.5rem auto 0">
  <p class="eyebrow">Your account</p>
  <h1>One passkey. No password, no email.</h1>
  <p class="muted">tokenpony accounts are a passkey and a balance, nothing else. The server
  stores a public key and a random id; there is no username to pick and nothing to type.</p>
  <div class="card">
    <div class="row">
      <button id="login">Log in</button>
      <button id="create" class="quiet">Create account</button>
    </div>
    <p id="auth-err" style="color:var(--red);font-weight:600;margin-top:.75rem" hidden></p>
    <p class="muted" style="margin-top:.75rem">Your browser will prompt for a passkey. New here?
    Create account takes one tap and you can top off later.</p>
  </div>
  <p class="muted">Lost your passkey? <a href="${esc(recoverUrl)}">Recover with your account key</a>.</p>
  <p class="muted">Powered by <a href="https://authgravity.org" rel="noopener">AuthGravity</a>: zero-knowledge
  passkey accounts. Passkeys work across all tokenpony.dev sites.</p>
</div>
<script>
const EP = ${js(ep)};
const RETURN_TO = ${js(returnTo)};
const errEl = document.getElementById('auth-err');
const buttons = [document.getElementById('login'), document.getElementById('create')];

const pad = (s) => s + '='.repeat((4 - (s.length % 4)) % 4);
const dec = (s) => Uint8Array.from(atob(pad(s.replace(/-/g, '+').replace(/_/g, '/'))), (ch) => ch.charCodeAt(0));
const enc = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const api = (path, init) => fetch(EP + path, Object.assign({ credentials: 'include' }, init));
const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function explain(err) {
  if (err && err.name === 'NotAllowedError') return 'The passkey prompt was closed. Try again when ready.';
  if (err && err.name === 'InvalidStateError') return 'This device already has a passkey here. Use Log in instead.';
  return 'Passkey ceremony failed: ' + (err && err.message ? err.message : String(err));
}

async function run(fn) {
  errEl.hidden = true;
  buttons.forEach((b) => (b.disabled = true));
  try {
    const result = await fn();
    if (!result || !result.verified) throw new Error('the server did not verify the credential');
    location.href = RETURN_TO;
  } catch (err) {
    errEl.textContent = explain(err);
    errEl.hidden = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function createAccount() {
  const opts = await (await api('/v1/register/options')).json();
  const cred = await navigator.credentials.create({ publicKey: {
    ...opts,
    challenge: dec(opts.challenge),
    user: { ...opts.user, id: dec(opts.user.id) },
    excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: dec(c.id) })),
  } });
  return (await post('/v1/register/verify', {
    id: cred.id,
    rawId: enc(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      attestationObject: enc(cred.response.attestationObject),
      clientDataJSON: enc(cred.response.clientDataJSON),
      transports: cred.response.getTransports ? cred.response.getTransports() : [],
    },
  })).json();
}

async function logIn() {
  const opts = await (await api('/v1/login/options')).json();
  const cred = await navigator.credentials.get({ publicKey: {
    ...opts,
    challenge: dec(opts.challenge),
    allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: dec(c.id) })),
  } });
  return (await post('/v1/login/verify', {
    id: cred.id,
    rawId: enc(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      authenticatorData: enc(cred.response.authenticatorData),
      clientDataJSON: enc(cred.response.clientDataJSON),
      signature: enc(cred.response.signature),
      userHandle: cred.response.userHandle ? enc(cred.response.userHandle) : undefined,
    },
  })).json();
}

document.getElementById('login').addEventListener('click', () => run(logIn));
document.getElementById('create').addEventListener('click', () => run(createAccount));
</script>`,
    ),
  );
});

authPages.get('/logout', (c) => {
  const ep = c.env.AUTHGRAVITY_URL;
  return c.html(
    page(
      'Signed out · tokenpony',
      `<div style="max-width:28rem;margin:2.5rem auto 0">
  <p class="eyebrow">Session</p>
  <h1 id="logout-title">Signing out…</h1>
  <p class="muted" id="logout-note">Ending your AuthGravity session.</p>
  <p style="margin-top:1.25rem"><a class="btn" href="/login">Log back in</a></p>
  <noscript><p class="muted">JavaScript is off; sign out at
  <a href="${esc(ep)}/logout?return_to=${esc(encodeURIComponent(new URL(c.req.url).origin + '/login'))}">AuthGravity's hosted page</a> instead.</p></noscript>
  <p class="muted">Powered by <a href="https://authgravity.org" rel="noopener">AuthGravity</a>.</p>
</div>
<script>
fetch(${js(ep)} + '/v1/logout', { method: 'POST', credentials: 'include' })
  .then(() => {
    document.getElementById('logout-title').textContent = "You're signed out.";
    document.getElementById('logout-note').textContent = 'Your passkey stays on your device; your balance stays in the barn.';
  })
  .catch(() => {
    document.getElementById('logout-title').textContent = 'Sign-out may not have finished.';
    document.getElementById('logout-note').textContent = 'Reload to retry, or clear the session at your AuthGravity dashboard.';
  });
</script>`,
    ),
  );
});
