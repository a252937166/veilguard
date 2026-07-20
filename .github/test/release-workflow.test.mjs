import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const releasePath = new URL('../workflows/production-release-gate.yml', import.meta.url);
const ciPath = new URL('../workflows/ci.yml', import.meta.url);
const playwrightPath = new URL('../../app/playwright.config.ts', import.meta.url);
const ordinaryE2ePath = new URL('../../app/test/e2e/operations-desk.spec.ts', import.meta.url);
const liveE2ePath = new URL('../../app/test/e2e/live-release-gate.spec.ts', import.meta.url);
const manifestScript = fileURLToPath(new URL('../scripts/build-release-manifest.mjs', import.meta.url));
const deployments = JSON.parse(await readFile(new URL('../../app/src/deployments.json', import.meta.url), 'utf8'));

test('manual release workflow is explicit, serialized, bounded, recoverable, and keyless', async () => {
  const [workflow, liveE2e] = await Promise.all([
    readFile(releasePath, 'utf8'),
    readFile(liveE2ePath, 'utf8'),
  ]);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /confirm_production:[\s\S]*?required: true[\s\S]*?type: boolean/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /concurrency:[\s\S]*?group: veilguard-production-release-gate[\s\S]*?cancel-in-progress: false/);
  assert.equal((workflow.match(/VEILGUARD_LIVE_ACTION:/g) ?? []).length, 2);
  assert.equal((workflow.match(/VEILGUARD_LIVE_ACTION: approve/g) ?? []).length, 1);
  assert.equal((workflow.match(/VEILGUARD_LIVE_ACTION: reject/g) ?? []).length, 1);
  assert.equal((workflow.match(/run: npx playwright test --project=live-sepolia/g) ?? []).length, 2);
  assert.equal((workflow.match(/timeout-minutes: 15/g) ?? []).length, 2);
  assert.equal((workflow.match(/retention-days: 90/g) ?? []).length, 3);
  assert.match(workflow, /actions\/download-artifact@v5/);
  assert.match(workflow, /live_reject:[\s\S]*?needs: live_approve/);
  assert.match(workflow, /Run all 17 Nox contract tests/);
  assert.match(workflow, /Validate and summarize both V1 evidence files/);
  assert.match(workflow, /app\/release-evidence\/approve\*\.json/);
  assert.match(workflow, /app\/release-evidence\/reject\*\.json/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /(?:SAFE|ADMIN|SIGNER)[A-Z0-9_]*_KEY/);
  assert.match(liveE2e, /veilguard\.live-release-recovery/);
  assert.match(liveE2e, /phase: 'request-bound'/);
  assert.match(liveE2e, /phase: 'decision-observed'/);
  assert.match(liveE2e, /finally\s*\{/);
});

test('ordinary CI never opts into the production action path', async () => {
  const ci = await readFile(ciPath, 'utf8');
  assert.doesNotMatch(ci, /VEILGUARD_LIVE_E2E|VEILGUARD_LIVE_ACTION|veilguard\.axiqo\.xyz/);
  assert.match(ci, /name: contract-tests \(advisory\)/);
  assert.doesNotMatch(ci, /actions\/(?:checkout|setup-node)@v4/);
  assert.match(ci, /actions\/checkout@v6/);
  assert.match(ci, /actions\/setup-node@v6/);
  assert.match(ci, /actions\/upload-artifact@v4/);
});

test('Playwright isolates live mutations to one non-retrying desktop project', async () => {
  const [config, ordinaryE2e] = await Promise.all([
    readFile(playwrightPath, 'utf8'),
    readFile(ordinaryE2ePath, 'utf8'),
  ]);
  assert.match(config, /testIgnore: isLiveRelease \? \[\] : \['\*\*\/live-release-gate\.spec\.ts'\]/);
  assert.match(config, /retries: isLiveRelease \? 0/);
  assert.match(config, /workers: isLiveRelease \? 1/);
  assert.equal((config.match(/name: 'live-sepolia'/g) ?? []).length, 1);
  assert.doesNotMatch(ordinaryE2e, /VEILGUARD_LIVE_E2E|live Sepolia release gate|demo-decision\?/);
});

