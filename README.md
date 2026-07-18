# tokenpony

tokenpony is two things: the home of the **Token Pony Express (TPX)**, an OAuth-style
protocol where LLM apps ship with no API keys and users pay a token provider they choose,
and the **reference provider** that implements it end to end. It is a proof of concept.

OAuth taught apps to ask for identity; TPX teaches them to ask for tokens. An app requests
a metered credit budget, the user approves it with a passkey, and the provider debits
actual usage against that grant. Grants are budget-capped, revocable, and pseudonymous.

## Live

| Host | What |
| --- | --- |
| [tokenpony.dev](https://tokenpony.dev) | Marketing site, [spec](https://tokenpony.dev/spec), [ELI5](https://tokenpony.dev/eli5), [llms.txt](https://tokenpony.dev/llms.txt) |
| [api.tokenpony.dev](https://api.tokenpony.dev/.well-known/oauth-protected-resource) | TPX issuer + OpenAI-compatible metered API + user dashboard |
| [ponychat.tokenpony.dev](https://ponychat.tokenpony.dev) | Demo third-party app with zero LLM credentials |
| authgravity.tokenpony.dev | Passkey accounts + relationship authz (external service) |

Agents integrate from `GET /.well-known/oauth-protected-resource` → its `documentation` field → `llms.txt`.

## Repo layout

```
SPEC.md            TPX v0.2 protocol spec (source of truth; mirrored at /spec)
packages/tpx/      @tokenpony/tpx client SDK (types, discover, authorize, exchange, chat)
apps/www/          Astro marketing site -> tokenpony.dev
apps/tokenpony/    provider Worker (Hono + D1 + Workers AI) -> api.tokenpony.dev
apps/ponychat/     demo TPX client Worker (Hono + KV) -> ponychat.tokenpony.dev
```

## How money works

Balances and budgets are **credits**: 1 credit = US$0.000001, so a model's "$X per M
tokens" rate is exactly X credits per token. Per-model prices are pulled live from the
Workers AI catalog and every completion returns a `usage.credits_charged` extension.
Credits sell at face value; checkout passes Stripe fees through at cost, the first top-off
is charged exactly at cost, and each later top-off nets one US Forever stamp of margin
("postage"). Details in [apps/tokenpony/README.md](apps/tokenpony/README.md).

## Development

```sh
bun install                     # once, at the repo root

cd apps/www && bun run build && bunx wrangler deploy
cd apps/tokenpony && bunx wrangler deploy
cd apps/ponychat && bunx wrangler deploy

cd apps/tokenpony && bunx wrangler d1 migrations apply tokenpony --remote
```

Typecheck a worker with `bunx tsc --noEmit` from its directory; rerun
`bunx wrangler types` after changing any `wrangler.jsonc`. Secrets (Stripe, AuthGravity
service token) are documented in the provider README.
