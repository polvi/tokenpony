---
layout: ../layouts/Prose.astro
title: "TPX v0.1: the Token Pony Express specification"
description: "The Token Pony Express (TPX) v0.1 draft specification: discovery, client registration, authorization, token exchange, metered inference, and revocation."
---
# Token Pony Express (TPX) v0.1

**Status:** Draft, proof of concept. Reference implementation: [tokenpony.dev](https://tokenpony.dev).

TPX is an OAuth-style authorization protocol for LLM inference tokens. It lets an application
ship with **no LLM credentials of its own**: instead, the user grants the app a metered token
budget from a **provider** the user chooses and pays. OAuth taught apps to ask for identity;
TPX teaches them to ask for tokens.

## 1. Roles

- **User**: holds a token balance with a provider and approves grants.
- **App (client)**: an LLM application. Never holds provider keys; holds per-user grants.
- **Provider**: sells tokens to users, serves an OpenAI-compatible inference API, and meters
  usage against grants. tokenpony is the reference provider.

## 2. Discovery

A provider is identified by an HTTPS origin (the **issuer**). Apps resolve capabilities with:

```
GET {issuer}/.well-known/tpx
```

```json
{
  "tpx_version": "0.1",
  "issuer": "https://api.tokenpony.dev",
  "authorization_endpoint": "https://api.tokenpony.dev/tpx/authorize",
  "token_endpoint": "https://api.tokenpony.dev/tpx/token",
  "registration_endpoint": "https://api.tokenpony.dev/tpx/register",
  "api_base": "https://api.tokenpony.dev/v1",
  "models_endpoint": "https://api.tokenpony.dev/v1/models"
}
```

Because any provider exposes the same document shape, a TPX app works with any provider the
user names; the app hard-codes nothing but the flow.

## 3. Client registration

Open dynamic registration (v0.1; providers MAY gate this):

```
POST {registration_endpoint}
Content-Type: application/json

{ "name": "Pony Chat", "redirect_uris": ["https://ponychat.tokenpony.dev/callback"] }
```

Response:

```json
{ "client_id": "app_…", "client_secret": "cs_…" }
```

`client_secret` is shown once and stored hashed by the provider.

## 4. Authorization

The app sends the user to the provider:

```
GET {authorization_endpoint}
  ?client_id=app_…
  &redirect_uri=https://ponychat.tokenpony.dev/callback
  &state={opaque-csrf-value}
  &budget={requested-tokens}
```

- `redirect_uri` MUST exactly match one registered for the client.
- `budget` is the requested grant size in provider credits (a damage cap, not a payment).
  tokenpony denominates 1 credit = US$0.000001, so `budget=100000` caps spend at $0.10.
- The provider authenticates the user (tokenpony uses passkeys via AuthGravity) and renders a
  consent page showing the app name and requested budget. The user may approve or deny.

On approval the provider redirects:

```
302 {redirect_uri}?code={authorization_code}&state={state}
```

Authorization codes are single-use and expire after 5 minutes. On denial:
`302 {redirect_uri}?error=access_denied&state={state}`.

## 5. Token exchange

```
POST {token_endpoint}
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "code": "…",
  "client_id": "app_…",
  "client_secret": "cs_…",
  "redirect_uri": "https://ponychat.tokenpony.dev/callback"
}
```

Response:

```json
{
  "access_token": "tpx_…",
  "token_type": "bearer",
  "budget": 100000,
  "budget_used": 0,
  "api_base": "https://api.tokenpony.dev/v1"
}
```

The access token is scoped to one user + one client + one budget. It carries **no user
identity**; TPX grants tokens, not identity. Providers store only a hash of the token.

## 6. Metered inference API

`api_base` is an OpenAI-compatible surface. v0.1 requires:

- `GET {api_base}/models`: available models
- `POST {api_base}/chat/completions`: streaming (SSE) and non-streaming

The app authenticates with `Authorization: Bearer tpx_…`. After each completion the provider
prices **actual** usage (fresh input, cached input, and output tokens at the model's published
per-token rates) and debits that cost, in credits, from the grant's remaining budget and the
user's balance. The response `usage` block carries a `credits_charged` extension, and streaming
responses report usage in the final SSE chunk. Per-model rates are listed on `{models_endpoint}`.

### Errors

| Status | `error.code`       | Meaning                                        |
| ------ | ------------------ | ---------------------------------------------- |
| 401    | `invalid_token`    | Unknown, malformed, or revoked-and-purged token |
| 402    | `budget_exhausted` | Grant budget spent; re-authorize for more      |
| 402    | `balance_exhausted`| User's provider balance is empty               |
| 403    | `grant_revoked`    | User revoked this grant                        |

Error body shape: `{ "error": { "code": "budget_exhausted", "message": "…" } }`.

When a grant runs dry the app simply starts a new authorization request; the user decides
whether to top up the app.

## 7. Revocation

Users can revoke any grant at their provider (tokenpony: the dashboard). Revocation takes
effect immediately; subsequent API calls fail with `403 grant_revoked`.

## 8. Security considerations

- `state` protects the redirect round-trip against CSRF; apps MUST verify it.
- Authorization codes are single-use with a 5-minute TTL; reuse invalidates the grant.
- Access tokens and client secrets are stored hashed at the provider.
- The budget is a hard damage cap: a leaked grant token can spend at most the remaining
  budget, and the user can revoke it at any time.
- Grants are pseudonymous: the app learns nothing about the user from the token: no email,
  no name, no provider account id.