test('release manifest accepts exactly one valid V1 artifact per Safe action', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'veilguard-release-manifest-'));
  const output = join(directory, 'manifest.json');
  const hash = (character) => `0x${character.repeat(64)}`;
  const evidence = (action, requestId, transactionHash) => ({
    schema: 'veilguard.live-release-evidence',
    version: 1,
    generatedAt: '2026-07-19T00:00:00.000Z',
    workflow: { sourceCommit: 'abcdef0' },
    production: { baseUrl: 'https://veilguard.axiqo.xyz', expectedUiSha: 'abcdef0', observedUiSha: 'abcdef0' },
    chain: {
      id: 11155111,
      network: 'ethereum-sepolia',
      module: deployments.contracts.VeilGuardModule,
      safe: deployments.contracts.Safe,
      safeThreshold: 2,
      safeOwnerCount: 2,
    },
    scenario: { name: 'ShieldOps', runId: `run-${action}-1234`, requestId },
    decision: {
      action,
      origin: 'user',
      chainState: action === 'approve' ? 2 : 5,
      transactionHash,
      etherscanUrl: `https://sepolia.etherscan.io/tx/${transactionHash}`,
    },
    transactions: {
      request: { hash: hash(action === 'approve' ? '3' : '4'), status: 'success', etherscanUrl: 'https://example.test/request' },
      teeFinalize: { hash: hash(action === 'approve' ? '5' : '6'), status: 'success', terminalEvent: 'EscalationReady', etherscanUrl: 'https://example.test/finalize' },
      safeDecision: {
        hash: transactionHash,
        status: 'success',
        blockNumber: '123',
        outerTarget: deployments.contracts.Safe,
        moduleTarget: deployments.contracts.VeilGuardModule,
        moduleAction: action === 'approve' ? 'executeEscalated' : 'cancelEscalated',
        requestId,
        operation: 0,
        signatureBytes: 130,
        signatureCount: 2,
        terminalEvent: action === 'approve' ? 'EscalationExecuted' : 'EscalationCancelled',
        terminalEventCount: 1,
        etherscanUrl: `https://sepolia.etherscan.io/tx/${transactionHash}`,
      },
    },
    attestation: {
      ok: true,
      requestId: Number(requestId),
      chainState: action === 'approve' ? 2 : 5,
      origin: 'user',
      action,
      hash: transactionHash,
    },
  });

  try {
    await Promise.all([
      writeFile(join(directory, 'approve.json'), JSON.stringify(evidence('approve', '41', hash('a')))),
      writeFile(join(directory, 'reject.json'), JSON.stringify(evidence('reject', '42', hash('b')))),
    ]);
    const result = spawnSync(process.execPath, [manifestScript, '--input', directory, '--output', output], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_CONFIRMATION_RESULT: 'success',
        RELEASE_NOX_RESULT: 'success',
        RELEASE_APPROVE_RESULT: 'success',
        RELEASE_REJECT_RESULT: 'success',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(manifest.passed, true);
    assert.deepEqual(manifest.actions.map((item) => item.action), ['approve', 'reject']);

    await rm(join(directory, 'reject.json'));
    const incomplete = spawnSync(process.execPath, [manifestScript, '--input', directory, '--output', output], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_CONFIRMATION_RESULT: 'success',
        RELEASE_NOX_RESULT: 'success',
        RELEASE_APPROVE_RESULT: 'success',
        RELEASE_REJECT_RESULT: 'success',
      },
    });
    assert.notEqual(incomplete.status, 0);
    const failedManifest = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(failedManifest.passed, false);
    assert.ok(failedManifest.errors.includes('missing reject evidence'));

    await writeFile(join(directory, 'reject.json'), JSON.stringify(evidence('reject', '42', hash('b'))));
    await writeFile(join(directory, 'approve-copy.json'), JSON.stringify(evidence('approve', '43', hash('c'))));
    const duplicate = spawnSync(process.execPath, [manifestScript, '--input', directory, '--output', output], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_CONFIRMATION_RESULT: 'success',
        RELEASE_NOX_RESULT: 'success',
        RELEASE_APPROVE_RESULT: 'success',
        RELEASE_REJECT_RESULT: 'success',
      },
    });
    assert.notEqual(duplicate.status, 0);
    const duplicateManifest = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(duplicateManifest.errors.includes('multiple approve evidence files (2)'));

    await rm(join(directory, 'approve-copy.json'));
    const contradictory = evidence('approve', '41', hash('a'));
    contradictory.decision.chainState = 5;
    contradictory.attestation.chainState = 5;
    contradictory.transactions.safeDecision.moduleAction = 'cancelEscalated';
    contradictory.transactions.safeDecision.terminalEvent = 'EscalationCancelled';
    await writeFile(join(directory, 'approve.json'), JSON.stringify(contradictory));
    const semanticFailure = spawnSync(process.execPath, [manifestScript, '--input', directory, '--output', output], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_CONFIRMATION_RESULT: 'success',
        RELEASE_NOX_RESULT: 'success',
        RELEASE_APPROVE_RESULT: 'success',
        RELEASE_REJECT_RESULT: 'success',
      },
    });
    assert.notEqual(semanticFailure.status, 0);
    const semanticManifest = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(semanticManifest.errors.some((error) => /decision\.chainState|Safe calldata\/event/.test(error)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
