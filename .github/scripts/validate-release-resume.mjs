import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validateReleaseEvidence } from './release-evidence-validation.mjs';

const args = process.argv.slice(2);
const requiredArg = (name) => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const manifestPath = resolve(requiredArg('--manifest'));
const recoveryPath = resolve(requiredArg('--recovery'));
const outputPath = resolve(requiredArg('--output'));
const summaryPath = resolve(requiredArg('--summary'));
const githubOutputPath = args.includes('--github-output')
  ? resolve(requiredArg('--github-output'))
  : undefined;
const sourceRunId = requiredArg('--source-run');
if (!/^\d{6,20}$/.test(sourceRunId)) throw new Error('source run id must be numeric');

const [manifest, recovery] = await Promise.all([
  readFile(manifestPath, 'utf8').then(JSON.parse),
  readFile(recoveryPath, 'utf8').then(JSON.parse),
]);
const errors = [];
if (manifest?.schema !== 'veilguard.production-release-manifest' || manifest?.version !== 1) errors.push('manifest schema/version');
if (String(manifest?.workflowRunId) !== sourceRunId) errors.push('manifest run id');
if (manifest?.jobs?.approve !== 'success' || manifest?.jobs?.reject !== 'failure') errors.push('prior job results');
const approveActions = Array.isArray(manifest?.actions)
  ? manifest.actions.filter((item) => item?.action === 'approve' && item?.evidence)
  : [];
const rejectActions = Array.isArray(manifest?.actions)
  ? manifest.actions.filter((item) => item?.action === 'reject')
  : [];
if (approveActions.length !== 1) errors.push('exactly one prior Approve evidence is required');
if (rejectActions.length !== 1 || rejectActions[0]?.missing !== true || rejectActions[0]?.evidence) {
  errors.push('prior manifest must contain one missing Reject');
}
const approveEvidence = approveActions[0]?.evidence;
if (approveEvidence) errors.push(...validateReleaseEvidence(approveEvidence).map((error) => `approve ${error}`));
if (String(approveEvidence?.workflow?.runId) !== sourceRunId) errors.push('approve workflow run id');

if (recovery?.schema !== 'veilguard.live-release-recovery' || recovery?.version !== 1) errors.push('recovery schema/version');
if (String(recovery?.workflow?.runId) !== sourceRunId) errors.push('recovery run id');
if (recovery?.workflow?.sourceCommit !== manifest?.sourceCommit) errors.push('recovery source commit');
if (recovery?.scenario?.name !== 'ShieldOps' || !recovery?.scenario?.runId) errors.push('recovery scenario');
if (recovery?.decision?.action !== 'reject') errors.push('recovery action');
const requestId = String(recovery?.scenario?.requestId ?? '');
const requestBroadcast = recovery?.activeBroadcast;
const decisionHash = recovery?.decision?.transactionHash;
const attestation = recovery?.attestation;
let rejectMode;
if (recovery?.phase === 'run-started') {
  rejectMode = 'fresh';
  if (requestId || requestBroadcast || decisionHash || attestation) {
    errors.push('fresh recovery contains a request, broadcast or decision pointer');
  }
} else if (recovery?.phase === 'request-bound' || recovery?.phase === 'decision-observed') {
  rejectMode = 'bound';
  if (!/^\d{1,9}$/.test(requestId)) errors.push('bound recovery request id');
  if (requestBroadcast?.mission !== 'approval'
    || String(requestBroadcast?.requestId) !== requestId
    || !/^0x[0-9a-f]{64}$/i.test(requestBroadcast?.transactionHash ?? '')) {
    errors.push('bound recovery request broadcast');
  }
  if (recovery.phase === 'request-bound' && (decisionHash || attestation)) {
    errors.push('request-bound recovery contains a decision pointer');
  }
  if (recovery.phase === 'decision-observed') {
    if (!/^0x[0-9a-f]{64}$/i.test(decisionHash ?? '')) errors.push('observed decision transaction hash');
    if (attestation?.origin !== 'user'
      || attestation?.action !== 'reject'
      || attestation?.chainState !== 5
      || String(attestation?.requestId) !== requestId
      || attestation?.hash?.toLowerCase() !== decisionHash?.toLowerCase()) {
      errors.push('observed decision attestation');
    }
  }
} else {
  errors.push('recovery phase must be run-started, request-bound or decision-observed');
}
if (errors.length) throw new Error(`release resume refused: ${errors.join(', ')}`);

await Promise.all([
  mkdir(dirname(outputPath), { recursive: true }),
  mkdir(dirname(summaryPath), { recursive: true }),
]);
await Promise.all([
  writeFile(outputPath, `${JSON.stringify(approveEvidence, null, 2)}\n`, 'utf8'),
  writeFile(summaryPath, `${JSON.stringify({
    schema: 'veilguard.production-release-resume',
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceRunId,
    sourceCommit: manifest.sourceCommit,
    approve: {
      requestId: approveEvidence.scenario.requestId,
      transactionHash: approveEvidence.decision.transactionHash,
    },
    rejectedAttempt: {
      runId: recovery.scenario.runId,
      phase: recovery.phase,
      mode: rejectMode,
      requestId: requestId || undefined,
      requestTransactionHash: requestBroadcast?.transactionHash,
      decisionBroadcastObserved: !!decisionHash,
    },
  }, null, 2)}\n`, 'utf8'),
]);
if (githubOutputPath) {
  await appendFile(githubOutputPath, [
    `reject_mode=${rejectMode}`,
    `reject_run_id=${recovery.scenario.runId}`,
    `reject_request_id=${requestId}`,
    `reject_request_tx=${requestBroadcast?.transactionHash ?? ''}`,
    '',
  ].join('\n'), 'utf8');
}
