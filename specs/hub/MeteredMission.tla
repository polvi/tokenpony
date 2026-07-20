---------------------------- MODULE MeteredMission ----------------------------
(*
Mission-scoped budget metering for delegated agents on a metered API.

An agent works under a "mission" approved by a person at their own identity
server; that server attests a budget for the mission, and a separate funder
later claims and funds it at the metered provider.

Models the safety core of the flow:
  - budget attestations are single-use at the token-endpoint relay
    (replay guard on the attestation id)
  - the mission budget binds on the first relayed token and never changes;
    later tokens must present the identical budget or are refused
  - the meter is mission-keyed and cumulative across every token under the
    mission: reserve worst-case cost before the call, commit or release
    after, never past the bound budget
  - spend requires a funded mission: nothing is reserved or charged until a
    funder claims the mission
  - revocation is final and stops new reservations; an in-flight reservation
    may still settle, but only within what was already reserved

Abstractions: signature verification, token expiry, and the relay handshake
are trusted plumbing and not modeled; tokens are not tracked individually
because the meter is keyed by mission, not token. "completed" missions gate
spend exactly like "revoked" ones and are collapsed into that phase. The
funder's account balance is out of scope; this spec checks the mission cap
only (a companion spec covers the user-facing grant lifecycle).
*)
EXTENDS Naturals

CONSTANTS
  Missions,   \* mission ids
  Atts,       \* budget-attestation ids the approver's server may issue
  Reqs,       \* concurrent metered-request slots
  NoMission,  \* model value: "not tied to any mission"
  MaxBudget,  \* largest budget an attestation can carry, in credits
  Costs       \* possible worst-case reservation amounts for one call

ASSUME NoMission \notin Missions

VARIABLES
  attPhase,   \* att     -> "unissued" | "issued" | "redeemed"
  attMission, \* att     -> mission it approves, or NoMission
  attBudget,  \* att     -> budget the approver's server attested
  mStatus,    \* mission -> "unbound" | "active" | "revoked"
  mBudget,    \* mission -> budget bound by the first relayed token
  mUsed,      \* mission -> committed spend
  mReserved,  \* mission -> outstanding reservations
  funded,     \* mission -> a funder has claimed the mission
  reqPhase,   \* req     -> "idle" | "inflight"
  reqMission, \* req     -> mission being spent against, or NoMission
  reqAmt      \* req     -> credits reserved for this request

vars == <<attPhase, attMission, attBudget, mStatus, mBudget, mUsed,
          mReserved, funded, reqPhase, reqMission, reqAmt>>

TypeOK ==
  /\ attPhase \in [Atts -> {"unissued", "issued", "redeemed"}]
  /\ attMission \in [Atts -> Missions \cup {NoMission}]
  /\ attBudget \in [Atts -> 0..MaxBudget]
  /\ mStatus \in [Missions -> {"unbound", "active", "revoked"}]
  /\ mBudget \in [Missions -> 0..MaxBudget]
  /\ mUsed \in [Missions -> 0..MaxBudget]
  /\ mReserved \in [Missions -> 0..MaxBudget]
  /\ funded \in [Missions -> BOOLEAN]
  /\ reqPhase \in [Reqs -> {"idle", "inflight"}]
  /\ reqMission \in [Reqs -> Missions \cup {NoMission}]
  /\ reqAmt \in [Reqs -> 0..MaxBudget]

Init ==
  /\ attPhase = [a \in Atts |-> "unissued"]
  /\ attMission = [a \in Atts |-> NoMission]
  /\ attBudget = [a \in Atts |-> 0]
  /\ mStatus = [m \in Missions |-> "unbound"]
  /\ mBudget = [m \in Missions |-> 0]
  /\ mUsed = [m \in Missions |-> 0]
  /\ mReserved = [m \in Missions |-> 0]
  /\ funded = [m \in Missions |-> FALSE]
  /\ reqPhase = [r \in Reqs |-> "idle"]
  /\ reqMission = [r \in Reqs |-> NoMission]
  /\ reqAmt = [r \in Reqs |-> 0]

-------------------------------------------------------------------------------
(* The person approves mission m at their identity server with budget b; the
   server mints a single-use budget attestation. A server may attest the same
   mission more than once, with any budget it likes. *)
Approve(a, m, b) ==
  /\ attPhase[a] = "unissued"
  /\ attPhase' = [attPhase EXCEPT ![a] = "issued"]
  /\ attMission' = [attMission EXCEPT ![a] = m]
  /\ attBudget' = [attBudget EXCEPT ![a] = b]
  /\ UNCHANGED <<mStatus, mBudget, mUsed, mReserved, funded,
                 reqPhase, reqMission, reqAmt>>

(* Budget relay at the token endpoint: the attestation is consumed either way
   (replay guard fires before budget binding). The first token binds the
   mission's budget and activates it; a later relay mints another token only
   if its budget matches, and changes no meter state in any case. *)
Relay(a) ==
  /\ attPhase[a] = "issued"
  /\ attPhase' = [attPhase EXCEPT ![a] = "redeemed"]
  /\ LET m == attMission[a] IN
       IF mStatus[m] = "unbound"
         THEN /\ mStatus' = [mStatus EXCEPT ![m] = "active"]
              /\ mBudget' = [mBudget EXCEPT ![m] = attBudget[a]]
         ELSE UNCHANGED <<mStatus, mBudget>>
  /\ UNCHANGED <<attMission, attBudget, mUsed, mReserved, funded,
                 reqPhase, reqMission, reqAmt>>

