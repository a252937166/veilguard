# Confidential Operations Desk Design

This document is the product and interaction source of truth for the VeilGuard
demo. External notes may summarize the current state, but must not redefine the
workflow or claim capabilities that are absent from the deployed contracts.

## Judge journey

The Launch Day Treasury Shift is one run-bound story:

1. The Delegate reviews and submits the 25 cUSDC CloudNode invoice. Nox evaluates
   three encrypted rules and the request executes directly.
2. The Delegate submits the 60 cUSDC ShieldOps invoice. The visitor explicitly
   chooses Approve or Reject; the bounded demo committee then executes a real
   Safe 2-of-2 action.
3. The isolated Delegate submits the 600 cUSDC Atlas Contractor invoice. It is
   blocked, no funds move, and the Delegate decrypts the scoped private reason.
4. The user reviews the irreversible v1 disclosure scope and creates the real
   mandate-grouped Audit Packets. A bundle is a UI aggregate, not a new on-chain
   object.
5. The Auditor unlocks the packet, reviews or flags every request, verifies the
   manifest, then follows the live and frozen evidence in Flow Explorer.

Mission completion is derived only from run-bound on-chain request and packet
evidence. A timeout cancellation never counts as a user Reject. A blocked request
does not complete until its reason is explicitly decrypted. Evidence may mark a
mission complete, but navigation never advances by timer: the user keeps the
Receipt, Privacy Lens or packet result until they explicitly continue.

Each guided Invoice has one strict Attempt invariant. Once a mission is complete,
its `requestId` is immutable: reducer actions, recovery scans and newer same-run
Requests must leave that binding and its evidence untouched. An incomplete
Attempt may be replaced only through an explicit retry after `Expired` or an
authenticated timeout cancellation. Unknown or temporarily unavailable decision
origin stays attached to the current Request and cannot enable another spend.

## Visual direction

The operations desk uses the original VeilGuard visual identity rather than a
flat opaque admin template:

- the WaveField remains visible behind every workspace;
- panels use restrained translucent navy surfaces, a fine border and modest blur;
- `Veil` stays neutral while `Guard` uses the purple-to-blue brand gradient;
- purple is reserved for primary actions and selection; green, amber and red are
  reserved for verified, escalated and blocked state;
- empty and unselected workbenches size to useful content instead of inheriting a
  generic full-height panel;
- long object lists scroll independently from the selected detail.

The desktop shell is 232px sidebar plus work area at 1280px and above. Below
960px, master/detail routes become two-level navigation. Below 720px, content is
single-column and action controls remain at least 44px high. All layouts must be
usable at 200% zoom without horizontal page overflow.

Surface opacity follows information density rather than one universal glass
value. Ambient and empty areas show the WaveField most clearly; Payment uses a
stronger reading surface; Audit, Policies and Verify use dense surfaces; decision
docks and dialogs are nearly opaque.

## Long-action feedback

Every irreversible or network-bound action acknowledges the first click in the
same frame. Confidential payment submission has one primary progress system with
the truthful product stages `Preflight`, `Encrypt`, `Submit`, `Private check`, and
`Publish result`; protocol finalization remains available in technical detail,
not as a competing user-facing stage. Receipt recovery remains under `Submit`
until the Request object is found. The UI never fabricates a percentage.

The active button keeps normal contrast, shows a spinner and processing label,
and is synchronously locked before the first await. The progress surface sits next
to the initiating CTA and includes elapsed time, an expected range, a transaction
link when known, and a recovery explanation. Reduced-motion mode keeps the stage
state but removes the moving shimmer.

An active payment remains visible in an operation dock even while another invoice
is inspected. A terminal Receipt replaces progress and remains selected until the
user chooses the next invoice. Safe Approve and Reject use the same contract:
validation, threshold signatures, broadcast and settlement are explicit stages,
and the transaction hash appears as soon as broadcast returns it.

