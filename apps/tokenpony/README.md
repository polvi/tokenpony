# tokenpony-api

The tokenpony provider Worker at **api.tokenpony.dev**: TPX v0.1 issuer (discovery, client
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
| `STRIPE_SECRET_KEY` | Creates Checkout Sessions for token packs. Standard test key works; a restricted key needs Checkout Sessions/Products/Prices: Write (inline `price_data`). | Dashboard shows "top-ups not configured"; `/billing/checkout` returns 503 |
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
