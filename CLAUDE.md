# tokenpony

Bun-workspaces monorepo on Cloudflare Workers. See README.md for what this is and the
repo layout. Commit and deploy freely once changes are verified.

## Commands

- `bun install` at the repo root (workspaces).
- Deploy a worker: `bunx wrangler deploy` from its `apps/*` directory. The www app needs
  `bun run build` first (Astro static build served as assets).
- After editing any `wrangler.jsonc`: `bunx wrangler types`, then `bunx tsc --noEmit`.
- D1 schema changes: new file in `apps/tokenpony/migrations/`, then
  `bunx wrangler d1 migrations apply tokenpony --remote`.

## Conventions

- Site and product copy: no em dashes, and never the words "honest"/"honestly".
- Purchases are called "top-off"/"top off", never "top-up"/"top up".
- `apps/www/public/llms.txt` must stay pure ASCII and consistent with SPEC.md.
- `apps/www/src/pages/spec.md` is generated from SPEC.md (same body, frontmatter added);
  regenerate it whenever SPEC.md changes.
- Credits are micro-USD (1 credit = $0.000001). Never grant free credits; the postage
  billing model lives in `apps/tokenpony/src/billing.ts` (first top-off at cost, later
  ones net one Forever stamp; `POSTAGE_CENTS` var tracks the USPS rate).
- Model catalog: `apps/tokenpony/src/models.ts`; prices come live from `env.AI.models()`
  with static fallbacks in `pricing.ts`. `moonshotai/kimi-k3` stays out of the catalog
  until AI Gateway Unified Billing credits are purchased.
- Pony Chat is deliberately styled as a third-party app (dark/rounded/lime); do not
  reuse tokenpony's airmail identity there.
- Astro compresses HTML: leave no line break between an inline tag and adjacent text you
  want separated by a space, or the space collapses.

## Verification habits

- curl the live endpoints after deploying (`/.well-known/oauth-protected-resource`, `/v1/models`, a metered
  completion with a seeded key when touching metering).
- Visual checks: headless Chrome screenshots; for mobile widths use a 390px iframe
  harness (headless Chrome clamps its window to ~500px and crops).
- Custom-domain deploys can lag at the edge for ~a minute; re-curl before concluding a
  deploy failed.
