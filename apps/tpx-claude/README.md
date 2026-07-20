# tpx-claude

A TPX v0.2 provider shim backed by your own Claude Code login. Point Pony Chat, or any
TPX client you run for yourself, at it and chat with Claude on your subscription.

**Personal use only.** Each completion spawns headless Claude Code (`claude -p`) on this
machine, so requests draw on your subscription through the CLI's own auth. The shim never
reads, stores, or forwards credentials, and it is built to keep access yours alone:

- Grant approval requires a PIN printed to the shim's terminal. Nobody who merely knows
  the URL can mint a grant.
- Spawned sessions are stripped bare: no tools, no MCP servers, no skills, no settings,
  a replaced system prompt, and an empty working directory. A connected app can only get
  chat completions out of it.
- Do not share grants with other people, and do not publish tunnel URLs. Sharing
  subscription access with third parties is against Anthropic's terms; automating your
  own login for yourself with headless Claude Code is what the CLI's print mode is for.

Subscription usage has no marginal price, so models publish zero credit rates and
completions report `usage.credits_charged: 0` with real token counts.

## Run

```sh
cd apps/tpx-claude
bun run start            # listens on :1339, prints the approval PIN
```

Env vars: `PORT` (default 1339), `PIN` (default random per start), `MODELS`
(default `fable,opus,sonnet,haiku`, comma-separated `--model` values), `CLAUDE_BIN`
(default `claude`). Requires a logged-in Claude Code CLI on this machine.

At boot the shim verifies each candidate model with a tiny completion: the CLI's init
event resolves the alias to a full model id, and models this login cannot use fail fast
at zero cost and are dropped from the catalog. Results are cached for a day in
`models.json`; delete it to re-verify. `/models` therefore lists exactly what your
subscription can serve, and chat requests accept either the full id or the alias.

## Use from hosted Pony Chat

```sh
cloudflared tunnel --url http://localhost:1339
```

Paste the printed `https://*.trycloudflare.com` URL into the connect box at
[ponychat.tokenpony.dev](https://ponychat.tokenpony.dev), enter the PIN from your
terminal on the consent page, and chat. Keep the tunnel URL to yourself.

## Implementation notes

The TPX surface (discovery, registration, PAR + PKCE + RAR, consent, rotating refresh
tokens, introspection, revocation) comes from `@tokenpony/tpx-provider`, shared with
`apps/tpx-local`. This app maps OpenAI-style chat requests onto one `claude -p` run per
request: system messages plus a fixed framing line become `--system-prompt`, prior turns
are rendered into a transcript prompt on stdin, and the CLI's `stream-json` output is
translated back into OpenAI SSE chunks. `--bare` is not used because it drops the
subscription login; the session is stripped flag by flag instead (`--tools ""`,
`--strict-mcp-config`, `--disable-slash-commands`, `--setting-sources ""`).
