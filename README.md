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
| `APPROVAL REQUIRED` | Above the auto-limit — a real Safe multisig proposal is required |
| `BLOCKED` | Policy violated — no funds move; the coarse reason stays private to the delegate & admin |

Exact limits, remaining budgets, thresholds and amounts are **never** revealed on-chain.
Auditors receive **scoped, immutable disclosure snapshots** — not live state.

**Live on Ethereum Sepolia** · dApp: **https://veilguard.axiqo.xyz**

## Live deployment (Ethereum Sepolia)

| Contract | Address |
| --- | --- |
| VeilGuardModule | [`0x02e9b09f5929604b101244661835605b1ee67fea`](https://sepolia.etherscan.io/address/0x02e9b09f5929604b101244661835605b1ee67fea) |
| Safe (v1.4.1, **2-of-2**, module enabled) | [`0x22Ab88236b21D4A528251474b05f5045c6e71e99`](https://sepolia.etherscan.io/address/0x22Ab88236b21D4A528251474b05f5045c6e71e99) |
| cUSDC (ERC-7984 wrapper) | [`0x71ac9a2872048f78dc3d627c6fe7f3b2f35467b3`](https://sepolia.etherscan.io/address/0x71ac9a2872048f78dc3d627c6fe7f3b2f35467b3) |
| TestUSDC (public faucet ERC-20) | [`0x94c426eb57f5bb3fa9dfdbbbe7ae1efb2cb958ab`](https://sepolia.etherscan.io/address/0x94c426eb57f5bb3fa9dfdbbbe7ae1efb2cb958ab) |
| Nox NoxCompute (protocol) | [`0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF`](https://sepolia.etherscan.io/address/0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF) |

Full addresses & roles: [`deployments.json`](./deployments.json).

## On-chain evidence

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
app/                         React + viem + Nox SDK dApp (5 role views)
feedback.md                  developer feedback on the Nox tooling
```

## Development

Prerequisites: Node.js ≥ 22, Docker running (the plugin boots the Nox off-chain
stack locally).

```sh
npm install
npx hardhat test "$PWD/test/00-stack.test.ts" \
                 "$PWD/test/10-veilguard-flows.test.ts" \
                 "$PWD/test/20-audit-isolation.test.ts"   # 10 tests on the local Nox off-chain stack
```

> Pass **absolute** test paths — `hardhat test` with a relative path can misresolve
> against `node_modules/@iexec-nox/handle` when the suite imports the handle SDK.

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
npm run build                             # → app/dist (static SPA)
```

### Keeper (optional availability helper)

```sh
npx hardhat run scripts/keeper.ts --network sepolia          # one-shot sweep
KEEPER_LOOP=1 npx hardhat run scripts/keeper.ts --network sepolia   # loop
```
Systemd/cron templates: [`scripts/keeper.service.example`](./scripts/keeper.service.example).

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
  the matching proposal in the Safe interface; the official Safe UI does not
  decrypt Nox handles itself.
- The Sepolia Safe is **2-of-2**: activation and escalation approval each require
  two distinct owner signatures (Protocol Kit, driven by `scripts/final-evidence.ts`).
- **Changing the Safe owner set does not revoke access already granted to historical
  handles** (Nox ACLs are irreversible). Propose a new policy version after owner rotation.
- Audit packets are **selective disclosure**, not a standalone compliance proof: they
  disclose chosen policy values, request amounts and coarse reasons — verify the public
  request state and transaction hashes alongside them.

## License

MIT.
