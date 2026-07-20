import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
if (recovery?.phase !== 'run-started') errors.push('recovery must prove the Reject path never bound a request');
if (recovery?.decision?.action !== 'reject') errors.push('recovery action');
if (recovery?.scenario?.requestId || recovery?.activeBroadcast || recovery?.decision?.transactionHash || recovery?.attestation) {
  errors.push('recovery contains a request, broadcast or decision pointer');
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
      broadcastObserved: false,
    },
  }, null, 2)}\n`, 'utf8'),
]);