## Object and authority boundaries

- `#/payments` contains Invoice drafts. `#/payments/:id` is a real Request object
  with its own summary, timeline, Privacy Lens, settlement, packet inclusion and
  transaction evidence.
- Demo narrative metadata is applied only when the run-bound memo, scenario,
  mandate, delegate and recipient all match. Recipient similarity alone never
  supplies an amount or purpose, and browser plaintext is scoped to one Request ID.
- A guided Delegate selects disclosure scope; a bounded Finance Admin service
  validates and writes the fixed-Auditor packet. A connected real Finance Admin
  signs its own packet action directly. Neither path implies that the Delegate
  holds an Admin key.
- A connected Finance Admin holds one `audit-packet-create` Operation Coordinator
  lease on `wallet:<account>` for the complete mandate-group loop, plus an
  origin-wide Web Lock for cross-tab exclusion. Route changes and component
  unmounts cannot release that wallet nonce while a receipt is pending.
  Facilitated guided creation uses the server Admin mutex instead and does not
  claim a browser wallet resource.
- Finance Admin may propose encrypted drafts and tighten with `pauseAll`. Safe
  2-of-2 activates, retires or resumes. Finance Admin rotation remains a managed
  Safe/deployment operation and is not added to the public automatic co-sign list.

## Recovery contract

The browser persists the transaction hash at broadcast time, before waiting for
the receipt. On refresh or a delayed receipt it reconciles a request only when its
domain-separated `runId + scenario + mandate + delegate` memo and expected
recipient match. This recovery is idempotent and must not use a previous run's
terminal object.

Polling and API calls are bounded. A user can request a fresh chain check from a
gated mission. Failed finalization releases its retry lock; a successful but slow
finalization lock expires after 60 seconds so the next chain snapshot can safely
retry the idempotent endpoint.

State 5 proves cancellation and refund, not who initiated it. The UI upgrades it
to a user Reject only after the read-only decision endpoint validates the same
run-bound request against a persisted user receipt; timeout and unknown origins
remain neutral. State 2 similarly restores an Approve mission only when the
attestation proves `origin=user`, `action=approve` and `chainState=2`. Likewise,
an Admin disclosure checkpoint is only a recovery pointer: receipt,
`AuditPacketCreated` fields and `getAuditPacket` scope must all match before the
bundle can be shown as created or advance a mission. A broadcast hash cannot be
discarded or overwritten by an auditor/scope change; only an explicitly reverted
receipt clears its group for a new signature. Before the injected-wallet RPC is
opened, the app durably saves `signaturePendingAt` and `signatureStartBlock`.
After reload, that unknown outcome blocks another signature and is reconciled
only by one exact on-chain event/packet/transaction match. A rejection caught by
the still-open page may clear the pre-broadcast marker; after reload there is no
user-asserted clear path because the old prompt may still be approved later.
That case requires manual chain reconciliation. Verified success is archived so
a later, intentionally different scope is not locked by a stale completed
checkpoint.

The Invoice CTA is derived from that Attempt rather than from a page-local busy
flag: strict completion opens the completed Request; state 1/3 opens the current
Request; a blocked Request opens its scoped reason action; state 2 with missing
receipt evidence recovers the decision; authenticated timeout or `Expired`
retries; and no binding submits a new confidential payment. Free Play is the only
surface that deliberately permits repeated submissions.

## Release and visual gate

Ordinary pull-request CI never mutates Sepolia. Its desktop and mobile projects
exclude the live test file; the live mode contains exactly one serial
`live-sepolia` desktop project with no retry. The manual Production Release Gate
can be dispatched only after its workflow reaches the default branch. It first
matches the deployed UI SHA to the selected commit, then treats the 17 Nox tests
as blocking and executes one Approve followed by one Reject, each within 15
minutes. GitHub stores no Safe/Admin key: the runner reaches only the bounded
production decision API and retains versioned evidence JSON, Etherscan links,
traces and a manifest for 90 days.

