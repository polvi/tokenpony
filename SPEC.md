# TPX v0.2 Specification

**An OAuth 2.0 profile for metered LLM inference grants**

Status: Draft. Supersedes TPX v0.1. Reference implementation: [tokenpony.dev](https://tokenpony.dev).

## Acknowledgments

Thanks to Karl McGuinness and Paul Querna for their contributions to this profile.

## 1. Introduction

TPX lets an LLM application operate without embedded provider
credentials: the user grants the app a metered token budget from a
provider the user chooses and pays.

TPX v0.1 defined a bespoke OAuth-style flow. v0.2 removes the bespoke
wire format: TPX is now a profile of OAuth 2.0, aligned with the OAuth
2.1 baseline. A TPX provider is an ordinary OAuth authorization server
plus a protected resource. A TPX app is an ordinary OAuth client.
Everything TPX-specific is carried by one authorization details type (`llm-inference`), one introspection member (`budget_used`), and one usage-accounting member on the inference API (`credits_charged`). A conforming OAuth client stack works against a TPX provider without modification.

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in RFC 2119 and RFC 8174.

### 1.1 Design goals

- A TPX app works with any provider the user names; the app hard-codes nothing but the flow.
- TPX grants tokens, not identity. The app learns nothing about the user from the grant.
- The budget is a hard damage cap: a leaked credential can spend at most the remaining budget.
- Reuse OAuth. Standard endpoints, standard parameters, standard libraries, standard security analysis.

### 1.2 Profiled specifications

| Mechanism | Specification |
| --- | --- |
| Authorization framework | RFC 6749, OAuth 2.1 baseline |
| Bearer token usage | RFC 6750 |
| PKCE | RFC 7636 |
| Dynamic client registration | RFC 7591 |
| Authorization server metadata | RFC 8414 |
| Protected resource metadata | RFC 9728 |
| Resource indicators | RFC 8707 |
| Pushed authorization requests (PAR) | RFC 9126 |
| Issuer identification | RFC 9207 |
| Rich authorization requests (RAR) | RFC 9396 |
| Demonstrating proof of possession (DPoP) | RFC 9449 |
| Token introspection | RFC 7662 |
| Token revocation | RFC 7009 |

## 2. Roles and Terms

- **User**: the OAuth resource owner. Maintains a balance with a provider; approves grants.
- **App**: the OAuth client. Never holds provider keys; holds per-user grants.
- **Provider**: one operator acting as both the OAuth
  authorization server and the protected resource (an OpenAI-compatible
  inference API). The two roles MAY be served from different origins.
- **Grant**: a user's approval of one app for one budget. Represented at runtime by a refresh token and the access tokens issued from it.
- **Budget**: the maximum spend authorized under a grant, denominated in credits. A damage cap, not a payment.
- **Credit**: 1 credit = US$0.000001. A `budget` of `100000` caps spend at $0.10.

## 3. Protocol Overview

```
User          App                 Provider (AS)              Provider (API)
 |             |                       |                          |
 |-- names provider (api.tokenpony.dev) -->                       |
 |             |-- GET /.well-known/oauth-protected-resource ---->|
 |             |<--- resource, authorization_servers -------------|
 |             |-- GET /.well-known/oauth-authorization-server -->|
 |             |<--- endpoints, capabilities ---|                 |
 |             |-- POST /par (PKCE challenge,   |                 |
 |             |    authorization_details with budget) ---------->|
 |             |<--- request_uri ---------------|                 |
 |<-- redirect to authorization_endpoint --|                      |
 |-- authenticates, consents to app + budget -->                  |
 |<-- 302 callback?code=...&state=...&iss=... --|                 |
 |             |-- POST /token (code + PKCE verifier) ----------->|
 |             |<--- access_token (short-lived), refresh_token,   |
 |             |     granted authorization_details --|            |
 |             |-- POST /chat/completions (DPoP-bound token) ---->|
 |             |<--- completion + usage.credits_charged ----------|
```

## 4. Discovery

A provider is identified by the HTTPS origin of its inference API. Discovery is resource-first, per RFC 9728.

### 4.1 Protected resource metadata

The inference API MUST publish RFC 9728 metadata:

```
GET https://api.tokenpony.dev/.well-known/oauth-protected-resource
```

```json
{
  "resource": "https://api.tokenpony.dev",
  "authorization_servers": ["https://api.tokenpony.dev"],
  "bearer_methods_supported": ["header"]
}
```

Unauthenticated requests to the API MUST return `401` with a challenge pointing at this metadata:

```
WWW-Authenticate: Bearer resource_metadata="https://api.tokenpony.dev/.well-known/oauth-protected-resource"
```

### 4.2 Authorization server metadata

Each listed authorization server MUST publish RFC 8414 metadata at `/.well-known/oauth-authorization-server`:

```json
{
  "issuer": "https://api.tokenpony.dev",
  "authorization_endpoint": "https://api.tokenpony.dev/authorize",
  "token_endpoint": "https://api.tokenpony.dev/token",
  "pushed_authorization_request_endpoint": "https://api.tokenpony.dev/par",
  "registration_endpoint": "https://api.tokenpony.dev/register",
  "introspection_endpoint": "https://api.tokenpony.dev/introspect",
  "revocation_endpoint": "https://api.tokenpony.dev/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_basic"],
  "authorization_details_types_supported": ["llm-inference"],
  "dpop_signing_alg_values_supported": ["ES256"],
  "authorization_response_iss_parameter_supported": true
}
```

`authorization_details_types_supported` MUST include `llm-inference`. There is no `/.well-known/tpx` endpoint and no `tpx_version` field; capabilities are discovered from metadata members.

### 4.3 Models and rates

Model discovery is part of the inference API surface, not OAuth metadata: `GET {resource}/models` lists available models, and each entry carries its per-token rates in credits (fresh input, cached input, output).

## 5. Client Registration

Apps register via RFC 7591 dynamic registration. Registration is open in v0.2; providers MAY gate access.

```
POST https://api.tokenpony.dev/register
Content-Type: application/json
```

```json
{
  "client_name": "Pony Chat",
  "redirect_uris": ["https://ponychat.tokenpony.dev/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"]
}
```

- Browser-based and native apps are public clients: they MUST register `token_endpoint_auth_method: none` and rely on PKCE. Providers MUST NOT issue client secrets to public clients.
- Confidential clients use `client_secret_basic` or `private_key_jwt`. Secrets are shown once and stored hashed.
- Providers SHOULD additionally accept client ID metadata documents (an HTTPS URL as `client_id`, serving its own RFC 7591-format metadata). This removes per-provider
  registration entirely and gives the consent screen a verifiable client
  origin instead of a self-asserted name.
- Redirect URIs are compared by exact string match.

## 6. Authorization

### 6.1 The `llm-inference` authorization details type

The budget is typed authorization data, expressed as an RFC 9396
authorization details object rather than a bespoke query parameter:

```json
{
  "type": "llm-inference",
  "budget": 100000,
  "models": ["pony-8b", "pony-70b"]
}
```

| Field | Requirement | Meaning |
| --- | --- | --- |
| `type` | REQUIRED | The string `llm-inference`. |
| `budget` | REQUIRED | Positive integer. Maximum spend under this grant, in credits. |
| `models` | OPTIONAL | Array of model identifiers the grant is limited to. Absent means all models. |

Providers MUST reject a request whose `llm-inference`
object contains unrecognized fields or malformed values (fail closed,
per RFC 9396). Future fields (for example a per-request cap) extend this
type; they do not add query parameters.

### 6.2 Authorization request

Clients SHOULD push the request via PAR; providers MUST support PAR.
The budget is integrity-sensitive, and TPX clients talk to arbitrary
user-named providers, so keeping the request out of the front channel is
cheap insurance.

```
POST https://api.tokenpony.dev/par
Content-Type: application/x-www-form-urlencoded

response_type=code
&client_id=app_7f3k
&redirect_uri=https%3A%2F%2Fponychat.tokenpony.dev%2Fcallback
&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
&code_challenge_method=S256
&state=af0ifjsldkj
&resource=https%3A%2F%2Fapi.tokenpony.dev
&authorization_details=%5B%7B%22type%22%3A%22llm-inference%22%2C%22budget%22%3A100000%7D%5D
```

The client then redirects the user to `{authorization_endpoint}?client_id=app_7f3k&request_uri={request_uri}`.

Requirements:

- PKCE with `S256` is REQUIRED for all clients.
- `resource` (RFC 8707) SHOULD carry the resource
  identifier from the protected resource metadata; issued tokens MUST be
  audience-restricted to it.
- `state` is OPTIONAL (PKCE provides CSRF protection); when sent, it MUST be returned unmodified.

### 6.3 Consent

The provider authenticates the user by its own means (tokenpony.dev
uses passkeys via AuthGravity) and renders consent showing, at minimum:
the client identity (registered name and, when available, verified
origin), the requested budget in credits and its currency equivalent,
and any model restriction. The user or provider MAY grant a lower budget
than requested.

### 6.4 Authorization response

Approval:

```
302 https://ponychat.tokenpony.dev/callback?code=SplxlOBeZQQYbYS6WxSbIA&state=af0ifjsldkj&iss=https%3A%2F%2Fapi.tokenpony.dev
```

Denial:

```
302 https://ponychat.tokenpony.dev/callback?error=access_denied&state=af0ifjsldkj&iss=https%3A%2F%2Fapi.tokenpony.dev
```

- The `iss` parameter (RFC 9207) is REQUIRED. Clients
  interacting with more than one provider MUST validate it against the
  issuer the flow started with before using the code.
- Authorization codes are single-use and expire after 5 minutes. On
  reuse of a code, the provider MUST invalidate the code and SHOULD revoke the grant issued from it.

## 7. Tokens

### 7.1 Token request

The token endpoint is a standard RFC 6749 token endpoint: requests are `application/x-www-form-urlencoded`, and client authentication follows the registered `token_endpoint_auth_method`.

```
POST https://api.tokenpony.dev/token
Content-Type: application/x-www-form-urlencoded
DPoP: eyJ0eXAiOiJkcG9wK2p3dCIs...

grant_type=authorization_code
&code=SplxlOBeZQQYbYS6WxSbIA
&redirect_uri=https%3A%2F%2Fponychat.tokenpony.dev%2Fcallback
&client_id=app_7f3k
&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
```

Token endpoint errors use the flat RFC 6749 Section 5.2 shape (`{"error": "...", "error_description": "..."}`).

### 7.2 Token response

```json
{
  "access_token": "tpx_at_2YotnFZFEjr1zCsicMWpAA",
  "token_type": "DPoP",
  "expires_in": 3600,
  "refresh_token": "tpx_rt_tGzv3JOkF0XG5Qx2TlKWIA",
  "authorization_details": [
    { "type": "llm-inference", "budget": 100000 }
  ]
}
```

- `expires_in` is REQUIRED. Access token lifetime SHOULD NOT exceed 3600 seconds.
- `refresh_token` is REQUIRED. The refresh token represents the grant; the budget lives on the grant, not on any access token.
- `authorization_details` echoes the granted values, which MAY be lower than requested. Clients MUST read the granted budget from here.
- The response contains no `api_base` (discovery's job, Section 4) and no `budget_used` (introspection's job, Section 9.1).
- Access tokens are opaque to clients and audience-restricted to the
  resource. Providers store only hashed copies. If the authorization
  server and inference API are ever operated separately, providers MAY use RFC 9068 JWT access tokens or introspection between the two; nothing in this profile changes.

### 7.3 Refresh

```
grant_type=refresh_token&refresh_token=tpx_rt_...
```

- Refresh tokens MUST be rotated on each use. Detected reuse of a rotated refresh token MUST revoke the grant.
- A refresh request against a revoked or budget-exhausted grant returns `invalid_grant`.

### 7.4 Sender constraining

Providers MUST support DPoP (RFC 9449); clients SHOULD use it. When
DPoP is used, refresh tokens issued to public clients MUST be
DPoP-bound. The budget remains a hard damage cap either way; DPoP makes
it the backstop rather than the only defense.

## 8. Inference API

### 8.1 Authentication

Requests carry the access token per RFC 6750 (or RFC 9449 when DPoP-bound):

```
POST https://api.tokenpony.dev/v1/chat/completions
Authorization: DPoP tpx_at_2YotnFZFEjr1zCsicMWpAA
DPoP: eyJ0eXAiOiJkcG9wK2p3dCIs...
```

### 8.2 Endpoints

Providers MUST serve, relative to the resource identifier:

- `GET /models`: available models with per-token rates in credits.
- `POST /chat/completions`: OpenAI-compatible, streaming (SSE) and non-streaming.

### 8.3 Metering

The provider prices actual usage (fresh input, cached input, and
output tokens at the model's published rates) and debits the grant in
credits. Responses report the debit in the `usage` object:

```json
"usage": {
  "prompt_tokens": 812,
  "cached_tokens": 256,
  "completion_tokens": 214,
  "credits_charged": 1930
}
```

Streaming responses report `usage`, including `credits_charged`, in the final SSE chunk.

### 8.4 Errors

Token problems are signaled with RFC 6750 challenges; spend problems
are application-layer and use the API's OpenAI-compatible error body.

| Status | Signal | Meaning | Recovery |
| --- | --- | --- | --- |
| 401 | `WWW-Authenticate: Bearer error="invalid_token"` | Token expired, unknown, malformed, or the grant was revoked | Refresh; if refresh returns `invalid_grant`, re-authorize |
| 402 | body `error.code: "budget_exhausted"` | Grant budget spent | New authorization request; the user decides whether to top off the app |
| 402 | body `error.code: "balance_exhausted"` | User's provider balance empty | User tops off their provider balance |

A revoked grant is an invalid token; v0.1's separate `403 grant_revoked` is removed. Revocation takes effect immediately: in-flight and subsequent calls fail with `401 invalid_token`.

## 9. Grant State

### 9.1 Introspection

The introspection endpoint (RFC 7662) is the home of runtime grant
state. Clients MAY introspect their access token to check remaining
budget before starting large jobs:

```json
{
  "active": true,
  "client_id": "app_7f3k",
  "token_type": "DPoP",
  "exp": 1784563200,
  "authorization_details": [
    { "type": "llm-inference", "budget": 100000 }
  ],
  "budget_used": 41250
}
```

- `budget_used` is a TPX extension member: total credits debited against the grant. Remaining budget is `budget - budget_used`.
- Responses MUST NOT include `sub` or any other identity claim.

### 9.2 Revocation

- Users revoke grants at the provider (tokenpony.dev: the dashboard). Effect is immediate.
- Apps MUST be able to revoke grants they no longer need via the
  revocation endpoint (RFC 7009), passing the refresh token. Revoking the
  refresh token revokes the grant and all access tokens issued from it.

### 9.3 Top-off

When a grant runs dry the app starts a new authorization request with a fresh `llm-inference` object. The user decides whether to top off the app. The app SHOULD revoke the exhausted grant.

## 10. Security Considerations

- **Budget as damage cap.** A leaked access or refresh
  token can spend at most the remaining budget. v0.2 layers standard
  defenses in front of the cap: short-lived access tokens, rotating
  refresh tokens with reuse detection, and DPoP sender constraining.
- **Mix-up attacks.** TPX clients talk to arbitrary
  user-named providers, the topology where authorization server mix-up is
  the canonical threat. Clients MUST validate `iss` (RFC 9207) and MUST key pending state and codes by issuer.
- **CSRF.** PKCE is the required defense; `state` remains available.
- **Code replay.** Codes are single-use with a 5-minute lifetime; reuse SHOULD revoke the grant.
- **Consent phishing.** Open registration means
  self-asserted app names. Providers SHOULD display the client's verified
  origin (client ID metadata documents make the origin the identifier) and SHOULD apply rate limits and reputation checks to open registration.
- **Storage.** Providers store access tokens, refresh tokens, and client secrets hashed.

## 11. Privacy Considerations

TPX grants tokens, not identity. Tokens, token responses, and
introspection responses carry no email, no name, and no provider account
identifier. The app can correlate requests only within a single grant,
by design; providers MUST NOT expose a stable cross-grant user
identifier to apps. What the provider learns (usage per grant per app)
is inherent to metering.

## 12. Conformance

A **provider** MUST implement: RFC 8414 and RFC 9728 metadata; RFC 7591 registration; PKCE `S256`; PAR; RFC 9207 `iss`; the `llm-inference` authorization details type; short-lived audience-restricted access tokens with `expires_in`; rotating refresh tokens with reuse detection; DPoP support; introspection with `budget_used`; RFC 7009 revocation; the Section 8 API surface and error signals.

An **app** MUST: use PKCE; validate `iss`; register exact redirect URIs; request and read budgets via `authorization_details`; handle `401 invalid_token` by refreshing and `invalid_grant` by re-authorizing. It SHOULD: use PAR and DPoP; introspect before large jobs; revoke grants it no longer needs.

## Appendix A. Changes from v0.1

| v0.1 | v0.2 |
| --- | --- |
| `GET /.well-known/tpx`, `tpx_version` | RFC 9728 protected resource metadata + RFC 8414 AS metadata |
| `api_base`, `models_endpoint` in discovery/token response | Resource-first discovery; models are an API concern |
| Bespoke registration fields (`name`) | RFC 7591 (`client_name`, `token_endpoint_auth_method`, ...); client ID metadata documents optional |
| Client secrets for all apps | Public clients: `none` + PKCE; no secret issued |
| `budget` query parameter | RFC 9396 `authorization_details`, type `llm-inference` |
| No PKCE; `state` as sole CSRF defense | PKCE `S256` REQUIRED; `state` optional |
| No issuer in authorization response | `iss` REQUIRED (RFC 9207) |
| JSON token request with `client_secret` in body | Form-encoded per RFC 6749; standard client authentication |
| Non-expiring bearer access token | `expires_in` <= 1h + rotating refresh token; DPoP support |
| `budget`, `budget_used`, `api_base` in token response | Granted `authorization_details` in token response; `budget_used` via introspection |
| `403 grant_revoked` | Collapsed into `401 invalid_token` |
| Nested error body at OAuth endpoints | Flat RFC 6749 errors at OAuth endpoints; nested body kept at the inference API |
| Dashboard-only revocation | Dashboard + RFC 7009 for apps |

## Appendix B. TPX-A: the AAuth-Budget profile (for agents, experimental)

Status: Experimental. The OAuth profile in the body of this specification is the stable
core of TPX; TPX-A tracks the evolving AAuth drafts and will change as they do.

TPX v0.2 authorizes apps acting for a signed-in person. For autonomous **agents** that carry
their own cryptographic identity, tokenpony also implements **TPX-A**, the Token Pony Express
binding of the AAuth-Budget extension (draft-mcguinness-aauth-budget) on top of AAuth
(draft-hardt-oauth-aauth-protocol). It runs alongside this OAuth flow on the same metering
core; the difference is the authorization envelope.

Under TPX-A the provider is an AAuth resource plus access server. An agent (Ed25519 identity,
RFC 9421 HTTP Message Signatures) is granted an identity-free, budget-bearing `aa-auth+jwt`
that a person approves as a budgeted **mission** at their Person Server; the PS relays the
approved budget to the provider's `/token`, which mints the token, and the agent spends it at
the same OpenAI-compatible inference API. Budgets are the same credits as here (1 credit =
US$0.000001), metered mission-keyed with reservation, and revocable. Discovery is
`/.well-known/aauth-resource.json` (with `budget_endpoint`), distinct from the OAuth metadata
above. See the agent guide at [tokenpony.dev/llms.txt](https://tokenpony.dev/llms.txt).

## References

RFC 2119, RFC 6749, RFC 6750, RFC 7009, RFC 7591, RFC 7636, RFC 7662,
RFC 8174, RFC 8414, RFC 8707, RFC 9068, RFC 9126, RFC 9207, RFC 9396,
RFC 9421, RFC 9449, RFC 9728, RFC 7638, draft-ietf-oauth-v2-1,
draft-ietf-oauth-client-id-metadata-document, draft-hardt-oauth-aauth-protocol,
draft-mcguinness-aauth-budget.
