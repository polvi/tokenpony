const esc = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const shell = (title: string, body: string, script = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    --paper:#fbf8f0; --panel:#f3eee1; --card:#fff; --ink:#1d2233; --muted:#5c6072;
    --blue:#26409a; --blue-deep:#1b2f73; --red:#ce3b2c; --rule:#dad3c2;
    --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,monospace;
    --display:'Iowan Old Style',Georgia,serif;
  }
  * { box-sizing:border-box; margin:0; }
  html,body { height:100%; }
  body {
    background:var(--paper); color:var(--ink); display:flex; flex-direction:column;
    font-family:'Public Sans','Helvetica Neue',system-ui,sans-serif; font-size:1rem; line-height:1.55;
  }
  .hatch { flex:none; height:10px; background:repeating-linear-gradient(-45deg,var(--red) 0 14px,var(--paper) 14px 26px,var(--blue) 26px 40px,var(--paper) 40px 52px); }
  header.bar { flex:none; display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; padding:.8rem clamp(1rem,3vw,2rem); border-bottom:1px solid var(--rule); }
  .wordmark { font-family:var(--display); font-weight:700; font-size:1.3rem; text-decoration:none; color:var(--ink); }
  .wordmark small { font-family:var(--mono); font-size:.65rem; color:var(--red); letter-spacing:.12em; margin-left:.4rem; }
  .muted { color:var(--muted); font-size:.85rem; }
  .mono { font-family:var(--mono); }
  main { flex:1; display:flex; flex-direction:column; max-width:52rem; width:100%; margin-inline:auto; padding:1rem clamp(1rem,3vw,2rem); min-height:0; }
  button, .btn {
    font:inherit; font-weight:600; cursor:pointer; text-decoration:none; display:inline-block;
    padding:.55rem 1.1rem; border-radius:4px; border:2px solid var(--blue-deep);
    background:var(--blue); color:var(--paper); box-shadow:2px 2px 0 var(--blue-deep);
  }
  button:hover { translate:1px 1px; box-shadow:1px 1px 0 var(--blue-deep); }
  button.quiet { background:transparent; color:var(--ink); border-color:var(--ink); box-shadow:none; font-weight:500; padding:.35rem .7rem; font-size:.85rem; }
  input, select { font:inherit; padding:.55rem .7rem; border:1.5px solid var(--ink); border-radius:4px; background:var(--card); }
  a { color:var(--blue); }
  ${body.includes('id="log"') ? chatCss : connectCss}
</style>
</head>
<body>
<div class="hatch"></div>
${body}
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;

const connectCss = `
  .connect { margin:auto; max-width:34rem; width:100%; }
  h1 { font-family:var(--display); font-size:clamp(1.9rem,5vw,2.6rem); line-height:1.15; margin-bottom:.75rem; }
  .card { background:var(--card); border:1.5px solid var(--ink); border-radius:6px; padding:1.5rem; margin-top:1.5rem; }
  .field { margin-block:.9rem; display:flex; flex-direction:column; gap:.3rem; }
  label { font-family:var(--mono); font-size:.72rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
  .eyebrow { font-family:var(--mono); font-size:.72rem; letter-spacing:.14em; text-transform:uppercase; color:var(--red); }
`;

const chatCss = `
  #log { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:.9rem; padding-block:1rem; min-height:0; }
  .msg { max-width:85%; padding:.7rem 1rem; border-radius:6px; white-space:pre-wrap; overflow-wrap:break-word; }
  .msg.user { align-self:flex-end; background:var(--blue); color:var(--paper); border:1.5px solid var(--blue-deep); }
  .msg.assistant { align-self:flex-start; background:var(--card); border:1.5px solid var(--rule); }
  .msg.error { align-self:center; background:#fbeae8; border:1.5px dashed var(--red); color:var(--red); font-size:.9rem; }
  form#composer { flex:none; display:flex; gap:.6rem; padding-block:.75rem 1.25rem; }
  #prompt { flex:1; }
  .meter { font-family:var(--mono); font-size:.75rem; color:var(--muted); }
  .meter b { color:var(--red); font-weight:600; }
`;

export function connectPage(defaultIssuer: string, error?: string): string {
  return shell(
    'Pony Chat — bring your own tokens',
    `<header class="bar">
  <span class="wordmark">Pony Chat<small>TPP DEMO</small></span>
  <span class="muted">an LLM app with <strong>zero</strong> API keys</span>
</header>
<main>
  <div class="connect">
    <p class="eyebrow">Token Pony Protocol</p>
    <h1>This app has no API keys. Bring your own tokens.</h1>
    <p class="muted">Pony Chat ships with no LLM credentials and no inference bill. Connect a
    token provider you pay — it asks for a metered budget, you approve it with a passkey,
    and every completion is metered against that grant. Revoke it any time at your provider.</p>
    ${error ? `<p style="color:var(--red)"><strong>${esc(error)}</strong></p>` : ''}
    <form class="card" method="post" action="/connect">
      <div class="field">
        <label for="issuer">Token provider (any TPP issuer)</label>
        <input id="issuer" name="issuer" type="url" value="${esc(defaultIssuer)}" required>
      </div>
      <div class="field">
        <label for="budget">Token budget to request</label>
        <select id="budget" name="budget">
          <option value="50000">50,000 tokens</option>
          <option value="100000" selected>100,000 tokens</option>
          <option value="500000">500,000 tokens</option>
        </select>
      </div>
      <button type="submit">Connect provider →</button>
    </form>
    <p class="muted" style="margin-top:1rem">New here? <a href="https://tokenpony.dev">tokenpony.dev</a> is the reference provider — accounts take one passkey tap and start with 100k free tokens.</p>
  </div>
</main>`,
  );
}

export function chatPage(issuer: string, budget: number): string {
  return shell(
    'Pony Chat',
    `<header class="bar">
  <span class="wordmark">Pony Chat<small>TPP DEMO</small></span>
  <span class="meter">grant <b id="used">0</b> / ${budget.toLocaleString('en-US')} tokens · <span class="mono">${esc(new URL(issuer).host)}</span></span>
  <span>
    <select id="model" class="quiet"></select>
    <form method="post" action="/disconnect" style="display:inline"><button class="quiet">Disconnect</button></form>
  </span>
</header>
<main>
  <div id="log">
    <div class="msg assistant">Saddled up. Your provider grant is loaded — ask me anything.</div>
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
let used = 0;

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
          if (chunk.usage) { used += chunk.usage.total_tokens; usedEl.textContent = used.toLocaleString('en-US'); }
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