(* A funder claims the mission; open federation of identity servers is safe
   because no money moves before this step. Claim-once: the funder is set
   only while unclaimed and active. *)
Fund(m) ==
  /\ mStatus[m] = "active"
  /\ ~funded[m]
  /\ funded' = [funded EXCEPT ![m] = TRUE]
  /\ UNCHANGED <<attPhase, attMission, attBudget, mStatus, mBudget, mUsed,
                 mReserved, reqPhase, reqMission, reqAmt>>

(* A metered call reserves its worst-case cost up front. Refused unless the
   mission is active, funded, and the reservation fits under the cap. *)
Reserve(r, m, k) ==
  /\ reqPhase[r] = "idle"
  /\ mStatus[m] = "active"
  /\ funded[m]
  /\ mUsed[m] + mReserved[m] + k <= mBudget[m]
  /\ reqPhase' = [reqPhase EXCEPT ![r] = "inflight"]
  /\ reqMission' = [reqMission EXCEPT ![r] = m]
  /\ reqAmt' = [reqAmt EXCEPT ![r] = k]
  /\ mReserved' = [mReserved EXCEPT ![m] = mReserved[m] + k]
  /\ UNCHANGED <<attPhase, attMission, attBudget, mStatus, mBudget, mUsed,
                 funded>>

(* The call finished: commit the actual charge, capped at the reservation,
   and release the rest. Deliberately no status check: a revoke that lands
   mid-request cannot stop the settle, only bound it. *)
Commit(r, actual) ==
  /\ reqPhase[r] = "inflight"
  /\ actual <= reqAmt[r]
  /\ LET m == reqMission[r] IN
       /\ mReserved' = [mReserved EXCEPT ![m] = mReserved[m] - reqAmt[r]]
       /\ mUsed' = [mUsed EXCEPT ![m] = mUsed[m] + actual]
  /\ reqPhase' = [reqPhase EXCEPT ![r] = "idle"]
  /\ reqMission' = [reqMission EXCEPT ![r] = NoMission]
  /\ reqAmt' = [reqAmt EXCEPT ![r] = 0]
  /\ UNCHANGED <<attPhase, attMission, attBudget, mStatus, mBudget, funded>>

(* The call failed before any spend: release the reservation uncharged. *)
Release(r) ==
  /\ reqPhase[r] = "inflight"
  /\ mReserved' = [mReserved EXCEPT ![reqMission[r]] =
                     mReserved[reqMission[r]] - reqAmt[r]]
  /\ reqPhase' = [reqPhase EXCEPT ![r] = "idle"]
  /\ reqMission' = [reqMission EXCEPT ![r] = NoMission]
  /\ reqAmt' = [reqAmt EXCEPT ![r] = 0]
  /\ UNCHANGED <<attPhase, attMission, attBudget, mStatus, mBudget, mUsed,
                 funded>>

(* Revocation by the funder or completion by the approver's server; both gate
   spend identically and are collapsed into "revoked". *)
Revoke(m) ==
  /\ mStatus[m] = "active"
  /\ mStatus' = [mStatus EXCEPT ![m] = "revoked"]
  /\ UNCHANGED <<attPhase, attMission, attBudget, mBudget, mUsed, mReserved,
                 funded, reqPhase, reqMission, reqAmt>>

Next ==
  \/ \E a \in Atts, m \in Missions, b \in 1..MaxBudget : Approve(a, m, b)
  \/ \E a \in Atts : Relay(a)
  \/ \E m \in Missions : Fund(m) \/ Revoke(m)
  \/ \E r \in Reqs, m \in Missions, k \in Costs : Reserve(r, m, k)
  \/ \E r \in Reqs : \E actual \in 0..reqAmt[r] : Commit(r, actual)
  \/ \E r \in Reqs : Release(r)

Spec == Init /\ [][Next]_vars

-------------------------------------------------------------------------------
(* The mission budget is a hard damage cap: committed spend plus everything
   still reserved never exceeds it, across all tokens under the mission. *)
BudgetIsHardCap == \A m \in Missions : mUsed[m] + mReserved[m] <= mBudget[m]

(* No money moves on an unfunded mission: an unclaimed mission has never had
   a credit reserved or charged. *)
SpendRequiresFunding ==
  \A m \in Missions : mUsed[m] + mReserved[m] > 0 => funded[m]

(* Every live mission traces to a redeemed attestation, and its bound budget
   is exactly one the approver's server attested for it. *)
MissionsComeFromAttestations ==
  \A m \in Missions :
    mStatus[m] # "unbound" =>
      \E a \in Atts :
        /\ attPhase[a] = "redeemed"
        /\ attMission[a] = m
        /\ attBudget[a] = mBudget[m]

(* First token wins: once a mission is bound, its budget never changes, no
   matter what later attestations carry. *)
BudgetBindsOnce ==
  [][\A m \in Missions :
       mStatus[m] # "unbound" => mBudget'[m] = mBudget[m]]_vars

(* Revocation is final and shrinks exposure: a revoked mission never
   reactivates, takes no new reservations, and its total exposure (spent +
   reserved) only goes down as in-flight requests settle. *)
NoNewSpendAfterRevoke ==
  [][\A m \in Missions :
       mStatus[m] = "revoked" =>
         /\ mStatus'[m] = "revoked"
         /\ mReserved'[m] <= mReserved[m]
         /\ mUsed'[m] + mReserved'[m] <= mUsed[m] + mReserved[m]]_vars

===============================================================================
