const esc = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export { esc };

/** Shared shell for dashboard + consent pages, echoing the airmail identity. */
export function page(title: string, body: string): string {
  return `<!doctype html>
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
  body {
    background:var(--paper); color:var(--ink);
    font-family:'Public Sans','Helvetica Neue',system-ui,sans-serif;
    font-size:1rem; line-height:1.6;
  }
  body::before {
    content:''; display:block; height:10px;
    background:repeating-linear-gradient(-45deg,var(--red) 0 14px,var(--paper) 14px 26px,var(--blue) 26px 40px,var(--paper) 40px 52px);
  }
  .wrap { max-width:56rem; margin-inline:auto; padding:1.5rem clamp(1rem,4vw,2rem) 4rem; }
  header.site { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:2rem; flex-wrap:wrap; gap:.5rem; }
  .wordmark { font-family:var(--display); font-weight:700; font-size:1.35rem; color:var(--ink); text-decoration:none; }
  .wordmark small { font-family:var(--mono); font-size:.7rem; color:var(--red); letter-spacing:.12em; margin-left:.5rem; }
  h1 { font-family:var(--display); font-size:1.9rem; line-height:1.15; margin-bottom:.5rem; }
  h2 { font-family:var(--display); font-size:1.25rem; margin:2.25rem 0 .75rem; padding-top:1.25rem; border-top:1px dashed var(--rule); }
  p { margin-block:.5rem; }
  .muted { color:var(--muted); font-size:.92rem; }
  .mono { font-family:var(--mono); }
  .eyebrow { font-family:var(--mono); font-size:.72rem; letter-spacing:.14em; text-transform:uppercase; color:var(--red); }
  table { border-collapse:collapse; width:100%; font-size:.92rem; margin-top:.75rem; display:block; overflow-x:auto; }
  th,td { text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--rule); vertical-align:top; }
  th { font-family:var(--mono); font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  form.inline { display:inline; }
  input[type=text], input[type=url], input[type=number], select {
    font:inherit; padding:.45rem .6rem; border:1.5px solid var(--ink); border-radius:4px; background:var(--card); max-width:100%;
  }
  button, .btn {
    font:inherit; font-weight:600; cursor:pointer; text-decoration:none; display:inline-block;
    padding:.5rem 1rem; border-radius:4px; border:2px solid var(--blue-deep);
    background:var(--blue); color:var(--paper); box-shadow:2px 2px 0 var(--blue-deep);
  }
  button:hover, .btn:hover { translate:1px 1px; box-shadow:1px 1px 0 var(--blue-deep); }
  button.quiet { background:transparent; color:var(--ink); border-color:var(--ink); box-shadow:none; }
  button.danger { background:var(--red); border-color:#9c2b20; box-shadow:2px 2px 0 #9c2b20; }
  .card { background:var(--card); border:1.5px solid var(--ink); border-radius:6px; padding:1.25rem; margin-block:1rem; }
  .stat { font-family:var(--display); font-size:2.4rem; }
  .reveal { background:var(--panel); border:1.5px dashed var(--red); padding:1rem; border-radius:6px; font-family:var(--mono); word-break:break-all; }
  code { font-family:var(--mono); background:var(--panel); padding:.1em .3em; border-radius:3px; font-size:.9em; overflow-wrap:anywhere; }
  .mono { overflow-wrap:anywhere; }
  a { color:var(--blue); }
  .row { display:flex; gap:.75rem; flex-wrap:wrap; align-items:center; }
</style>
</head>
<body>
<div class="wrap">
<header class="site">
  <a class="wordmark" href="/dashboard">tokenpony<small>PROVIDER</small></a>
  <nav class="row muted">
    <a href="https://tokenpony.dev">tokenpony.dev</a>
    <a href="https://tokenpony.dev/spec">spec</a>
  </nav>
</header>
${body}
</div>
</body>
</html>`;
}
