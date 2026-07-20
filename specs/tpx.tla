--------------------------------- MODULE tpx ---------------------------------
(*
TPX v0.3 grant lifecycle and budget metering (SPEC.md v0.3).

v0.3 changed only the wire money surface (USD numbers instead of integer
micro-USD "credits"); providers still meter in integer micro-USD, so this
model's integer semantics are unchanged.

Models the safety core of the profile:
  - authorization codes are single-use; replay revokes the minted grant (S6.4)
  - refresh tokens rotate; reuse of a rotated token revokes the grant (S7.3)
  - the budget is a hard damage cap on spend under a grant (S1.1, S10)
  - revocation is immediate: a revoked grant never spends again (S8.4, S9.2)

Abstractions: PKCE, DPoP, discovery, and token expiry are trusted plumbing and
not modeled; access tokens are collapsed into "the grant is active" since
revocation invalidates them all at once. Refresh-token generations are modeled
as a counter; presenting any generation below the current one is a reuse.
*)
EXTENDS Naturals

CONSTANTS
  Codes,       \* authorization code ids
  Grants,      \* grant ids
  NoGrant,     \* model value: "no grant minted from this code"
  MaxBudget,   \* largest budget a consent screen can approve, integer micro-USD
  Costs,       \* possible usage.cost values for one completion
               \* (wire USD; modeled as integer micro-USD)
  MaxRefresh   \* bound on refresh-token rotations per grant (finiteness)

ASSUME NoGrant \notin Grants

VARIABLES
  codePhase,   \* code  -> "unissued" | "pending" | "redeemed" | "expired"
  codeBudget,  \* code  -> budget approved at consent (S6.3)
  codeGrant,   \* code  -> grant minted from it, or NoGrant
  grantPhase,  \* grant -> "unminted" | "active" | "revoked"
  budget,      \* grant -> granted budget (from authorization_details)
  used,        \* grant -> total integer micro-USD debited
               \* (introspection budget_used, reported in USD on the wire)
  rt           \* grant -> current refresh-token generation

vars == <<codePhase, codeBudget, codeGrant, grantPhase, budget, used, rt>>

TypeOK ==
  /\ codePhase \in [Codes -> {"unissued", "pending", "redeemed", "expired"}]
  /\ codeBudget \in [Codes -> 0..MaxBudget]
  /\ codeGrant \in [Codes -> Grants \cup {NoGrant}]
  /\ grantPhase \in [Grants -> {"unminted", "active", "revoked"}]
  /\ budget \in [Grants -> 0..MaxBudget]
  /\ used \in [Grants -> 0..MaxBudget]
  /\ rt \in [Grants -> 0..MaxRefresh]

Init ==
  /\ codePhase = [c \in Codes |-> "unissued"]
  /\ codeBudget = [c \in Codes |-> 0]
  /\ codeGrant = [c \in Codes |-> NoGrant]
  /\ grantPhase = [g \in Grants |-> "unminted"]
  /\ budget = [g \in Grants |-> 0]
  /\ used = [g \in Grants |-> 0]
  /\ rt = [g \in Grants |-> 0]

-------------------------------------------------------------------------------
(* PAR + consent: the user approves budget b (possibly lower than requested,
   S6.3) and the provider issues authorization code c. *)
Approve(c, b) ==
  /\ codePhase[c] = "unissued"
  /\ codePhase' = [codePhase EXCEPT ![c] = "pending"]
  /\ codeBudget' = [codeBudget EXCEPT ![c] = b]
  /\ UNCHANGED <<codeGrant, grantPhase, budget, used, rt>>

(* Codes expire after 5 minutes unredeemed (S6.4). *)
Expire(c) ==
  /\ codePhase[c] = "pending"
  /\ codePhase' = [codePhase EXCEPT ![c] = "expired"]
  /\ UNCHANGED <<codeBudget, codeGrant, grantPhase, budget, used, rt>>

(* Token endpoint, authorization_code grant: redeem code c, mint grant g with
   the consented budget and its first refresh token (S7.1, S7.2). *)
