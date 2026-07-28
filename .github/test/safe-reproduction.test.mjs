import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  auditDeploymentManifest,
  auditSafeHelperSource,
  auditSafeScriptSource,
} from '../../scripts/lib/safe-reproduction-policy.mjs';
import {
  assertExact2of2,
  assertTwoSignatures,
} from '../../scripts/lib/safe-policy.mjs';

const sources = {
  deploy: await readFile(new URL('../../scripts/deploy-sepolia.ts', import.meta.url), 'utf8'),
  smoke: await readFile(new URL('../../scripts/smoke-sepolia.ts', import.meta.url), 'utf8'),
  e2e: await readFile(new URL('../../scripts/e2e-sepolia.ts', import.meta.url), 'utf8'),
  evidence: await readFile(new URL('../../scripts/final-evidence.ts', import.meta.url), 'utf8'),
  historicalEvidence: await readFile(new URL('../../scripts/complete-evidence.ts', import.meta.url), 'utf8'),
  helper: await readFile(new URL('../../scripts/safe-lib.ts', import.meta.url), 'utf8'),
};

test('exact 2-of-2 policy rejects every weaker committee or signature shape', () => {
  const ownerA = `0x${'1'.repeat(40)}`;
  const ownerB = `0x${'2'.repeat(40)}`;
  const outsider = `0x${'3'.repeat(40)}`;
  assert.deepEqual(
    assertExact2of2({ threshold: 2, owners: [ownerA, ownerB], ownerA, ownerB }),
    { threshold: 2, owners: [ownerA, ownerB] },
  );
  assert.equal(assertTwoSignatures(2), 2);

  assert.throws(
    () => assertExact2of2({ threshold: 1, owners: [ownerA, ownerB], ownerA, ownerB }),
    /threshold 2/,
  );
  assert.throws(
    () => assertExact2of2({ threshold: 2, owners: [ownerA, ownerA], ownerA, ownerB }),
    /distinct addresses/,
  );
  assert.throws(
    () => assertExact2of2({ threshold: 2, owners: [ownerA, ownerB], ownerA, ownerB: ownerA }),
    /distinct Safe owner signers/,
  );
  assert.throws(
    () => assertExact2of2({ threshold: 2, owners: [ownerA, ownerB], ownerA, ownerB: outsider }),
    /current Safe owners/,
  );
  assert.throws(() => assertTwoSignatures(1), /two distinct Safe signatures/);
});

test('fresh Sepolia reproduction scripts can only use the exact 2-of-2 helper', () => {
  for (const kind of ['deploy', 'smoke', 'e2e', 'evidence']) {
    assert.deepEqual(auditSafeScriptSource(sources[kind], kind), [], `${kind} policy violations`);
  }
  assert.deepEqual(auditSafeHelperSource(sources.helper), [], 'safe-lib policy violations');
});

