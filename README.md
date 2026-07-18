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
| VeilGuardModule | [`0xaf1ca44d1c83bb800f2e791ab299bb0ad1a568cb`](https://sepolia.etherscan.io/address/0xaf1ca44d1c83bb800f2e791ab299bb0ad1a568cb) |
| Safe (v1.4.1, module enabled) | [`0x22Ab88236b21D4A528251474b05f5045c6e71e99`](https://sepolia.etherscan.io/address/0x22Ab88236b21D4A528251474b05f5045c6e71e99) |
| cUSDC (ERC-7984 wrapper) | [`0x71ac9a2872048f78dc3d627c6fe7f3b2f35467b3`](https://sepolia.etherscan.io/address/0x71ac9a2872048f78dc3d627c6fe7f3b2f35467b3) |
| TestUSDC (public faucet ERC-20) | [`0x94c426eb57f5bb3fa9dfdbbbe7ae1efb2cb958ab`](https://sepolia.etherscan.io/address/0x94c426eb57f5bb3fa9dfdbbbe7ae1efb2cb958ab) |
| Nox NoxCompute (protocol) | [`0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF`](https://sepolia.etherscan.io/address/0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF) |

Full addresses & roles: [`deployments.json`](./deployments.json).

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
                 "$PWD/test/20-audit-isolation.test.ts"   # 10 tests, real TEE
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
- The Sepolia Safe uses threshold 1 for demo convenience — raise it in the Safe
  for real multi-party approval.

## License

MIT.
