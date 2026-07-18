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
does not complete until its reason is explicitly decrypted.

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

## Long-action feedback

Every irreversible or network-bound action acknowledges the first click in the
same frame. Confidential payment submission uses the truthful stages `Preflight`,
`Encrypt`, `Broadcast`, `TEE`, and `Finalize` with an indeterminate shimmer inside
the active stage; it never fabricates a percentage.

The active button keeps normal contrast, shows a spinner and processing label,
and is synchronously locked before the first await. The progress surface sits next
to the initiating CTA and includes elapsed time, an expected range, a transaction
link when known, and a recovery explanation. Reduced-motion mode keeps the stage
state but removes the moving shimmer.

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

## Authenticity boundaries

- The v1 contract ABI and existing Sepolia addresses are unchanged.
- Public views never display plaintext amounts, policy values or blocked reasons.
- The v1 Audit Packet always includes the three policy snapshots plus each
  selected request's amount and reason. The UI labels this fixed schema.
- Vendor names, purposes and the Launch Day narrative are explicitly demo
  metadata. Request states, Safe decisions, packets, proofs and transaction links
  come from real objects or a clearly labelled frozen evidence run.
- No health check, synthetic timer or client-only flag may stand in for a CTA's
  real lifecycle result.

## Change log

### 2026-07-19

- Restored the WaveField, translucent panel hierarchy and original VeilGuard
  wordmark treatment throughout the operations desk.
- Replaced oversized empty master/detail panels with aligned, content-sized
  approval and policy states; bounded live Flow Explorer lists independently.
- Restored immediate button press, spinner and staged progress feedback without
  reviving the former synthetic 96% indicator.
- Added same-frame submission and decision locks, bounded API/receipt waits,
  broadcast-time recovery pointers and run-bound mission reconciliation.
- Added an explicit chain-state refresh action to gated Mission Drawer steps.