The sharing identity is `VeilGuard — Confidential Operations Desk for Safe`.
The versioned 1200×630 PNG depicts only the real Confidential payment → Safe
2-of-2 decision → Selective disclosure flow. Twelve deterministic visual
baselines cover Landing, Payments, Request Detail, Approval Decision, Disclosure
Builder and Audit Review at desktop and mobile sizes. Fixtures are test-only,
fixed to UTC/dark/reduced-motion, make no Sepolia calls, and mask only the UI SHA;
CI uses a 0.2 perceptual threshold with at most 0.003 differing-pixel ratio.

## Authenticity boundaries

- The v1 contract ABI and existing Sepolia addresses are unchanged.
- Public views never display plaintext amounts, policy values or blocked reasons.
- The v1 Audit Packet always includes the three policy snapshots plus each
  selected request's amount and reason. The UI labels this fixed schema. Request
  selection is real: one or more subsets may be accumulated, while the guided
  handoff waits until all three Launch Day Request IDs are covered.
- Vendor names, purposes and the Launch Day narrative are explicitly demo
  metadata. Request states, Safe decisions, packets, proofs and transaction links
  come from real objects or a clearly labelled frozen evidence run.
- No health check, synthetic timer or client-only flag may stand in for a CTA's
  real lifecycle result.

## Change log

### 2026-07-19

- Froze strict guided Attempt bindings, added symmetric user-attested Approve and
  Reject recovery, and routed completed Invoices to their bound Request instead
  of allowing a duplicate `requestSpend`.
- Serialized the whole connected-Admin packet loop under one wallet lease and
  made every broadcast checkpoint non-discardable until success or explicit
  revert is proven.
- Isolated live Sepolia mutations in a single-project manual Release Gate, added
  deterministic visual baselines and replaced favicon sharing with the
  versioned Operations Desk social image.

- Production release acceptance exercised two independent run-bound ShieldOps
  requests against the deployed Safe. Request #35 reached state 2 through
  `executeEscalated` and `EscalationExecuted`; Request #37 reached state 5
  through `cancelEscalated` and `EscalationCancelled`. Both outer transactions
  called the threshold-2 Safe with two 65-byte signatures, and the read-only
  decision endpoint attested `origin=user` with the matching action and hash.
- Replaced the former live-E2E placeholder with an explicit opt-in release gate
  that submits CloudNode before ShieldOps, verifies same-frame decision feedback,
  records the run/request recovery pointer, checks Etherscan evidence, and reloads
  the Reject path before accepting its persisted run-bound attestation. Live
  tests are serial and never automatically retried.

- Split Invoice drafts from true Request Detail routes and bound private
  presentation data to the exact run-bound Request object.
- Reduced Payment to one five-stage progress system, kept active operations
  visible across Invoice browsing and replaced timer navigation with explicit
  Continue actions.
- Made disclosure request selection real and cumulative, with explicit Delegate,
  facilitated Finance Admin and Auditor boundaries.
- Added staged Safe decision snapshots, early transaction-hash recovery, real
  chain-refresh results and resource-scoped mutation coordination.
- Added role-correct Policy proposal, pause, activation, retirement and resume
  surfaces without exposing privileged demo keys.
- Added mobile mission/action-dock collision rules and density-based translucent
  surface tokens.

- Restored the WaveField, translucent panel hierarchy and original VeilGuard
  wordmark treatment throughout the operations desk.
- Replaced oversized empty master/detail panels with aligned, content-sized
  approval and policy states; bounded live Flow Explorer lists independently.
- Restored immediate button press, spinner and staged progress feedback without
  reviving the former synthetic 96% indicator.
- Added same-frame submission and decision locks, bounded API/receipt waits,
  broadcast-time recovery pointers and run-bound mission reconciliation.
- Added an explicit chain-state refresh action to gated Mission Drawer steps.