Exchange(c, g) ==
  /\ codePhase[c] = "pending"
  /\ grantPhase[g] = "unminted"
  /\ codePhase' = [codePhase EXCEPT ![c] = "redeemed"]
  /\ codeGrant' = [codeGrant EXCEPT ![c] = g]
  /\ grantPhase' = [grantPhase EXCEPT ![g] = "active"]
  /\ budget' = [budget EXCEPT ![g] = codeBudget[c]]
  /\ UNCHANGED <<codeBudget, used, rt>>

(* An attacker replays a redeemed code: the provider revokes the grant issued
   from it and mints nothing (S6.4, S10 code replay). *)
ReplayCode(c) ==
  /\ codePhase[c] = "redeemed"
  /\ codeGrant[c] # NoGrant
  /\ grantPhase' = [grantPhase EXCEPT ![codeGrant[c]] = "revoked"]
  /\ UNCHANGED <<codePhase, codeBudget, codeGrant, budget, used, rt>>

(* refresh_token grant with the current token: rotate to a new generation
   (S7.3). Fresh access tokens are implicit in the grant staying active. *)
Refresh(g) ==
  /\ grantPhase[g] = "active"
  /\ rt[g] < MaxRefresh
  /\ rt' = [rt EXCEPT ![g] = rt[g] + 1]
  /\ UNCHANGED <<codePhase, codeBudget, codeGrant, grantPhase, budget, used>>

(* An attacker presents a rotated-away refresh token: detected reuse revokes
   the whole grant (S7.3, S10). rt > 0 means an older generation exists. *)
RefreshReuse(g) ==
  /\ grantPhase[g] = "active"
  /\ rt[g] > 0
  /\ grantPhase' = [grantPhase EXCEPT ![g] = "revoked"]
  /\ UNCHANGED <<codePhase, codeBudget, codeGrant, budget, used, rt>>

(* A metered completion debits usage.cost (wire USD; modeled as integer
   micro-USD) against the grant; the provider refuses spend past the budget
   with 402 budget_exhausted (S8.3, S8.4). *)
Spend(g, k) ==
  /\ grantPhase[g] = "active"
  /\ used[g] + k <= budget[g]
  /\ used' = [used EXCEPT ![g] = used[g] + k]
  /\ UNCHANGED <<codePhase, codeBudget, codeGrant, grantPhase, budget, rt>>

(* Revocation by the user (dashboard) or the app (RFC 7009), S9.2. *)
Revoke(g) ==
  /\ grantPhase[g] = "active"
  /\ grantPhase' = [grantPhase EXCEPT ![g] = "revoked"]
  /\ UNCHANGED <<codePhase, codeBudget, codeGrant, budget, used, rt>>

Next ==
  \/ \E c \in Codes, b \in 1..MaxBudget : Approve(c, b)
  \/ \E c \in Codes : Expire(c) \/ ReplayCode(c)
  \/ \E c \in Codes, g \in Grants : Exchange(c, g)
  \/ \E g \in Grants : Refresh(g) \/ RefreshReuse(g) \/ Revoke(g)
  \/ \E g \in Grants, k \in Costs : Spend(g, k)

Spec == Init /\ [][Next]_vars

-------------------------------------------------------------------------------
(* The budget is a hard damage cap: spend under a grant never exceeds it. *)
BudgetIsHardCap == \A g \in Grants : used[g] <= budget[g]

(* Authorization codes are single-use: no two codes mint the same grant, so a
   replayed code can never produce a second spending credential. *)
CodeMintsAtMostOneGrant ==
  \A c1, c2 \in Codes :
    (codeGrant[c1] # NoGrant /\ codeGrant[c1] = codeGrant[c2]) => c1 = c2

(* Every live grant traces back to exactly one redeemed authorization code. *)
GrantsComeFromCodes ==
  \A g \in Grants :
    grantPhase[g] # "unminted" =>
      \E c \in Codes : codeGrant[c] = g /\ codePhase[c] = "redeemed"

(* Revocation is immediate and final: a revoked grant never spends again and
   is never resurrected. *)
NoSpendAfterRevoke ==
  [][\A g \in Grants :
       grantPhase[g] = "revoked" =>
         used'[g] = used[g] /\ grantPhase'[g] = "revoked"]_vars

===============================================================================
