import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const inputDirectory = resolve(arg('--input', '.release-artifacts'));
const outputPath = resolve(arg('--output', 'release-manifest.json'));
const deployments = JSON.parse(await readFile(new URL('../../app/src/deployments.json', import.meta.url), 'utf8'));
const canonicalModule = deployments.contracts.VeilGuardModule.toLowerCase();
const canonicalSafe = deployments.contracts.Safe.toLowerCase();

async function findJsonFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? findJsonFiles(path) : Promise.resolve(entry.name.endsWith('.json') ? [path] : []);
  }));
  return nested.flat();
}

function validateEvidence(value) {
  const errors = [];
  const action = value?.decision?.action;
  const semantics = action === 'approve'
    ? { state: 2, moduleAction: 'executeEscalated', terminalEvent: 'EscalationExecuted' }
    : action === 'reject'
      ? { state: 5, moduleAction: 'cancelEscalated', terminalEvent: 'EscalationCancelled' }
      : null;
  const sameHex = (left, right) => typeof left === 'string'
    && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
  if (value?.schema !== 'veilguard.live-release-evidence' || value?.version !== 1) errors.push('schema/version');
  if (!semantics) errors.push('decision.action');
  if (value?.decision?.origin !== 'user') errors.push('decision.origin');
  if (semantics && value?.decision?.chainState !== semantics.state) errors.push('decision.chainState');
  if (value?.chain?.id !== 11155111
    || value?.chain?.network !== 'ethereum-sepolia'
    || value?.chain?.safeThreshold !== 2
    || value?.chain?.safeOwnerCount !== 2) errors.push('chain/Safe');
  if (value?.chain?.module?.toLowerCase?.() !== canonicalModule
    || value?.chain?.safe?.toLowerCase?.() !== canonicalSafe) errors.push('canonical deployment');
  if (value?.scenario?.name !== 'ShieldOps') errors.push('scenario.name');
  if (!/^0x[0-9a-f]{64}$/i.test(value?.decision?.transactionHash ?? '')) errors.push('decision hash');
  if (!sameHex(value?.attestation?.hash, value?.decision?.transactionHash)
    || value?.attestation?.action !== value?.decision?.action
    || value?.attestation?.origin !== 'user'
    || value?.attestation?.chainState !== semantics?.state
    || String(value?.attestation?.requestId) !== value?.scenario?.requestId) errors.push('attestation');
  const safeTx = value?.transactions?.safeDecision;
  if (!sameHex(safeTx?.hash, value?.decision?.transactionHash) || safeTx?.status !== 'success') errors.push('Safe receipt');
  if (safeTx?.outerTarget?.toLowerCase?.() !== value?.chain?.safe?.toLowerCase?.()
    || safeTx?.moduleTarget?.toLowerCase?.() !== value?.chain?.module?.toLowerCase?.()) errors.push('Safe targets');
  if (safeTx?.requestId !== value?.scenario?.requestId
    || safeTx?.moduleAction !== semantics?.moduleAction
    || safeTx?.terminalEvent !== semantics?.terminalEvent
    || safeTx?.operation !== 0
    || safeTx?.signatureBytes !== 130
    || safeTx?.signatureCount !== 2
    || safeTx?.terminalEventCount !== 1) errors.push('Safe calldata/event');
  if (value?.transactions?.request?.status !== 'success'
    || value?.transactions?.teeFinalize?.status !== 'success'
    || value?.transactions?.teeFinalize?.terminalEvent !== 'EscalationReady') errors.push('request/finalize receipts');
  if (!value?.production?.expectedUiSha
    || value.production.expectedUiSha !== value.production.observedUiSha
    || !String(value?.workflow?.sourceCommit ?? '').startsWith(value.production.expectedUiSha)) errors.push('production UI SHA');
  return errors;
}

const evidence = [];
const parseErrors = [];
for (const file of await findJsonFiles(inputDirectory)) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed?.schema !== 'veilguard.live-release-evidence') continue;
    const errors = validateEvidence(parsed);
    if (errors.length) parseErrors.push(`${file}: ${errors.join(', ')}`);
    else evidence.push(parsed);
  } catch (error) {
    parseErrors.push(`${file}: ${error.message}`);
  }
}

const actionEvidence = {
  approve: evidence.filter((item) => item.decision.action === 'approve'),
  reject: evidence.filter((item) => item.decision.action === 'reject'),
};
const byAction = {
  approve: actionEvidence.approve[0],
  reject: actionEvidence.reject[0],
};
const jobResults = {
  confirmation: process.env.RELEASE_CONFIRMATION_RESULT ?? 'unknown',
  nox: process.env.RELEASE_NOX_RESULT ?? 'unknown',
  approve: process.env.RELEASE_APPROVE_RESULT ?? 'unknown',
  reject: process.env.RELEASE_REJECT_RESULT ?? 'unknown',
};
const evidenceErrors = [
  ...parseErrors,
  ...(!byAction.approve ? ['missing approve evidence'] : []),
  ...(!byAction.reject ? ['missing reject evidence'] : []),
  ...(actionEvidence.approve.length > 1 ? [`multiple approve evidence files (${actionEvidence.approve.length})`] : []),
  ...(actionEvidence.reject.length > 1 ? [`multiple reject evidence files (${actionEvidence.reject.length})`] : []),
  ...(byAction.approve?.scenario?.requestId === byAction.reject?.scenario?.requestId ? ['approve and reject must use independent requests'] : []),
  ...(byAction.approve?.scenario?.runId === byAction.reject?.scenario?.runId ? ['approve and reject must use independent runs'] : []),
  ...(byAction.approve?.decision?.transactionHash?.toLowerCase?.() === byAction.reject?.decision?.transactionHash?.toLowerCase?.()
    ? ['approve and reject must use independent transactions'] : []),
];
const jobsPassed = Object.values(jobResults).every((result) => result === 'success');
const passed = jobsPassed && evidenceErrors.length === 0;

const manifest = {
  schema: 'veilguard.production-release-manifest',
  version: 1,
  generatedAt: new Date().toISOString(),
  repository: process.env.GITHUB_REPOSITORY,
  workflowRunId: process.env.GITHUB_RUN_ID,
  sourceCommit: process.env.GITHUB_SHA,
  productionBaseUrl: process.env.VEILGUARD_LIVE_BASE_URL,
  jobs: jobResults,
  passed,
  errors: evidenceErrors,
  actions: ['approve', 'reject'].map((action) => {
    const item = byAction[action];
    return item ? {
      action,
      runId: item.scenario.runId,
      requestId: item.scenario.requestId,
      transactionHash: item.decision.transactionHash,
      etherscanUrl: item.decision.etherscanUrl,
      evidence: item,
    } : { action, missing: true };
  }),
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = manifest.actions.map((item) => item.missing
    ? `| ${item.action} | missing | — | — |`
    : `| ${item.action} | verified | #${item.requestId} | [${item.transactionHash.slice(0, 10)}…](${item.etherscanUrl}) |`);
  await appendFile(process.env.GITHUB_STEP_SUMMARY, [
    '## VeilGuard production release evidence',
    '',
    `Gate result: **${passed ? 'PASSED' : 'FAILED'}**`,
    '',
    '| Safe action | Evidence | Request | Transaction |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    ...(evidenceErrors.length ? ['Validation errors:', '', ...evidenceErrors.map((error) => `- ${error}`), ''] : []),
  ].join('\n'), 'utf8');
}

if (!passed) {
  console.error(`release manifest validation failed: ${evidenceErrors.join('; ') || JSON.stringify(jobResults)}`);
  process.exitCode = 1;
}
