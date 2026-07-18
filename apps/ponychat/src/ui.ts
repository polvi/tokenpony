const esc = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Pony Chat is the demo THIRD-PARTY app, so it deliberately looks nothing
// like tokenpony: dark, rounded, lime-accented indie chat UI instead of the
// provider's ivory airmail identity.
const shell = (title: string, body: string, script = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    --bg:#0e1013; --surface:#171a21; --surface2:#20242e; --border:#2a2f3a;
    --text:#e9eaf0; --dim:#8f95a3; --accent:#b6f36b; --accent-ink:#101505;
    --radius:16px;
    --font:'SF Pro Rounded',ui-rounded,'Nunito','Segoe UI',system-ui,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  * { box-sizing:border-box; margin:0; }
  html,body { height:100%; }
  body {
    height:100dvh;
    background:var(--bg); color:var(--text); display:flex; flex-direction:column;
    font-family:var(--font); font-size:1rem; line-height:1.55;
  }
  header.bar {
    flex:none; display:flex; justify-content:space-between; align-items:center; gap:1rem;
    flex-wrap:wrap; padding:.85rem clamp(1rem,3vw,2rem);
    background:var(--surface); border-bottom:1px solid var(--border);
  }
  .wordmark { font-weight:800; font-size:1.25rem; letter-spacing:-.02em; color:var(--text); text-decoration:none; }
  .wordmark b { color:var(--accent); }
  .tag {
    font-size:.68rem; font-weight:600; letter-spacing:.08em; text-transform:uppercase;
    color:var(--dim); border:1px solid var(--border); border-radius:999px; padding:.15rem .6rem; margin-left:.5rem;
  }
  .muted { color:var(--dim); font-size:.85rem; }
  .mono { font-family:var(--mono); }
  main { flex:1; display:flex; flex-direction:column; max-width:50rem; width:100%; margin-inline:auto; padding:1rem clamp(1rem,3vw,2rem); min-height:0; }
  button, .btn {
    font:inherit; font-weight:700; cursor:pointer; text-decoration:none; display:inline-block;
    padding:.65rem 1.3rem; border-radius:999px; border:none;
    background:var(--accent); color:var(--accent-ink);
  }
  button:hover, .btn:hover { filter:brightness(1.08); }
  button.quiet, .quiet {
    background:var(--surface2); color:var(--text); font-weight:500; font-size:.85rem;
    padding:.4rem .9rem; border:1px solid var(--border);
  }
  input, select {
    font:inherit; padding:.65rem .85rem; border:1px solid var(--border); border-radius:12px;
    background:var(--surface2); color:var(--text); max-width:100%;
  }
  input:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  a { color:var(--accent); }
  .provider-chip {
    display:inline-flex; align-items:center; gap:.4rem; font-size:.75rem; color:var(--dim);
    border:1px solid var(--border); border-radius:999px; padding:.2rem .7rem; text-decoration:none;
  }
  .provider-chip:hover { color:var(--text); }
  ${body.includes('id="log"') ? chatCss : connectCss}
</style>
</head>
<body>
${body}
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;

const connectCss = `
  .connect { margin:auto; max-width:33rem; width:100%; padding-block:2rem; }
  h1 { font-size:clamp(1.8rem,5vw,2.5rem); font-weight:800; letter-spacing:-.02em; line-height:1.15; margin-bottom:.75rem; }
  h1 em { font-style:normal; color:var(--accent); }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:1.5rem; margin-top:1.5rem; }
  .field { margin-block:.9rem; display:flex; flex-direction:column; gap:.35rem; }
  label { font-size:.72rem; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--dim); }
  .err { color:#ff8a7a; font-weight:600; margin-top:.75rem; }
`;

const chatCss = `
  #log { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:.8rem; padding-block:1.1rem; min-height:0; }
  .msg { max-width:85%; padding:.75rem 1.05rem; border-radius:var(--radius); white-space:pre-wrap; overflow-wrap:break-word; }
  .msg.user { align-self:flex-end; background:var(--accent); color:var(--accent-ink); border-bottom-right-radius:6px; font-weight:500; }
  .msg.assistant { align-self:flex-start; background:var(--surface2); border:1px solid var(--border); border-bottom-left-radius:6px; }
  .msg.error { align-self:center; background:#2a1714; border:1px solid #5c2a22; color:#ff9c8d; font-size:.9rem; border-radius:12px; }
  form#composer { flex:none; display:flex; gap:.6rem; padding-block:.8rem 1.3rem; }
  #prompt { flex:1; border-radius:999px; padding-inline:1.1rem; }
  .meter { font-family:var(--mono); font-size:.72rem; color:var(--dim); }
  .meter b { color:var(--accent); font-weight:700; }
  .bar-right { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
`;

export function connectPage(defaultIssuer: string, error?: string): string {
  return shell(
    'Pony Chat: bring your own tokens',
    `<header class="bar">
  <span class="wordmark">pony<b>chat</b><span class="tag">third-party demo</span></span>
  <span class="muted">an LLM app with <strong>zero</strong> API keys</span>
</header>
<main>
  <div class="connect">
    <h1>This app has <em>no API keys</em>. Bring your own tokens.</h1>
    <p class="muted">Pony Chat is a third-party app built on the Token Pony Express protocol.
    It ships with no LLM credentials and no inference bill. Connect a token provider you pay:
    it asks for a metered credit budget, you approve it with a passkey, and every completion
    is metered against that grant. Revoke it any time at your provider.</p>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <form class="card" method="post" action="/connect">
      <div class="field">
        <label for="issuer">Token provider (any TPX issuer)</label>
        <input id="issuer" name="issuer" type="url" value="${esc(defaultIssuer)}" required>
      </div>
      <div class="field">
        <label for="budget">Credit budget to request (1M credits = $1)</label>
        <select id="budget" name="budget">
          <option value="50000">50,000 credits ($0.05)</option>
          <option value="100000" selected>100,000 credits ($0.10)</option>
          <option value="500000">500,000 credits ($0.50)</option>
        </select>
      </div>
      <button type="submit">Connect provider →</button>
    </form>
    <p class="muted" style="margin-top:1rem">New here? <a href="https://tokenpony.dev">tokenpony.dev</a> is the reference provider; accounts take one passkey tap and top-offs start at $1.
    Already connected before? Check your balance at <a href="${esc(defaultIssuer)}/dashboard">your provider's dashboard</a>.</p>
  </div>
</main>`,
  );
}

export function chatPage(issuer: string, budget: number, used = 0): string {
  return shell(
    'Pony Chat',
    `<header class="bar">
  <span class="wordmark">pony<b>chat</b><span class="tag">third-party demo</span></span>
  <span class="meter">grant <b id="used" data-init="${used}">${used.toLocaleString('en-US')}</b> / ${budget.toLocaleString('en-US')} credits</span>
  <span class="bar-right">
    <a class="provider-chip" href="${esc(issuer)}/dashboard" target="_blank" rel="noopener">tokens by ${esc(new URL(issuer).host)} · manage balance ↗</a>
    <select id="model" class="quiet"></select>
    <form method="post" action="/disconnect" style="display:inline"><button class="quiet">Disconnect</button></form>
  </span>
</header>
<main>
  <div id="log">
    <div class="msg assistant">Saddled up. Your provider grant is loaded. Ask me anything.</div>
  </div>
  <form id="composer">
    <input id="prompt" autocomplete="off" placeholder="Write a message…" required>
    <button type="submit">Send</button>
  </form>
</main>`,
    chatJs,
  );
}

const chatJs = `
const log = document.getElementById('log');
const composer = document.getElementById('composer');
const promptEl = document.getElementById('prompt');
const modelSel = document.getElementById('model');
const usedEl = document.getElementById('used');
const history = [];
let used = Number(usedEl.dataset.init) || 0;

fetch('/models').then(r => r.json()).then(body => {
  for (const m of body.data ?? []) {
    const opt = document.createElement('option');
    opt.value = m.id; opt.textContent = m.id;
    modelSel.append(opt);
  }
}).catch(() => {});

function bubble(cls, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.textContent = text;
  log.append(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = promptEl.value.trim();
  if (!text) return;
  promptEl.value = '';
  bubble('user', text);
  history.push({ role: 'user', content: text });
  const out = bubble('assistant', '');
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelSel.value, messages: history }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      out.remove();
      const code = err?.error?.code;
      let msg = err?.error?.message ?? ('Request failed (' + res.status + ')');
      if (code === 'budget_exhausted') msg = 'Grant budget spent. Disconnect and reconnect to approve a new budget.';
      if (code === 'grant_revoked') msg = 'This grant was revoked at your provider. Disconnect to start over.';
      bubble('error', msg);
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '', answer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split('\\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) { answer += String(delta); out.textContent = answer; log.scrollTop = log.scrollHeight; }
          if (chunk.usage) { used += chunk.usage.credits_charged ?? chunk.usage.total_tokens; usedEl.textContent = used.toLocaleString('en-US'); }
        } catch {}
      }
    }
    history.push({ role: 'assistant', content: answer });
  } catch (err) {
    out.remove();
    bubble('error', 'Network error: ' + err.message);
  }
});
`;
