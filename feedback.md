# iExec Nox — Developer Feedback (WTF!! Hackathon Summer Edition)

Running log of friction points, surprises and suggestions collected while
building **VeilGuard** (confidential spending policies for Safe treasuries).
Collected honestly as they happened, newest at the bottom.

## Docs & onboarding

1. **Dead starter link on the hackathon page.** The hackathon brief links to
   `github.com/iExec-Nox/nox-hardhat-starter`, which returns 404 (repository
   removed or renamed). The Hardhat guide in the docs is complete enough to
   scaffold by hand, but a working starter link would save every team's first
   hour. (2026-07-17)
2. **`llms-full.txt` is excellent.** Having the whole documentation as a single
   markdown dump (and `.md` suffix per page) made it trivial to load the full
   context into an AI assistant and verify design assumptions against exact
   wording. More protocols should do this. (2026-07-17)
3. **`Nox.allow` naming is a foot-gun.** `allow(handle, account)` grants a
   permanent, irrevocable *admin* role (compute + permission management), while
   `addViewer` is the read-only grant. The Hello World tutorial itself uses
   `Nox.allow(balance, owner)` for a human owner, which teaches the wrong
   default for multi-role apps. Suggest renaming to `allowAdmin` or making the
   tutorial use `addViewer` with a call-out box. (2026-07-17)

## Tooling & local stack

4. **`Nox.publicDecrypt(handle, proof)` exists in the Solidity SDK but is
   missing from the docs.** The Solidity Library reference lists comparisons,
   select, safe arithmetic and ACL — but not the on-chain decryption-proof
   verification helpers (`publicDecrypt` overloads calling
   `NoxCompute.validateDecryptionProof`). We only found them by reading the
   npm package source. They are exactly what a request/finalize dApp needs —
   please document them. (2026-07-17)
5. **The hackathon brief's suggested-target docs and the published npm package
   disagree on the local NoxCompute address.** GitHub `main` of
   `nox-protocol-contracts` hardcodes chain 31337 →
   `0xc8D2c0Df…`, while the published npm 0.2.4 (and the hardhat plugin's
   etched address) use `0x75C6AF44…`. Pin your reading to the npm release.
   (2026-07-17)
6. **Local-stack images are Docker-Hub-only, which is painful behind
   restricted networks.** The seven images (`iexechub/nox-*`, minio, nats)
   have no mirror on ghcr/quay; developers behind DockerHub-blocked networks
   must hand-mirror them. A ghcr.io mirror or an offline bundle would help.
   (2026-07-17)

## Handle SDK

7. **Bug: the viem adapter derives the actor identity from
   `getAddresses()[0]`, ignoring `walletClient.account`.**
   `ViemBlockchainService.getAddress()` returns the node's first account, while
   `signTypedData` signs with `walletClient.account`. On any multi-account
   node (Hardhat!) a client built for account N silently encrypts inputs
   **owned by account 0** (later reverting `Owner mismatch` in
   `fromExternal`) and produces decrypt authorizations whose claimed address
   and signature disagree (gateway `401 invalid signature`). Workaround we
   used: monkey-patch `getAddresses` to return `[walletClient.account.address]`.
   Suggested fix: prefer `walletClient.account` when present. (2026-07-17)
8. **Test-runner sharp edge:** `hardhat test <relative-path>` intermittently
   resolves the test file against the last-loaded package directory
   (`ERR_MODULE_NOT_FOUND` under `node_modules/@iexec-nox/handle/`) when the
   suite imports `@iexec-nox/handle` directly. Passing an **absolute** test
   file path is a reliable workaround. Likely a tsx/parent-URL interaction in
   the plugin's test override rather than Nox logic. (2026-07-17)

## Resolved during development (answers other builders will want)

- **Cross-contract ACL on ERC-7984 balance handles: supported and elegant.**
  ERC-7984 grants holders admin on their own balance handles (`Nox.allow` in
  `_update`), so a Safe can lend a module one-transaction compute access via
  `execTransactionFromModule → NoxCompute.allowTransient(handle, module)`.
  Verified end-to-end on the local stack (our Gate 1). Worth documenting as a
  pattern — it is what makes policy modules over confidential treasuries work.
- **On-chain decryption-proof verification exists**: `Nox.publicDecrypt(handle,
  proof)` (see docs feedback #4) — no hand-rolled verification needed.
- **Local-stack policy-graph latency is excellent**: our full request pipeline
  (2× safeSub, ge, le, 7 selects, an ERC-7984 escrow transfer and a public
  decryption) resolves in well under a second locally; whole 7-test lifecycle
  suite ≈ 4s.
- **Sepolia testnet latency (first real measurements, 2026-07-18)**: wrap
  balance handle resolved in **2.6–2.8s**; the full requestSpend policy graph
  resolved in **5.4s**; 3× `encryptInput` via the public gateway in 1.5s.
  Entirely demo-friendly — great work on the runner throughput. (Single-run
  numbers, not percentiles.)
- **`createViemHandleClient` returns a Promise** — easy to miss since the
  ethers/viem factory naming suggests a sync constructor; a lint-friendly
  `await`-required note in the docs would help.
