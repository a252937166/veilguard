# VeilGuard for Safe

**Safe already controls *who* can spend. VeilGuard keeps the spending policy itself *confidential*.**

VeilGuard is a [Safe](https://safe.global) Module that enforces **encrypted**
spending policies on a treasury — a per-request auto-execution limit, a total
delegated budget and a minimum treasury reserve — evaluated inside a TEE by the
[iExec Nox](https://docs.noxprotocol.io) confidential computing protocol.

A delegate submits an **encrypted** amount. The policy is evaluated on ciphertext
and the chain only ever learns a coarse, publicly verifiable outcome:

| Outcome | Meaning |
| --- | --- |
| `WITHIN MANDATE` | Policy passed — a confidential ERC-7984 transfer executes immediately |
| `APPROVAL REQUIRED` | Above the auto-limit — a real 2-of-2 Safe multisig approval is required |
| `BLOCKED` | Policy violated — no funds move; the coarse reason stays private to the delegate & admin |

Exact limits, remaining budgets, thresholds and amounts are **never** revealed on-chain.
Auditors receive **scoped, immutable disclosure snapshots** — not live state.

**Live contracts on Ethereum Sepolia** · current public dApp: **https://veilguard.axiqo.xyz**.
The v1.2 Operations Desk is deployed there. Releases upload every hashed asset
first, switch `index.html` last, then verify the live footer SHA and dynamic imports.

## Live deployment (Ethereum Sepolia)

| Contract | Address |
| --- | --- |
| VeilGuardModule | [`0x02e9b09f5929604b101244661835605b1ee67fea`](https://sepolia.etherscan.io/address/0x02e9b09f5929604b101244661835605b1ee67fea) |
| Safe (v1.4.1, **2-of-2**, module enabled) | [`0x22Ab88236b21D4A528251474b05f5045c6e71e99`](https://sepolia.etherscan.io/address/0x22Ab88236b21D4A528251474b05f5045c6e71e99) |
| cUSDC (ERC-7984 wrapper) | [`0x71ac9a2872048f78dc3d627c6fe7f3b2f35467b3`](https://sepolia.etherscan.io/address/0x71ac9a2872048f78dc3d627c6fe7f3b2f35467b3) |
| TestUSDC (public faucet ERC-20) | [`0x94c426eb57f5bb3fa9dfdbbbe7ae1efb2cb958ab`](https://sepolia.etherscan.io/address/0x94c426eb57f5bb3fa9dfdbbbe7ae1efb2cb958ab) |
| Nox NoxCompute (protocol) | [`0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF`](https://sepolia.etherscan.io/address/0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF) |

Full addresses & roles: [`deployments.json`](./deployments.json).

## Frozen on-chain evidence run

One clean run on Sepolia (commit `2dde792`), **real 2-of-2 Safe governance** — a single owner cannot act alone. Every hash is verifiable on Etherscan:

| Flow | Request | Finalize (proof-gated) | Safe 2-of-2 | Outcome |
| --- | --- | --- | --- | --- |
| Activate mandate #4 | [propose](https://sepolia.etherscan.io/tx/0x30016956c101f4c937b0fbfe72cadc95ead90e17c1a7af73ea8afa3d79cd9352) | — | [activate 2/2](https://sepolia.etherscan.io/tx/0x179476edcffae54c85077bcaf681b162f2ad156d8ace078e8dd564b32b08e857) | ACTIVE |
| Direct spend #5 | [request](https://sepolia.etherscan.io/tx/0x72c07b64d7faa10db837ba6965a6ae40357353046c4a3e892b156f7bd235db32) | [finalize](https://sepolia.etherscan.io/tx/0xb73036c3a45daf99512df64d2e3909589a84866d920fca33a4d3e4b94c871108) | not needed | EXECUTED |
| Escalated #4 | [request](https://sepolia.etherscan.io/tx/0xa3e45c0d82d9545a3cd97c265177f88d2e315fb05e15d93cf355450789384ed4) | [finalize](https://sepolia.etherscan.io/tx/0xd97f49b73090af9c73dce2f6abb34bdc1fdde3aa3c3a80a4cc8868e6ed634695) | [approve 2/2](https://sepolia.etherscan.io/tx/0x3edd9d7d09508c9f093bf4ac456b4ce1288050e0b82f161c12ff55ba3637f2a5) | APPROVED |
| Blocked #6 | [request](https://sepolia.etherscan.io/tx/0x6e084c52be59da98a9c5b8a87f570415df7fc3aebbfa0e7a72dea15ba896f204) | [finalize](https://sepolia.etherscan.io/tx/0xa1c79fa8d8652c59dd640ee9ab1e0b09a08750b9479b68f77a164140275ece63) | no funds move | BLOCKED |
| Selective disclosure | covers #5, #4, #6 | — | — | [packet tx](https://sepolia.etherscan.io/tx/0xde733271081e955be5c10cbaa15776cf4227ed1f980b1a242eadb49e335592a7) |

TEE latency (single run, not a percentile): within 5.4s · escalated 5.4s · blocked 1.526s. Reproduce with `scripts/final-evidence.ts`.

## How it works

```
Finance Admin ──proposeMandate(encrypted limits)──▶ VeilGuardModule ◀──activate── Safe multisig

Delegate ──requestSpend(encrypted amount)──▶ policy evaluated ON CIPHERTEXT in the Nox TEE
   ├─ budget check ── safeSub          │ against the Safe's REAL confidential balance
   ├─ reserve check ─ safeSub + ge     │ (the Safe lends the module transient handle access)
   ├─ auto-limit ──── le               │
   └─ decision = nested select ──▶ funds ATOMICALLY RESERVED (encrypted zero when blocked)

anyone ──finalize(decryptionProof)──▶ proof verified on-chain ──▶ execute / escalate / block
Auditor ◀── scoped IMMUTABLE snapshot handles — never live state, never future versions
```

Key design properties:

- **Humans are viewers, never admins.** Every decrypt grant is read-only
  (`addViewer`); persistent compute access to handles is confined to the module.
- **Atomic reservation, no shadow accounting.** Admissible funds move to module
  escrow in the same transaction as the decision, evaluated against the Safe's
  *real* confidential balance — later treasury changes can't invalidate a decision.
  A blocked request reserves an encrypted zero, indistinguishable on-chain.
- **Untrusted finalization.** The Nox gateway's signed decryption proof decides the
  outcome; the keeper (or any caller) is just a courier.
- **Governance without a super-admin.** The admin can only propose and pause;
  activating, resuming and approving escalations require the Safe multisig.

## Repository layout

```
contracts/
  VeilGuardModule.sol        the Safe Module: policies, requests, escrow, audit
  ConfidentialUSDC.sol       ERC-7984 token (local tests)
  ConfidentialUSDCWrapper.sol ERC-20→ERC-7984 wrapper (Sepolia cUSDC)
  mocks/{TestUSDC,MinimalSafe}.sol
test/                        node:test suites on the local Nox Docker stack
scripts/
  deploy-sepolia.ts          full deploy (token → wrapper → Safe → module)
  smoke-sepolia.ts           on-chain within-mandate loop + latency
  e2e-sepolia.ts             three-state + cancel + audit coverage
  keeper.ts                  untrusted finalize courier (one-shot or loop)
app/                         Hash-routed React + viem + Nox SDK operations desk
docs/DESIGN.md               canonical judge journey, visual and recovery contract
server/provisioner.mjs       bounded decision, audit, governance and onboarding API
feedback.md                  developer feedback on the Nox tooling
```

## Development

Prerequisites: Node.js **22.x** (pinned in `.nvmrc` / `.node-version`) and Docker
running (the plugin boots the Nox off-chain stack locally). On Apple Silicon,
use an arm64 Node process rather than an x64/Rosetta shell; the preflight check
fails early with a clear message when the runtime is incompatible.

```sh
nvm use
npm install
npm --prefix app install
npm run check
npm run test:server                    # bounded API and Safe-serialization tests
npm test -- "$PWD/test/00-stack.test.ts" \
            "$PWD/test/10-veilguard-flows.test.ts" \
            "$PWD/test/20-audit-isolation.test.ts" \
            "$PWD/test/30-governance.test.ts"   # 17 tests on the local Nox off-chain stack
```

> Pass **absolute** test paths — `hardhat test` with a relative path can misresolve
> against `node_modules/@iexec-nox/handle` when the suite imports the handle SDK.
> With Colima, also export its socket for the Nox plugin, for example
> `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`; Docker CLI context selection
> alone is not visible to the plugin.

### Deploy & exercise on Sepolia

```sh
# .env needs SEPOLIA_DEPLOYER_KEY (+ optional SEPOLIA_RPC_URL) and the DEMO_* role keys
npx hardhat run scripts/deploy-sepolia.ts --network sepolia
npx hardhat run scripts/smoke-sepolia.ts  --network sepolia
npx hardhat run scripts/e2e-sepolia.ts    --network sepolia
```

### dApp

```sh
cd app && npm install && npm run dev      # http://localhost:5173
npm test                                  # Vitest + React Testing Library
npm run test:e2e                         # Playwright: 1366x768 + 390x844
npm run build                             # → app/dist (static SPA)
```

### Keeper (optional availability helper)

```sh
npx hardhat run scripts/keeper.ts --network sepolia          # one-shot sweep
KEEPER_LOOP=1 npx hardhat run scripts/keeper.ts --network sepolia   # loop
```
Systemd/cron templates: [`scripts/keeper.service.example`](./scripts/keeper.service.example).

## Confidential Operations Desk

The dApp is organized around work objects rather than disconnected role demos.
Its refresh-safe routes include `#/overview`, `#/payments`, `#/payments/:id`,
`#/policies/new`, `#/policies/:id`, `#/policies/:id/new-version`,
`#/approvals/:id`, `#/disclosure`, `#/audit/:packetId`,
`#/verify/:flowId`, `#/contracts`, `#/provenance` and `#/funds`. The guided
Launch Day run cannot skip ahead:

1. submit the 25 cUSDC CloudNode invoice and verify direct execution;
2. submit the 60 cUSDC ShieldOps request and explicitly choose Approve or Reject;
3. submit the 600 cUSDC Atlas Contractor request, verify it is blocked, and decrypt
   the private reason as its isolated Delegate;
4. review the immutable v1 disclosure scope and create the run-bound packet set;
5. unlock, review or flag every disclosed request, pass integrity checks, then
   inspect the direct, committee, blocked and audit flows in Verify.

`DemoSessionV2` binds every request and packet to one run. An unfinished run can
be resumed. Restart is refused until any old pending escalation has been really
cancelled and its escrow refund confirmed. The public view never receives
plaintext amounts, policy values or blocked reasons.

Payment submission acknowledges the first click immediately and reports the
single truthful Preflight → Encrypt → Submit → Private check → Publish result
flow. The transaction hash is persisted at broadcast time; refresh recovery stays
under Submit and then matches only the current run's domain-separated memo,
scenario, mandate, delegate and recipient. Invoice drafts remain in the Inbox;
created Request IDs open a dedicated timeline, Privacy Lens, settlement and
transaction view. See
[`docs/DESIGN.md`](./docs/DESIGN.md) for the canonical interaction and recovery
contract.

Mission evidence never triggers a timed page change. The completed Receipt,
blocked reason or packet result stays visible until the visitor explicitly
continues. On mobile, action-required missions collapse to a compact rail above
the Safe decision dock instead of covering Approve or Reject.

## Real 2-of-2 demo committee

The guided ShieldOps Approve/Reject buttons select a constrained demo action;
they are not presented as the visitor's signature. Both current Safe owner keys
remain server-side and produce a real threshold-2 `execTransaction`. There is no
timer-based auto-approval: after the disclosed three-minute decision window the
only automatic action is `cancelEscalated`, which returns escrow and restores the
request budget.

The provisioner enforces three narrow server interfaces:

- `POST /api/demo-decision` accepts only the current run's pending ShieldOps
  request, exact recipient and decrypted 60 cUSDC amount. Same-action retries are
  idempotent; `202` returns the current validation/signing/broadcast/confirmation
  phase and the transaction hash as soon as it exists. `409` is a
  conflicting decision, `410` means the window expired and escrow was returned,
  and `503` refuses to sign when Finance Admin cannot decrypt and verify the amount.
- `GET /api/demo-decision?runId=…&requestId=…` is a read-only, run-bound
  attestation over the persisted decision journal. A public state-5 cancellation
  remains `Cancelled and refunded` unless this endpoint proves a matching user
  Reject; watchdog expiry is reported separately and never impersonates a user.
- `POST /api/demo-audit-packet` accepts only verified terminal requests from the
  current run, groups them by mandate and creates or reuses real on-chain packets.
  The returned bundle is explicitly a UI aggregate, never a synthetic contract object.
- `POST /api/governance-execute` replaces the removed `/api/cosign`. It verifies a
  current owner-A EIP-712 signature, canonical allow-listed module calldata and the
  latest Safe nonce before owner B co-signs and broadcasts.

The disclosure request list is a real scope selector. Guided runs may create one
or more subsets; packet IDs and covered Request IDs accumulate, and the Auditor
handoff unlocks only after CloudNode, ShieldOps and Atlas Contractor are all
covered. Packets are still grouped by mandate and the displayed bundle remains a
UI aggregate rather than a fabricated contract object.

Policies expose the complete authority model without publishing privileged keys:
the connected Finance Admin may propose a new encrypted mandate or replacement
Draft and pause the module; a current Safe owner may activate, retire or resume
through 2-of-2 governance. Finance Admin rotation remains a managed Safe/deployment
operation outside the public automatic co-sign allowlist.

Every Safe operation shares one serialized nonce boundary from state revalidation
through receipt. The self-service `/api/provision` path remains idempotent per
address, daily-capped, protected by `PROVISION_ENABLED`, and CORS-locked to the app
origin. Finance-admin and both current Safe-owner secrets are never shipped in the
browser bundle; only intentionally low-power Delegate and snapshot-Auditor testnet
keys are public.

In production, set `DEMO_DECISION_JOURNAL_PATH` to a writable persistent volume.
The journal stores the first observed approval timestamp plus terminal decision
receipts, so the three-minute window and idempotent retries survive a provisioner
restart. The OS temporary-directory default is suitable only for local development.

## Security & trust model

VeilGuard provides **confidentiality, not anonymity**. Public by design:
addresses, recipients, timing, the three-state outcome and transaction hashes.
Encrypted: amounts, auto-limits, budgets, reserve floors and blocked reasons.

Confidentiality rests on the Nox protocol's TEE (Intel TDX remote attestation +
a KMS/Handle-Gateway that signs decryption proofs the chain verifies) — **not** a
zero-knowledge proof of the policy computation. The public outcome intentionally
leaks limited information (which of three states a request reached); exact limits,
balances and failure margins stay confidential. Probing is dampened by a
post-block cooldown, coarse (viewer-only) reasons, and one in-flight request per
mandate.

## Current limitations

- **Testnet prototype — not audited.** Do not use with real funds.
- **Nox ACL grants are irreversible.** `addViewer` / `allow` / public-decrypt
  cannot be revoked on-chain; audit disclosure is therefore modeled as an
  **immutable snapshot** (a fresh isolated handle), never a grant on live state.
- **Recipient addresses are public** in P0 (the allow-list is plaintext).
- **Escalation UX**: signers decrypt the amount in the VeilGuard view and confirm
  the escalated amount in the VeilGuard view; the official Safe UI does not decrypt Nox handles itself.
- The Sepolia Safe is **2-of-2**: activation and escalation decisions each require
  two distinct owner EIP-712 signatures, threshold 2. Guided-demo signatures are
  produced by the bounded server committee, not collected from separate humans via
  the Safe Transaction Service / Safe{Wallet} queue.
- The deployed v1 audit ABI always snapshots `autoLimit`, `budgetLeft` and
  `reserveFloor`, plus amount and reason for every selected request. The UI labels
  this fixed scope; per-field policy masking would require a new contract version.
- **Changing the Safe owner set does not revoke access already granted to historical
  handles** (Nox ACLs are irreversible). Propose a new policy version after owner rotation.
- Audit packets are **selective disclosure**, not a standalone compliance proof: v1
  discloses its three fixed policy snapshots plus selected request amounts and coarse
  reasons — verify the public
  request state and transaction hashes alongside them.

## License

MIT.
