# tokenpony-api

The tokenpony provider Worker at **api.tokenpony.dev**: TPX v0.3 issuer (discovery, client
registration, consent, token exchange), OpenAI-compatible metered inference over Workers AI,
user dashboard, and Stripe billing. See the repo root `SPEC.md` for the protocol.

## Bindings

Configured in `wrangler.jsonc`: `AI` (Workers AI), `DB` (D1 `tokenpony`), plus vars
`ISSUER`, `AUTHGRAVITY_URL`, `WWW_URL`.

## Secrets

Set with `wrangler secret put <NAME>` from this directory. All are optional; the worker
degrades gracefully when they're missing.

| Secret | Purpose | Without it |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Creates Checkout Sessions for token packs. Standard test key works; a restricted key needs Checkout Sessions/Products/Prices: Write (inline `price_data`). | Dashboard shows "top-offs not configured"; `/billing/checkout` returns 503 |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_…`) of the Stripe webhook destination pointed at `https://api.tokenpony.dev/billing/webhook`, subscribed to the single event `checkout.session.completed` (snapshot payload, "your account" events, no Connect, no Subscriptions/Accounts v2 categories). | Webhook returns 503; paid sessions are never credited |
| `AUTHGRAVITY_SERVICE_TOKEN` | `agk_…` service token from the AuthGravity console; lets the worker write account/application/grant relationship tuples on signup, app registration, and grant issuance. | Tuple writes are skipped; permission checks fall back to local D1 ownership guards |

Both Stripe secrets were set on 2026-07-17 (test mode).

## Billing flow

`POST /billing/checkout` (session-gated form) creates a one-time-payment Checkout Session
with inline `price_data` (packs defined in `src/billing.ts`) and inserts a pending row in
`payments`. Stripe redirects back to `/dashboard?paid=1`. The webhook verifies the
`stripe-signature` HMAC (5-minute replay window, constant-time compare) and, on
`checkout.session.completed`, marks the payment paid and credits `users.balance_tokens`,
idempotent per session id.

## Database

D1 `tokenpony`; migrations in `migrations/`. Apply with:

```
bunx wrangler d1 migrations apply tokenpony --remote
```

## Deploy

```
bun install          # repo root
bunx wrangler deploy # from this directory
```

## Metering

Money on the wire is USD (TPX v0.3): budgets and `usage.cost` are USD numbers, and
`/models` publishes OpenRouter-shaped USD-per-token pricing strings. The D1 ledger stays
integer micro-USD (1 credit = US$0.000001), converted at the API edge. Each
completion is priced from actual usage (fresh input, cached input, and output tokens) at
per-model rates pulled live from the Workers AI catalog via `env.AI.models()` (cached 6h per
isolate, `src/pricing.ts`), with static fallbacks for models the catalog doesn't report.
`usage.cost` is returned on every completion; the debit is recorded in `usage_events`.

Setting the `METERING` var to `off` (the procdev environment does) turns the deployment
unmetered: usage is still priced and recorded in `usage_events`, and grant/mission budgets
still accrue and cap spend, but balances are never gated or debited, Stripe is never
called, and the `/billing` routes answer 404. Intended for internal deployments; leave
unset on Cloudflare.

`moonshotai/kimi-k3` ($3.00/M input, $0.30/M cached input, $15.00/M output) is plumbed
(partner models route through the AI Gateway named by the `AI_GATEWAY_ID` var, currently
`tokenpony`) and statically priced, but is not in the served catalog: it bills through AI
Gateway Unified Billing, which needs prepaid credits on the account. Re-add it to
`src/models.ts` after purchasing credits. The Kimi lineup is currently served by
`@cf/moonshotai/kimi-k2.7-code` under normal Workers AI billing.

## Business model (postage)

Credits sell at face value. Every checkout passes Stripe's standard card fees
(2.9% + 30 cents) through at cost via `grossForNet()` in `src/billing.ts`, so no
purchase can net less than the credits' face value. A user's **first** top-off is
charged exactly at cost; every later top-off nets one US Forever stamp of margin
("postage", the `POSTAGE_CENTS` var, $0.82 since 2026-07-12). Update the var when
USPS changes the rate. Caveat: international cards cost Stripe more (+1.5%); the
pass-through uses domestic rates, so foreign-card top-offs can dip slightly below
cost.

## Housekeeping

A cron trigger (`17 * * * *`, `src/sweeper.ts`) sweeps expired ephemeral OAuth rows:
PAR requests and access tokens past their stored expiry, auth codes older than an hour
(or spent and expired), and rotated/revoked refresh tokens older than seven days (kept
that long so reuse stays detectable). Live grants are never touched.

## Self-hosted on proc-dev (`--env procdev`)

The `procdev` environment deploys this worker to the proc-0 Workers platform
(`CLOUDFLARE_API_BASE_URL=https://mf.tailb55c1.ts.net/client/v4`, see
proc-infra `clusters/proc-dev/miniflare/`), where `env.AI` is backed by the
self-hosted `qwen3.8-27b` (catalog id `@proc/qwen3.8-27b`) and the extra
`TAILNET` service binding makes anyone on the tailnet a signed-in user
(`ts:<login>`, `src/auth.ts` `whoami`). That binding exists only in the
`procdev` environment: on Cloudflare `env.TAILNET` is undefined and sign-in
stays AuthGravity passkeys. The platform's ingress proxy is what makes the
identity headers trustworthy (it strips them from anything that did not come
through a tailscale proxy pod), so no verification lives in this code.

The environment also sets `MODEL_FILTER=@proc/` (serve only the platform's
models; unset, the catalog is the Workers AI list and `@proc/` entries are
excluded) and `METERING=off` (internal use: usage is recorded, nothing is
charged, no Stripe).

    bunx wrangler deploy --env procdev
    bunx wrangler d1 migrations apply tokenpony --remote --env procdev

`apps/ponychat` has the same `procdev` environment (KV + tailnet vars) and
completes the whole TPX grant flow against this API inside the platform:
`bunx wrangler deploy --env procdev` in `apps/ponychat`, then open
https://ponychat.tailb55c1.ts.net, connect (the consent page already knows
you from the tailnet), and chat with `qwen3.8-27b`.
