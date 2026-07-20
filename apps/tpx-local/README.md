# tpx-local

A TPX v0.2 provider shim that fronts a local OpenAI-compatible server (built for
[Jan.ai](https://jan.ai) on `localhost:1337`). Point Pony Chat, or any TPX client, at it
and chat against your own machine. Local inference is free, so every model publishes zero
credit rates and completions report `usage.credits_charged: 0`; the grant budget is a real
cap that never depletes.

This is a Bun server, not a Worker. State (client registrations, grants) persists to
`state.json` next to the package; codes and access tokens are in-memory, and clients
recover from a restart with a standard refresh.

## Run

```sh
cd apps/tpx-local
bun run start            # listens on :1338, proxies http://localhost:1337
```

`PORT` and `UPSTREAM` env vars override the defaults. Jan must have its local API server
enabled (Settings -> Local API Server).

## Use from hosted Pony Chat

The Pony Chat Worker fetches the provider server-side, so `localhost` is unreachable from
it. Expose the shim with a tunnel:

```sh
cloudflared tunnel --url http://localhost:1338
```

Paste the printed `https://*.trycloudflare.com` URL into the connect box at
[ponychat.tokenpony.dev](https://ponychat.tokenpony.dev), approve the grant on the consent
page, and chat. The issuer is derived per-request from `Host` and `x-forwarded-proto`, so
the random tunnel hostname needs no configuration.

## What it implements

The provider surface a TPX client exercises: RFC 9728 + RFC 8414 discovery, RFC 7591
dynamic registration, PAR + PKCE (S256) + the `llm-inference` RAR type (fail-closed
validation), a consent page, authorization codes (single-use, 5 minutes, `iss` on the
redirect), token issuance with rotating refresh tokens and reuse-detection revocation,
RFC 7662 introspection with `budget_used`, RFC 7009 revocation, and `GET /models` plus
streaming `POST /chat/completions` (also under `/v1`) with RFC 6750 challenges. DPoP is
not implemented; clients fall back to Bearer.
