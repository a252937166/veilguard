import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { validateReleaseEvidence } from './release-evidence-validation.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const inputDirectory = resolve(arg('--input', '.release-artifacts'));
const outputPath = resolve(arg('--output', 'release-manifest.json'));

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

const evidence = [];
const parseErrors = [];
for (const file of await findJsonFiles(inputDirectory)) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed?.schema !== 'veilguard.live-release-evidence') continue;
    const errors = validateReleaseEvidence(parsed);
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
  ...(process.env.RELEASE_RESUMED_FROM_RUN_ID ? { resumedFromRunId: process.env.RELEASE_RESUMED_FROM_RUN_ID } : {}),
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
