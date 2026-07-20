import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/validate-release-resume.mjs', import.meta.url));
const deployments = JSON.parse(await readFile(new URL('../../app/src/deployments.json', import.meta.url), 'utf8'));
const tx = (character) => `0x${character.repeat(64)}`;

const approveEvidence = {
  schema: 'veilguard.live-release-evidence',
  version: 1,
  generatedAt: '2026-07-20T00:00:00.000Z',
  workflow: { repository: 'owner/repo', runId: '29724917533', sourceCommit: 'eab7a4bb7ea7' },
  production: { baseUrl: 'https://veilguard.axiqo.xyz', expectedUiSha: 'eab7a4b', observedUiSha: 'eab7a4b' },
  chain: {
    id: 11155111,
    network: 'ethereum-sepolia',
    module: deployments.contracts.VeilGuardModule,
    safe: deployments.contracts.Safe,
    safeThreshold: 2,
    safeOwnerCount: 2,
  },
  scenario: { name: 'ShieldOps', runId: 'launch-approve-1234', requestId: '44' },
  decision: {
    action: 'approve',
    origin: 'user',
    chainState: 2,
    transactionHash: tx('a'),
    etherscanUrl: `https://sepolia.etherscan.io/tx/${tx('a')}`,
  },
  transactions: {
    request: { hash: tx('b'), status: 'success' },
    teeFinalize: { hash: tx('c'), status: 'success', terminalEvent: 'EscalationReady' },
    safeDecision: {
      hash: tx('a'),
      status: 'success',
      outerTarget: deployments.contracts.Safe,
      moduleTarget: deployments.contracts.VeilGuardModule,
      moduleAction: 'executeEscalated',
      requestId: '44',
      operation: 0,
      signatureBytes: 130,
      signatureCount: 2,
      terminalEvent: 'EscalationExecuted',
      terminalEventCount: 1,
    },
  },
  attestation: {
    requestId: 44,
    chainState: 2,
    origin: 'user',
    action: 'approve',
    hash: tx('a'),
  },
};

test('resume accepts prior Approve and classifies a safe fresh or exact bound Reject recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'veilguard-release-resume-'));
  const manifestPath = join(directory, 'manifest.json');
  const recoveryPath = join(directory, 'recovery.json');
  const outputPath = join(directory, 'approve.json');
  const summaryPath = join(directory, 'resume.json');
  const githubOutputPath = join(directory, 'github-output.txt');
  const manifest = {
    schema: 'veilguard.production-release-manifest',
    version: 1,
    workflowRunId: '29724917533',
    sourceCommit: 'eab7a4bb7ea7',
    jobs: { approve: 'success', reject: 'failure' },
    actions: [
      { action: 'approve', evidence: approveEvidence },
      { action: 'reject', missing: true },
    ],
  };
  const recovery = {
    schema: 'veilguard.live-release-recovery',
    version: 1,
    workflow: { runId: '29724917533', sourceCommit: 'eab7a4bb7ea7' },
    scenario: { name: 'ShieldOps', runId: 'launch-reject-1234' },
    phase: 'run-started',
    decision: { action: 'reject' },
  };
  await Promise.all([
    writeFile(manifestPath, JSON.stringify(manifest)),
    writeFile(recoveryPath, JSON.stringify(recovery)),
  ]);
  const args = [script,
    '--manifest', manifestPath,
    '--recovery', recoveryPath,
    '--source-run', '29724917533',
    '--output', outputPath,
    '--summary', summaryPath,
    '--github-output', githubOutputPath,
  ];
  const accepted = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(await readFile(outputPath, 'utf8')).decision.transactionHash, tx('a'));
  assert.deepEqual(JSON.parse(await readFile(summaryPath, 'utf8')).rejectedAttempt, {
    runId: 'launch-reject-1234',
    phase: 'run-started',
    mode: 'fresh',
    decisionBroadcastObserved: false,
  });
  assert.match(await readFile(githubOutputPath, 'utf8'), /reject_mode=fresh/);

  recovery.activeBroadcast = { transactionHash: tx('d') };
  await writeFile(recoveryPath, JSON.stringify(recovery));
  const refusedBroadcast = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(refusedBroadcast.status, 0);
  assert.match(refusedBroadcast.stderr, /fresh recovery contains a request, broadcast or decision pointer/);

  recovery.activeBroadcast = {
    mission: 'approval',
    requestId: '45',
    transactionHash: tx('d'),
  };
  recovery.phase = 'request-bound';
  recovery.scenario.requestId = '45';
  await writeFile(recoveryPath, JSON.stringify(recovery));
  const acceptedBound = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(acceptedBound.status, 0, acceptedBound.stderr);
  assert.deepEqual(JSON.parse(await readFile(summaryPath, 'utf8')).rejectedAttempt, {
    runId: 'launch-reject-1234',
    phase: 'request-bound',
    mode: 'bound',
    requestId: '45',
    requestTransactionHash: tx('d'),
    decisionBroadcastObserved: false,
  });
  assert.match(await readFile(githubOutputPath, 'utf8'), /reject_mode=bound[\s\S]*reject_request_id=45[\s\S]*reject_request_tx=0xdddd/);

  recovery.activeBroadcast.requestId = '46';
  await writeFile(recoveryPath, JSON.stringify(recovery));
  const refusedMismatchedRequest = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(refusedMismatchedRequest.status, 0);
  assert.match(refusedMismatchedRequest.stderr, /bound recovery request broadcast/);

  recovery.activeBroadcast.requestId = '45';
  recovery.phase = 'decision-observed';
  recovery.decision.transactionHash = tx('e');
  recovery.attestation = {
    requestId: 45,
    chainState: 5,
    origin: 'timeout',
    action: 'reject',
    hash: tx('e'),
  };
  await writeFile(recoveryPath, JSON.stringify(recovery));
  const refusedTimeout = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(refusedTimeout.status, 0);
  assert.match(refusedTimeout.stderr, /observed decision attestation/);

  recovery.attestation.origin = 'user';
  await writeFile(recoveryPath, JSON.stringify(recovery));
  const acceptedObservedDecision = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(acceptedObservedDecision.status, 0, acceptedObservedDecision.stderr);
});
