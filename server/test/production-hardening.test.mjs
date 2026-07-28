import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../provisioner.mjs', import.meta.url), 'utf8');
const treasurySource = await readFile(new URL('../lib/treasury-readiness.mjs', import.meta.url), 'utf8');
const rateSource = await readFile(new URL('../lib/sponsored-rate-limit.mjs', import.meta.url), 'utf8');
const noxSource = await readFile(new URL('../lib/nox-production.mjs', import.meta.url), 'utf8');
const keeperSource = await readFile(new URL('../../scripts/keeper.ts', import.meta.url), 'utf8');
const rotationSource = await readFile(new URL('../rotate-admin.mjs', import.meta.url), 'utf8');

test('self-service provision is opt-in and challenge verification precedes all address work', () => {
  assert.match(source, /PROVISION_ENABLED = 'false'/);
  assert.match(source, /defaultEnabled: false/);
  assert.match(source, /req\.url === '\/api\/provision-challenge'/);

  const route = source.slice(source.indexOf("req.url === '/api/provision'"));
  const verification = route.indexOf('await provisionChallenges.verify');
  const existingLookup = route.indexOf('await existingActiveMandate');
  const provisioning = route.indexOf('await provision(address)');
  assert.ok(verification > 0);
  assert.ok(verification < existingLookup);
  assert.ok(verification < provisioning);
});

test('every new mandate is gated by treasury funding before proposal and activation', () => {
  assert.match(source, /const minimumTreasuryTopupRaw = POLICY\.budget \+ POLICY\.reserve/);
  assert.match(source, /policyRefreshGuarded: true/);
  assert.match(treasurySource, /liveBalanceObserved: false/);

  const refreshStart = source.indexOf('async function refreshDemoMandateIfDrained');
  const provisionStart = source.indexOf('async function provision');
  const readinessStart = source.indexOf('async function demoReady');
  const refresh = source.slice(refreshStart, provisionStart);
  const provision = source.slice(provisionStart, readinessStart);

  assert.ok(refresh.indexOf('await fundDemoTreasury()') < refresh.indexOf('await adminProposeMandate'));
  assert.ok(refresh.indexOf('await adminProposeMandate') < refresh.indexOf('await safeExec2of2'));
  assert.ok(refresh.indexOf('await safeExec2of2') < refresh.indexOf('await treasuryReadiness.record'));

  assert.ok(provision.indexOf('await fundDemoTreasury()') < provision.indexOf('await adminProposeMandate'));
  assert.ok(provision.indexOf('await adminProposeMandate') < provision.indexOf('await safeExec2of2'));
  assert.ok(provision.indexOf('await safeExec2of2') < provision.indexOf('await treasuryReadiness.record'));
});

test('provisioner clients share the guarded fallback rather than a single raw HTTP transport', () => {
  assert.match(source, /parseRpcUrls\(\s*RPC_URL,\s*RPC_FALLBACK_URLS,/);
  assert.match(source, /createGuardedRpcFallback/);
  assert.doesNotMatch(source, /transport:\s*viemHttp\(RPC_URL\)/);
  assert.match(source, /rpc: rpc\.status\(\)/);
  assert.match(keeperSource, /createGuardedRpcFallback/);
  assert.match(rotationSource, /createGuardedRpcFallback/);
  assert.doesNotMatch(keeperSource, /transport:\s*http\(RPC\)/);
  assert.doesNotMatch(rotationSource, /transport:\s*viemHttp\(RPC_URL\)/);
});

test('sponsored provisioning quota is domain-bound, mode-0600 and consumed before writes', () => {
  assert.match(rateSource, /mode: 0o600/);
  assert.match(rateSource, /chainId/);
  assert.match(rateSource, /module/);
  assert.match(rateSource, /safe/);
  assert.match(source, /PROVISION_RATE_JOURNAL_PATH/);
  assert.match(source, /DEMO_AUDIT_RATE_JOURNAL_PATH/);

  const route = source.slice(source.indexOf("req.url === '/api/provision'"));
  const consume = route.indexOf('await provisionRateLimits.consume(address)');
  const provision = route.indexOf('await provision(address)');
  assert.ok(consume > 0);
  assert.ok(consume < provision);
  assert.doesNotMatch(route, /lastByAddr|dayStart\s*=|dayCount\+\+/);
});

test('exhausted persistent quota closes health and challenge before wallet signing', () => {
  const health = source.slice(
    source.indexOf("req.url === '/api/health'"),
    source.indexOf("req.url === '/api/cosign'"),
  );
  assert.match(health, /provisionRateStatus\.remainingToday > 0/);

  const challenge = source.slice(
    source.indexOf("req.url === '/api/provision-challenge'"),
    source.indexOf("req.url === '/api/provision'"),
  );
  assert.ok(challenge.indexOf('provisionRateLimits.status()') < challenge.indexOf('provisionChallenges.issue'));
  assert.match(challenge, /rateStatus\.remainingToday <= 0/);
  assert.match(challenge, /return json\(res, 429/);
});

test('production Nox paths retry resolved-to-usable reads and exact estimates only', () => {
  assert.match(noxSource, /resolveThenRetryNoxRead/);
  assert.match(noxSource, /waitForNoxHandlesResolved/);
  assert.match(source, /resolveThenRetryNoxRead\(\{/);
  assert.match(keeperSource, /resolveThenRetryNoxRead\(\{/);

  const proposal = source.slice(
    source.indexOf('const adminProposeMandate'),
    source.indexOf('let handleClient'),
  );
  assert.ok(proposal.indexOf('waitUntilNoxSimulatable') < proposal.indexOf('adminWallet.writeContract'));
  assert.match(proposal, /pub\.estimateContractGas\(\{ \.\.\.params, account: admin \}\)/);
  assert.match(keeperSource, /waitUntilNoxSimulatable/);
  assert.match(keeperSource, /publicClient\.estimateContractGas/);
});

test('new mandate and audit packet IDs are derived from their unique receipt events', () => {
  const proposal = source.slice(
    source.indexOf('const adminProposeMandate'),
    source.indexOf('let handleClient'),
  );
  assert.doesNotMatch(proposal, /nextMandateId/);
  assert.match(proposal, /eventName: 'MandateProposed'/);
  assert.ok(proposal.indexOf('waitForTransactionReceipt') < proposal.indexOf('event\.args\.mandateId'));

  const audit = source.slice(
    source.indexOf('async function createOrReuseAuditPacket'),
    source.indexOf('async function performDemoAuditPacket'),
  );
  assert.doesNotMatch(audit, /functionName: 'nextPacketId'/);
  assert.match(audit, /eventName: 'AuditPacketCreated'/);
  assert.ok(audit.indexOf('waitForTransactionReceipt') < audit.indexOf('event\.args\.packetId'));
});
