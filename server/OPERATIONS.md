# Provisioner production controls

The provisioner is fail-closed by default. Starting the process without extra
configuration keeps the shared read/finalize/demo APIs available, but:

- `POST /api/provision-challenge` and `POST /api/provision` return `503`;
- the demo watchdog does not create or refresh a mandate whose confidential
  budget is not backed by an explicit Safe treasury top-up;
- the demo watchdog does not transfer Sepolia ETH to a low-balance Delegate;
- `/api/health` reports these controls independently.

## Self-service provisioning

Self-service provisioning is enabled only by the exact value:

```text
PROVISION_ENABLED=true
```

Even when enabled, a caller must first request `POST
/api/provision-challenge` with its wallet address, sign the returned EIP-712
`Provision` payload, and include `address`, `challengeId` and `signature` in
`POST /api/provision`. Challenges are address-bound, expire after five minutes
by default, and are consumed before signature recovery so two concurrent
requests cannot reuse one nonce. A process restart invalidates every outstanding
challenge.

`PROVISION_CHALLENGE_TTL_MS` may be set between 60,000 and 900,000
milliseconds. The existing per-address and daily caps remain defense-in-depth;
they are not substitutes for wallet ownership.

The rate limits are restart-persistent and consume quota before any treasury,
Nox or chain write. Configure durable, service-user-writable paths:

```text
PROVISION_RATE_JOURNAL_PATH=/var/lib/veilguard/provision-rate.json
DEMO_AUDIT_RATE_JOURNAL_PATH=/var/lib/veilguard/audit-rate.json
```

Both journals are atomically replaced with mode `0600` and bound to their
purpose, chain id, module and Safe. A malformed or wrong-domain journal stops
startup instead of resetting quota. Provisioning uses a rolling 24-hour global
cap plus a one-hour per-address window; audit packet sponsorship also retains
its rolling daily cap across restart. Attempts are charged before broadcasting,
so a crash or ambiguous RPC response cannot reopen sponsored gas budget. Run
only one provisioner writer per journal path.

## Treasury readiness gate

Budget refresh is not treasury funding. The watchdog now refuses to activate a
new 300 cUSDC demo budget unless test assets were first wrapped into the Safe.
Enable this explicit testnet operation with:

```text
DEMO_TREASURY_TOPUP_ENABLED=true
DEMO_TREASURY_TOPUP_USDC=400
TEST_USDC=<underlying test token>
CONFIDENTIAL_USDC=<deployed wrapper>
TREASURY_READINESS_JOURNAL_PATH=/var/lib/veilguard/treasury-readiness.json
```

The configured amount must cover at least `budget + reserveFloor` (currently
400 cUSDC). Each refresh performs `faucet → approve → wrap(Safe)` under the
admin transaction lock, then proposes and activates the unchanged encrypted
policy. Only after activation is the exact mandate/top-up pair recorded in the
mode-`0600` journal. Demo readiness requires that exact record.

This is a funding invariant, not a confidential-balance oracle. The provisioner
does not claim to observe the Safe's current plaintext cUSDC balance, and an
out-of-band Safe withdrawal can invalidate the invariant. Production operators
must restrict such withdrawals or add a Safe-approved disclosure/monitoring
mechanism. The health response therefore reports
`treasury.liveBalanceObserved=false`.

Native-gas sponsorship is a separate operation and remains disabled unless it
is enabled exactly:

```text
DEMO_GAS_TOPUP_ENABLED=true
```

When disabled, `/api/demo-ready` reports a low-gas Delegate as unavailable and
does not schedule an Admin transfer. This switch is independent from treasury
asset top-up and from `SWEEP_ENABLED`.

## RPC fallback and broadcast safety

Configure independent providers with:

```text
RPC_URL=<primary>
RPC_FALLBACK_URLS=<fallback-1>,<fallback-2>
```

Read-only JSON-RPC calls use ordered fallback. Before a write, each candidate is
checked for the expected Sepolia chain id. The already signed transaction is
then sent to one selected endpoint exactly once. If that response is ambiguous,
the provider is quarantined and the error carries the locally derivable
transaction hash; the transport does not replay the payload through another
provider. Receipt and state reads continue through the read fallback.

The same guarded transport is used by the provisioner, the keeper and the
one-shot admin-rotation script. `/api/health` exposes endpoint counts,
quarantine count and `broadcastStrategy=single-endpoint-no-retry`, never RPC
URLs or credentials.

## Nox propagation and transaction attribution

`resolved=true` is treated as a prerequisite, not proof that a downstream Nox
read is already usable. The provisioner and standalone keeper share the same
bounded `resolved → publicDecrypt usable` retry. Fresh external encrypted inputs
are never proposed immediately: the exact `proposeMandate` calldata is retried
through read-only `eth_estimateGas`, and only the successful estimate opens one
broadcast attempt. Finalize and audit-packet Nox calls use the same exact
read-only barrier. These retries never contain `eth_sendRawTransaction` and do
not weaken the single-broadcast RPC rule.

Contract-assigned mandate and audit packet IDs come only from the unique
`MandateProposed` or `AuditPacketCreated` event in that transaction's successful
receipt. Pre-reading `nextMandateId` or `nextPacketId` is not accepted as write
attribution.

## Health fields

Important readiness fields are:

```text
provision.enabled
provision.operational
provision.required
provision.rateLimit.persistent
provision.rateLimit.dailyCount
treasury.topupEnabled
treasury.gasTopupEnabled
treasury.policyRefreshGuarded
treasury.recordedMandates
treasury.liveBalanceObserved
rpc.fallbackConfigured
rpc.broadcastStrategy
rpc.quarantinedEndpoints
auditRateLimit.persistent
```

`ok=true` means the HTTP process is alive. It does not override a false
provision or treasury readiness field.