test('fresh deploy completes every read-only safety preflight before its first chain write', () => {
  const writePositions = [
    'await viem.deployContract(',
    'await deployer.writeContract(',
    'await deployer.sendTransaction(',
    'await safeExec2of2(',
  ].map((fragment) => sources.deploy.indexOf(fragment));
  assert.ok(writePositions.every((position) => position >= 0), 'expected deploy write paths');
  const firstWrite = Math.min(...writePositions);

  for (const requiredPreflight of [
    'const chainId = await publicClient.getChainId();',
    'if (chainId !== sepolia.id) {',
    'throw new Error(`fresh deployment requires Sepolia',
    'new Set(demoRoleAddresses).size !== demoRoleAddresses.length',
    'demoRoleAddresses.includes(deployerAddress)',
    "readFileSync(new URL('../deployments.json', import.meta.url), 'utf8')",
    'const checkedInIdentityValues = [',
    'checkedInIdentityValues.some((value) => !isAddress(value))',
    'demoRoleAddresses.some((address) => checkedInIdentities.has(address))',
    'const factoryCode = await publicClient.getCode({ address: SAFE_FACTORY })',
    'for (const candidate of [SAFE_SINGLETON_L1, SAFE_SINGLETON_L2])',
    "throw new Error('canonical Safe v1.4.1 factory/singleton not found on Sepolia",
    'const balance = await publicClient.getBalance(',
    'if (balance < MIN_DEPLOYER_BALANCE) {',
  ]) {
    const position = sources.deploy.indexOf(requiredPreflight);
    assert.ok(position >= 0, `missing deploy preflight: ${requiredPreflight}`);
    assert.ok(position < firstWrite, `${requiredPreflight} must run before the first chain write`);
  }

  const preflight = sources.deploy.slice(0, firstWrite);
  assert.match(
    preflight,
    /if \(new Set\(demoRoleAddresses\)\.size !== demoRoleAddresses\.length\) {\s*throw new Error/,
  );
  assert.match(
    preflight,
    /if \(demoRoleAddresses\.includes\(deployerAddress\)\) {\s*throw new Error/,
  );
  assert.match(
    preflight,
    /if \(demoRoleAddresses\.some\(\(address\) => checkedInIdentities\.has\(address\)\)\) {\s*throw new Error/,
  );
  assert.match(
    preflight,
    /if \(balance < MIN_DEPLOYER_BALANCE\) {\s*throw new Error/,
  );
  assert.doesNotMatch(
    preflight,
    /checkedInDeployments\.contracts/,
    'contract addresses are not identities and must not block a fresh reproduction',
  );

  assert.match(
    sources.deploy,
    /const DEMO_ROLE_FUNDING = parseEther\('0\.004'\);\s*const ROLE_FUNDING_TOTAL = DEMO_ROLE_FUNDING \* 4n;\s*const DEPLOY_GAS_RESERVE = parseEther\('0\.02'\);\s*const MIN_DEPLOYER_BALANCE = ROLE_FUNDING_TOTAL \+ DEPLOY_GAS_RESERVE;/,
  );
  assert.match(
    sources.deploy,
    /value: DEMO_ROLE_FUNDING/,
    'the funding loop and preflight total must use the same per-role amount',
  );
  assert.match(sources.deploy, /ROLE_FUNDING_TOTAL.*four demo roles/s);
  assert.match(sources.deploy, /DEPLOY_GAS_RESERVE.*deployment gas reserve/s);
  assert.doesNotMatch(
    sources.deploy,
    /balance < parseEther\('0\.02'\)/,
    '0.02 ETH cannot cover both 0.016 ETH role funding and a safe gas reserve',
  );
});

test('Safe reproduction policy detects threshold, direct-exec and duplicate-signer regressions', () => {
  const thresholdOne = sources.deploy.replace(
    '[admin.address, signerB.address], 2n,',
    '[admin.address, signerB.address], 1n,',
  );
  assert.ok(
    auditSafeScriptSource(thresholdOne, 'deploy').some(
      (violation) => violation.code === 'deploy-setup-threshold',
    ),
  );

  const directExec = `${sources.smoke}
await admin.writeContract({ address: Safe, functionName: 'execTransaction', args: [] });`;
  assert.ok(
    auditSafeScriptSource(directExec, 'smoke').some(
      (violation) => violation.code === 'direct-safe-exec',
    ),
  );

  const duplicateSigner = sources.helper.replace('signer: ownerBKey', 'signer: ownerAKey');
  assert.ok(
    auditSafeHelperSource(duplicateSigner).some(
      (violation) => violation.code === 'helper-distinct-signers',
    ),
  );

  const unverifiedReuse = `${sources.evidence}
const legacyReuse = env('REUSE_MANDATE');`;
  assert.ok(
    auditSafeScriptSource(unverifiedReuse, 'evidence').some(
      (violation) => violation.code === 'evidence-unverified-reuse',
    ),
  );
});

test('helper audit rejects decoy guards, fail-open checks, early returns and reordered execution', () => {
  const failOpenGuards = [
    [
      '    throw new Error(`Safe execution requires Sepolia (${sepolia.id}), got chain ${chainId}`);',
      "    console.warn('wrong chain');",
      'helper-chain-guard-not-fail-closed',
    ],
    [
      '    throw new Error(`Safe nonce changed while collecting signatures (expected ${tx.data.nonce}, got ${currentNonce})`);',
      "    console.warn('nonce changed');",
      'helper-nonce-guard-not-fail-closed',
    ],
    [
      '    throw new Error(`Safe execution reverted: ${executeTxHash}`);',
      "    console.warn('execution reverted');",
      'helper-receipt-guard-not-fail-closed',
    ],
  ];
  for (const [throwingLine, failOpenLine, expectedCode] of failOpenGuards) {
    const mutant = `${sources.helper.replace(throwingLine, failOpenLine)}
function decoyGuard(chainId, currentNonce, tx, receipt) {
  if (chainId !== sepolia.id) throw new Error('decoy');
  if (currentNonce !== tx.data.nonce) throw new Error('decoy');
  if (receipt.status !== 'success') throw new Error('decoy');
}`;
    assert.notEqual(mutant, sources.helper);
    assert.ok(
      auditSafeHelperSource(mutant).some((violation) => violation.code === expectedCode),
      `${expectedCode} must reject a fail-open guard even when a decoy guard exists`,
    );
  }

  const earlyReturn = sources.helper.replace(
    '  const exec = await safeB.executeTransaction(tx);',
    `  if (process.env.BYPASS_SAFE) {
    return { safeTxHash, executeTxHash: '0x0', nonce: tx.data.nonce, confirmations, threshold: exactSafe.threshold };
  }
  const exec = await safeB.executeTransaction(tx);`,
  );
  assert.ok(
    auditSafeHelperSource(earlyReturn).some(
      (violation) => violation.code === 'helper-early-return',
    ),
  );

  const confirmationLine = '  const confirmations = assertTwoSignatures(tx.signatures.size);\n';
  const reordered = sources.helper
    .replace(confirmationLine, '')
    .replace(
      "  tx = await safeB.signTransaction(tx, 'eth_signTypedData_v4');",
      `${confirmationLine}  tx = await safeB.signTransaction(tx, 'eth_signTypedData_v4');`,
    );
  assert.ok(
    auditSafeHelperSource(reordered).some(
      (violation) => violation.code === 'helper-operation-order',
    ),
  );

  const policyInDeadBranch = sources.helper.replace(
    '  const exactSafe = assertExact2of2({ threshold, owners, ownerA, ownerB });',
    `  let exactSafe = { threshold: 2 };
  if (false) exactSafe = assertExact2of2({ threshold, owners, ownerA, ownerB });`,
  );
  assert.ok(
    auditSafeHelperSource(policyInDeadBranch).some(
      (violation) => violation.code === 'helper-policy-guard-not-direct',
    ),
  );

  const secondExecution = sources.helper.replace(
    '  return {\n',
    "  await safeA['executeTransaction'](tx);\n  return {\n",
  );
  assert.ok(
    auditSafeHelperSource(secondExecution).some(
      (violation) => violation.code === 'helper-raw-write',
    ),
  );

  const fakeSafeHash = sources.helper.replace(
    'const safeTxHash = await safeA.getTransactionHash(tx);',
    `const safeTxHash = '${`0x${'0'.repeat(64)}`}';`,
  );
  assert.ok(
    auditSafeHelperSource(fakeSafeHash).some(
      (violation) => violation.code === 'helper-safe-hash-source',
    ),
  );

  const unrelatedReceipt = sources.helper.replace(
    'hash: executeTxHash as `0x${string}`',
    `hash: '${`0x${'1'.repeat(64)}`}' as \`0x\${string}\``,
  );
  assert.ok(
    auditSafeHelperSource(unrelatedReceipt).some(
      (violation) => violation.code === 'helper-receipt-hash-source',
    ),
  );
});

test('script audit rejects imported bypasses, shadowing, raw Safe writes and manifest mutation', () => {
  const relativeExecutor = `${sources.smoke}
import { unsafeExecute } from './alternate-safe-executor.mjs';`;
  assert.ok(
    auditSafeScriptSource(relativeExecutor, 'smoke').some(
      (violation) => violation.code === 'relative-executor-import',
    ),
  );

  const shadowedHelper = `${sources.smoke}
function decoy(safeExec2of2) { return safeExec2of2; }`;
  assert.ok(
    auditSafeScriptSource(shadowedHelper, 'smoke').some(
      (violation) => violation.code === 'shadowed-safe-helper',
    ),
  );

  const rawSafeWrite = `${sources.smoke}
const rawSafeFn = 'execTransaction';
const rawSafeTx = { address: Safe, abi: [], functionName: rawSafeFn, args: [] };
const rawWrite = admin.writeContract.bind(admin);
await rawWrite(rawSafeTx);`;
  assert.ok(
    auditSafeScriptSource(rawSafeWrite, 'smoke').some(
      (violation) => violation.code === 'raw-safe-write',
    ),
  );

  const directGovernance = `${sources.smoke}
const directAction = 'activateMandate';
await send('unsafe activation', admin, {
  address: VeilGuardModule, abi: moduleAbi, functionName: directAction, args: [1n],
});`;
  assert.ok(
    auditSafeScriptSource(directGovernance, 'smoke').some(
      (violation) => violation.code === 'direct-governance-write',
    ),
  );

  const earlySuccess = sources.smoke.replace(
    'await safeExec2of2(Safe, VeilGuardModule, activateData, safeKeys);',
    `process.exit(0);
await safeExec2of2(Safe, VeilGuardModule, activateData, safeKeys);`,
  );
  assert.ok(
    auditSafeScriptSource(earlySuccess, 'smoke').some(
      (violation) => violation.code === 'script-early-success-exit',
    ),
  );

  const unawaitedSmoke = sources.smoke.replace(
    'await safeExec2of2(Safe, VeilGuardModule, activateData, safeKeys);',
    'safeExec2of2(Safe, VeilGuardModule, activateData, safeKeys);',
  );
  assert.ok(
    auditSafeScriptSource(unawaitedSmoke, 'smoke').some(
      (violation) => violation.code === 'safe-helper-call-not-awaited',
    ),
  );

  const unawaitedE2e = sources.e2e.replace(
    "await safeCall('cancelEscalated', [a.id]);",
    "safeCall('cancelEscalated', [a.id]);",
  );
  assert.ok(
    auditSafeScriptSource(unawaitedE2e, 'e2e').some(
      (violation) => violation.code === 'e2e-safe-call-not-awaited',
    ),
  );

  const mutatedManifest = `${sources.deploy}
deployments.safe.threshold = 1;
Object.assign(deployments.safe, { owners: [admin.address] });`;
  assert.ok(
    auditSafeScriptSource(mutatedManifest, 'deploy').some(
      (violation) => violation.code === 'deploy-manifest-mutation',
    ),
  );

  const wrongWriteSource = sources.deploy.replace(
    'JSON.stringify(deployments, null, 2)',
    'JSON.stringify({ ...deployments, safe: { owners: [admin.address], threshold: 1 } }, null, 2)',
  );
  assert.ok(
    auditSafeScriptSource(wrongWriteSource, 'deploy').some(
      (violation) => violation.code === 'deploy-manifest-write',
    ),
  );

  const conditionalShapeGuard = sources.deploy.replace(
    'safeThreshold !== 2n || safeOwners.length !== 2',
    '(safeThreshold !== 2n || safeOwners.length !== 2) && false',
  );
  assert.ok(
    auditSafeScriptSource(conditionalShapeGuard, 'deploy').some(
      (violation) => violation.code === 'deploy-safe-shape-guard',
    ),
  );

  const unusedSetupDecoy = sources.deploy
    .replace('const initializer = encodeFunctionData({', 'const decoyInitializer = encodeFunctionData({')
    .replace(
      '  const hash = await deployer.writeContract({',
      `  const initializer = '0xdead' as const;
  const hash = await deployer.writeContract({`,
    );
  assert.ok(
    auditSafeScriptSource(unusedSetupDecoy, 'deploy').some(
      (violation) => violation.code === 'deploy-setup-not-used',
    ),
  );

  const conditionalHelper = sources.smoke.replace(
    'await safeExec2of2(Safe, VeilGuardModule, activateData, safeKeys);',
    'if (false) await safeExec2of2(Safe, VeilGuardModule, activateData, safeKeys);',
  );
  assert.ok(
    auditSafeScriptSource(conditionalHelper, 'smoke').some(
      (violation) => violation.code === 'nested-safe-helper-call',
    ),
  );

  const mutableE2eWrapper = sources.e2e
    .replace('const safeCall =', 'let safeCall =')
    .replace(
      'const getRequest =',
      `safeCall = async () => ({
  safeTxHash: '0x0', executeTxHash: '0x0', nonce: 0, confirmations: 2, threshold: 2,
});

const getRequest =`,
    );
  const wrapperViolations = auditSafeScriptSource(mutableE2eWrapper, 'e2e');
  assert.ok(wrapperViolations.some(
    (violation) => ['e2e-wrapper-mutated', 'e2e-wrapper-not-multisig'].includes(violation.code),
  ));
});

test('final evidence records the immutable results returned by both Safe executions', () => {
  const fakeResult = `{
    safeTxHash: '0x0', executeTxHash: '0x0', nonce: 0, confirmations: 2, threshold: 2,
  }`;
  const fakeActivation = sources.evidence.replace(
    'evidence.mandate = { id: Number(mandateId), proposeTx, activation };',
    `evidence.mandate = { id: Number(mandateId), proposeTx, activation: ${fakeResult} };`,
  );
  assert.ok(
    auditSafeScriptSource(fakeActivation, 'evidence').some(
      (violation) => violation.code === 'evidence-activation-not-recorded',
    ),
  );

  const fakeApproval = sources.evidence.replace(
    'finalizeTx: escalated.finalizeTx, approval },',
    `finalizeTx: escalated.finalizeTx, approval: ${fakeResult} },`,
  );
  assert.ok(
    auditSafeScriptSource(fakeApproval, 'evidence').some(
      (violation) => violation.code === 'evidence-approval-not-recorded',
    ),
  );

  const unawaitedActivation = sources.evidence.replace(
    'const activation = await safeExec2of2(',
    'const activation = safeExec2of2(',
  );
  assert.ok(
    auditSafeScriptSource(unawaitedActivation, 'evidence').some(
      (violation) => violation.code === 'safe-helper-call-not-awaited',
    ),
  );
});

test('final evidence derives the auditor key and verifies the complete audit packet before writing', () => {
  assert.doesNotMatch(sources.evidence, /DEMO_AUDITOR_ADDR/);
  assert.match(sources.evidence, /const auditor = wallet\('DEMO_AUDITOR_KEY'\);/);
  assert.match(
    sources.evidence,
    /args: \[auditorAddress, mandateId, expectedRequestIds\]/,
  );

  const evidenceWrite = sources.evidence.lastIndexOf('writeFileSync(');
  assert.ok(evidenceWrite > 0, 'final evidence must write only after verification');
  for (const requiredCheck of [
    "assertAddressEqual('packet auditor'",
    "assertBigIntEqual('packet mandateId'",
    "assertBigIntEqual('packet policyVersion'",
    "assertBigIntSequence('packet requestIds'",
    'snapshot handle count mismatch',
    'request[${index}].mandateId',
    'request[${index}].state',
    'const expectedManifestHash = keccak256(encodeAbiParameters(',
    'packet manifest mismatch',
    "assertBigIntSequence('decrypted packet snapshots'",
  ]) {
    const checkPosition = sources.evidence.indexOf(requiredCheck);
    assert.ok(checkPosition > 0, `missing fail-closed check: ${requiredCheck}`);
    assert.ok(
      checkPosition < evidenceWrite,
      `${requiredCheck} must execute before demo-evidence.json is written`,
    );
  }

  assert.match(
    sources.evidence,
    /\{ name: 'auditor', type: 'address' \}[\s\S]*\{ name: 'mandateId', type: 'uint256' \}[\s\S]*\{ name: 'policyVersion', type: 'uint32' \}[\s\S]*\{ name: 'requestIds', type: 'uint256\[\]' \}[\s\S]*\{ name: 'snapshotHandles', type: 'bytes32\[\]' \}/,
  );
  assert.match(
    sources.evidence,
    /const expectedSnapshotValues = \[\s*usdc\(40\),\s*usdc\(500\) - usdc\(25\) - usdc\(60\),\s*usdc\(300\),\s*usdc\(25\), 0n,\s*usdc\(60\), 0n,\s*usdc\(600\), 1n,/,
  );
  assert.match(sources.evidence, /parseEventLogs\(\{[\s\S]*strict: true,/);
  for (const eventName of ['MandateProposed', 'SpendRequested', 'AuditPacketCreated']) {
    assert.match(
      sources.evidence,
      new RegExp(`requireSingleModuleEvent\\([\\s\\S]*?'${eventName}'`),
      `final evidence must bind ${eventName} to its transaction receipt`,
    );
  }
  assert.match(
    sources.evidence,
    /assertHexEqual\('packet manifest vs AuditPacketCreated', String\(packet\[3\]\), eventManifestHash\)/,
  );
  assert.doesNotMatch(sources.evidence, /next(?:Mandate|Request|Packet)Id/);
});

test('fresh E2E validates all eleven audit snapshot slots as raw bigint values', () => {
  for (const [label, raw] of [
    ['policy.autoLimit', 'usdc(40)'],
    ['policy.budgetLeft', 'usdc(15)'],
    ['policy.reserveFloor', 'usdc(500)'],
    ['request#1.amount', 'usdc(25)'],
    ['request#1.blockedReason', '0n'],
    ['request#${a.id}.amount', 'usdc(60)'],
    ['request#${a.id}.blockedReason', '0n'],
    ['request#${b.id}.amount', 'usdc(60)'],
    ['request#${b.id}.blockedReason', '0n'],
    ['request#${c.id}.amount', 'usdc(500)'],
    ['request#${c.id}.blockedReason', '1n'],
  ]) {
    assert.match(
      sources.e2e,
      new RegExp(`label: [\`']${label.replaceAll('$', '\\$')}[\`'], raw: ${raw.replace(/[()]/g, '\\$&')}`),
      `missing raw snapshot assertion for ${label}`,
    );
  }
  assert.match(sources.e2e, /snaps\.length !== expectedSnapshots\.length/);
  assert.match(sources.e2e, /const values: bigint\[\] = \[\];/);
  assert.doesNotMatch(
    sources.e2e,
    /auditorClient\.decrypt\(s\)\)\.value\)\s*\/\s*1e6/,
  );
});

test('unsupported historical evidence completion cannot overwrite canonical evidence', async () => {
  assert.match(sources.historicalEvidence, /@deprecated Unsupported historical one-off/);
  assert.match(sources.historicalEvidence, /prefer scripts\/final-evidence\.ts/);
  assert.match(
    sources.historicalEvidence,
    /const evidenceOutput = new URL\('\.\.\/app\/src\/demo-evidence\.recovery\.json', import\.meta\.url\)/,
  );
  assert.match(sources.historicalEvidence, /writeFileSync\(evidenceOutput,/);
  assert.doesNotMatch(
    sources.historicalEvidence,
    /app\/src\/demo-evidence\.json/,
  );
});

test('ABI declarations, comments, reads and ordinary memo padding are not mistaken for Safe execution', () => {
  const sample = `
    import { safeExec2of2 } from './safe-lib.js';
    const abi = [{ type: 'function', name: 'execTransaction' }];
    // Historical migration notes may mention threshold: 1.
    const memo = padHex('0x01', { size: 32 });
    await publicClient.readContract({ address: Safe, functionName: 'getThreshold' });
    await arbitraryWriter({ address: NotSafe, functionName: 'activateMandate' });
    const activateData = encodeFunctionData({ functionName: 'activateMandate', args: [] });
    await safeExec2of2(Safe, Module, activateData, keys);
  `;
  assert.deepEqual(auditSafeScriptSource(sample, 'smoke'), []);
});

test('both checked-in deployment manifests remain exact 2-of-2', async () => {
  for (const [label, url] of [
    ['root-deployments', new URL('../../deployments.json', import.meta.url)],
    ['app-deployments', new URL('../../app/src/deployments.json', import.meta.url)],
  ]) {
    const manifest = JSON.parse(await readFile(url, 'utf8'));
    assert.deepEqual(auditDeploymentManifest(manifest, label), []);
  }
});

test('README separates fresh mutation scripts from the existing production path', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  assert.match(readme, /#### Fresh deployment \(new contracts and Safe\)/);
  assert.match(readme, /#### Existing production deployment/);
  assert.match(readme, /fresh protocol reproduction/);
  assert.match(readme, /not a one-command clone of the full/);
  assert.match(readme, /main, violation and Free Play Delegates/);
  assert.match(readme, /Never put the Finance\s+Admin or either Safe-owner key in the browser bundle/);
  assert.match(readme, /run the provisioner against the fresh `MODULE` and `SAFE`/);
  assert.match(readme, /deploy script funds only its configured Admin, second signer, one Delegate/);
  assert.match(readme, /four `DEMO_\*` role keys must be brand-new test-only identities/);
  assert.match(readme, /refuses any role that reuses a checked-in Safe owner or deployment role/);
  assert.match(readme, /Do \*\*not\*\* start at `smoke-sepolia\.ts` or `e2e-sepolia\.ts`/);
  assert.match(readme, /Do not run the fresh deploy\/smoke\/E2E scripts or the historical/);
  assert.match(readme, /`redeploy-module\.ts` migration/);
  assert.match(readme, /Production Release Gate/);
});
