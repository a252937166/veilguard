import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  createPublicClient,
  decodeFunctionData,
  http,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  type PublicClient,
} from 'viem';
import { sepolia } from 'viem/chains';
import {
  type LiveDecisionAttestation,
  type LiveReleaseAction,
  type LiveReleaseEvidenceV1,
  type LiveReleaseRecoveryPointerV1,
} from './live-release-evidence';

const deployments = JSON.parse(await readFile(new URL('../../src/deployments.json', import.meta.url), 'utf8'));

const LIVE_BASE_URL = (process.env.VEILGUARD_LIVE_BASE_URL ?? 'https://veilguard.axiqo.xyz').replace(/\/$/, '');
const EVIDENCE_OUTPUT = process.env.VEILGUARD_LIVE_EVIDENCE_PATH
  ?? 'release-evidence/live-release-evidence.json';
const RECOVERY_OUTPUT = EVIDENCE_OUTPUT.replace(/\.json$/i, '.recovery.json');
const EXPECTED_UI_SHA = process.env.VEILGUARD_EXPECTED_UI_SHA?.trim();
const SOURCE_COMMIT = process.env.VEILGUARD_SOURCE_COMMIT?.trim() || EXPECTED_UI_SHA || 'unknown';
const ACTION = process.env.VEILGUARD_LIVE_ACTION as LiveReleaseAction | undefined;
const RECOVERY_MODE = process.env.VEILGUARD_RECOVERY_MODE?.trim();
const RECOVERY_RUN_ID = process.env.VEILGUARD_RECOVERY_RUN_ID?.trim();
const RECOVERY_REQUEST_ID = process.env.VEILGUARD_RECOVERY_REQUEST_ID?.trim();
const RECOVERY_REQUEST_TX = process.env.VEILGUARD_RECOVERY_REQUEST_TX?.trim() as `0x${string}` | undefined;
const DEPLOY_BLOCK = 11_295_790n;
const LOG_CHUNK = 9_500n;
const ETHERSCAN_TX = 'https://sepolia.etherscan.io/tx/';
const MODULE = deployments.contracts.VeilGuardModule as `0x${string}`;
const SAFE = deployments.contracts.Safe as `0x${string}`;
const RPC_URLS = ['https://sepolia.drpc.org', 'https://gateway.tenderly.co/public/sepolia'];
const rpcClients = RPC_URLS.map((url) => createPublicClient({
  chain: sepolia,
  transport: http(url, { timeout: 15_000 }),
}));

const safeEvidenceAbi = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
]);
const moduleReadAbi = parseAbi([
  'function getRequest(uint256 requestId) view returns (uint256 mandateId,address delegate,address recipient,bytes32 memoHash,uint64 createdAt,uint8 state,bytes32 amount,bytes32 decision,bytes32 blockedReason)',
  'function executeEscalated(uint256 requestId)',
  'function cancelEscalated(uint256 requestId)',
]);
const requestEvent = parseAbiItem('event SpendRequested(uint256 indexed requestId, uint256 indexed mandateId, address indexed delegate, address recipient, bytes32 decisionHandle)');
const escalationEvent = parseAbiItem('event EscalationReady(uint256 indexed requestId)');
const approvalEvent = parseAbiItem('event EscalationExecuted(uint256 indexed requestId)');
const cancellationEvent = parseAbiItem('event EscalationCancelled(uint256 indexed requestId)');

async function withRpc<T>(call: (client: PublicClient) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const client of rpcClients) {
    try {
      return await call(client as PublicClient);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('no Sepolia RPC client is available');
}

async function findRequestEventLogs(event: any, requestId: bigint, from: bigint, to: bigint) {
  const logs: any[] = [];
  for (let fromBlock = from; fromBlock <= to; fromBlock += LOG_CHUNK) {
    const toBlock = fromBlock + LOG_CHUNK - 1n > to ? to : fromBlock + LOG_CHUNK - 1n;
    const page = await withRpc((client) => client.getLogs({
      address: MODULE,
      event,
      args: { requestId },
      fromBlock,
      toBlock,
    } as any));
    logs.push(...page);
  }
  return logs;
}

const releaseAction = (): LiveReleaseAction => {
  if (ACTION !== 'approve' && ACTION !== 'reject') {
    throw new Error('VEILGUARD_LIVE_ACTION must be exactly approve or reject');
  }
  return ACTION;
};

const expectedUiSha = (): string => {
  if (!EXPECTED_UI_SHA || !/^[0-9a-f]{7,40}$/i.test(EXPECTED_UI_SHA)) {
    throw new Error('VEILGUARD_EXPECTED_UI_SHA must identify the checked-out commit');
  }
  return EXPECTED_UI_SHA;
};

async function assertProductionUiSha(page: Page): Promise<string> {
  const expected = expectedUiSha();
  const corsFailures: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const retiredRpc = /(sepolia\.blockpi\.network|omnia\.tech|rpc\.sepolia\.org)/i;
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
      if (retiredRpc.test(message.text())) corsFailures.push(message.text());
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    if (retiredRpc.test(request.url())) corsFailures.push(`${request.url()} · ${request.failure()?.errorText ?? 'failed'}`);
  });

  const routes = [
    ['payments', 'Payment Inbox'],
    ['approvals', 'Pending Approvals'],
    ['disclosure', 'Build Packet'],
    ['audit', 'Audit Packets'],
    ['verify/launch-day', 'Flow launch-day'],
    ['provenance', 'Build Provenance'],
  ] as const;
  for (const [route, crumb] of routes) {
    await page.goto(`${LIVE_BASE_URL}/#/${route}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.crumb-page')).toHaveText(crumb);
  }
  const buildLabel = page.locator('footer .mono').filter({ hasText: /^ui\s+/ }).first();
  await expect(buildLabel).toBeVisible();
  const observed = (await buildLabel.textContent())?.replace(/^ui\s+/, '').trim() ?? '';
  expect(observed, 'production UI must be built from the commit under test').toBe(expected);
  await page.waitForTimeout(1_000);
  expect(pageErrors, 'core production routes must not raise uncaught page errors').toEqual([]);
  expect(consoleErrors, 'core production routes must not write console errors').toEqual([]);
  expect(corsFailures, 'retired browser RPC endpoints must not be contacted').toEqual([]);
  return observed;
}

async function startFreshLiveRun(page: Page) {
  await page.goto(`${LIVE_BASE_URL}/?live-release=${Date.now()}`);
  const launch = page.getByRole('button', { name: /start interactive demo/i });
  await expect(launch.first()).toBeVisible();
  await launch.first().click();
  await expect(page).toHaveURL(/#\/payments$/);
  await expect(page.getByRole('heading', { name: /payment inbox/i, level: 2 })).toBeVisible();
  await expect(page.getByRole('article', { name: /CloudNode payment detail/i })).toBeVisible();
}

async function submitSelectedInvoice(page: Page, expectedOutcome: RegExp) {
  const submit = page.getByRole('button', { name: /submit confidential payment/i });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();
  await expect(page.getByRole('region', { name: /active payment operation/i })).toBeVisible({ timeout: 8_000 });
  const outcome = page.getByText(expectedOutcome);
  const failure = page.locator('.toast.err[role="alert"]');
  let terminal = 'pending';
  await expect.poll(async () => {
    if (await failure.isVisible()) terminal = `error:${await failure.innerText()}`;
    else if (await outcome.isVisible()) terminal = 'outcome';
    return terminal;
  }, { timeout: 300_000 }).not.toBe('pending');
  if (terminal.startsWith('error:')) {
    throw new Error(`payment operation failed before a terminal outcome: ${terminal.slice('error:'.length)}`);
  }
}

type SessionEvidence = {
  runId?: string;
  routineRequestId?: string;
  requestId?: string;
  decision?: string;
  transactionHash?: string;
  activeBroadcast?: {
    mission?: string;
    requestId?: string;
    transactionHash: `0x${string}`;
  };
};

async function readSessionEvidence(page: Page): Promise<SessionEvidence> {
  return page.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem('vg_demo_session_v2') ?? '{}');
    const track = JSON.parse(sessionStorage.getItem('vg_track') ?? 'null');
    return {
      runId: session.runId,
      routineRequestId: session.missions?.routine?.requestId,
      requestId: session.missions?.approval?.requestId,
      decision: session.missions?.approval?.decision,
      transactionHash: session.missions?.approval?.decisionTx,
      activeBroadcast: track?.tx ? {
        mission: track.mission,
        requestId: track.id,
        transactionHash: track.tx,
      } : undefined,
    };
  });
}

async function readDecisionAttestation(
  page: Page,
  runId: string,
  requestId: string,
): Promise<{ status: number; body: LiveDecisionAttestation }> {
  return page.evaluate(async ({ runId: liveRunId, requestId: liveRequestId }) => {
    const query = new URLSearchParams({ runId: liveRunId, requestId: liveRequestId });
    const response = await fetch(`/api/demo-decision?${query}`, { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  }, { runId, requestId });
}

async function persistJsonAtomic(outputPath: string, value: unknown) {
  const output = resolve(outputPath);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, output);
}

async function persistEvidence(evidence: LiveReleaseEvidenceV1) {
  await persistJsonAtomic(EVIDENCE_OUTPUT, evidence);
}

async function persistRecoveryPointer(pointer: LiveReleaseRecoveryPointerV1) {
  const phaseRank: Record<LiveReleaseRecoveryPointerV1['phase'], number> = {
    'run-started': 0,
    'routine-observed': 1,
    'request-bound': 2,
    'decision-observed': 3,
  };
  let existing: LiveReleaseRecoveryPointerV1 | undefined;
  try {
    const parsed = JSON.parse(await readFile(resolve(RECOVERY_OUTPUT), 'utf8'));
    if (parsed?.schema === 'veilguard.live-release-recovery' && parsed?.version === 1) existing = parsed;
  } catch { /* first checkpoint */ }
  const higherPhase = existing && phaseRank[existing.phase] > phaseRank[pointer.phase]
    ? existing.phase
    : pointer.phase;
  const merged: LiveReleaseRecoveryPointerV1 = existing ? {
    ...existing,
    ...pointer,
    phase: higherPhase,
    workflow: { ...existing.workflow, ...pointer.workflow },
    production: { ...existing.production, ...pointer.production },
    scenario: { ...existing.scenario, ...pointer.scenario },
    decision: { ...existing.decision, ...pointer.decision },
    activeBroadcast: pointer.activeBroadcast ?? existing.activeBroadcast,
    attestation: pointer.attestation ?? existing.attestation,
  } : pointer;
  await persistJsonAtomic(RECOVERY_OUTPUT, merged);
}

async function verifyOnchainDecision(action: LiveReleaseAction, requestIdText: string, decisionHash: `0x${string}`) {
  const requestId = BigInt(requestIdText);
  const [transaction, receipt, owners, threshold, request] = await Promise.all([
    withRpc((client) => client.getTransaction({ hash: decisionHash })),
    withRpc((client) => client.getTransactionReceipt({ hash: decisionHash })),
    withRpc((client) => client.readContract({ address: SAFE, abi: safeEvidenceAbi, functionName: 'getOwners' })),
    withRpc((client) => client.readContract({ address: SAFE, abi: safeEvidenceAbi, functionName: 'getThreshold' })),
    withRpc((client) => client.readContract({ address: MODULE, abi: moduleReadAbi, functionName: 'getRequest', args: [requestId] })),
  ]);

  expect(transaction.to?.toLowerCase(), 'outer transaction target must be the deployed Safe').toBe(SAFE.toLowerCase());
  expect(receipt.status).toBe('success');
  expect(receipt.to?.toLowerCase()).toBe(SAFE.toLowerCase());
  expect(threshold).toBe(2n);
  expect(owners).toHaveLength(2);
  expect(Number(request[5])).toBe(action === 'approve' ? 2 : 5);

  const outer = decodeFunctionData({ abi: safeEvidenceAbi, data: transaction.input });
  expect(outer.functionName).toBe('execTransaction');
  const [moduleTarget, value, innerData, operation, , , , , , signatures] = outer.args as readonly [
    `0x${string}`, bigint, `0x${string}`, number, bigint, bigint, bigint, `0x${string}`, `0x${string}`, `0x${string}`,
  ];
  expect(moduleTarget.toLowerCase()).toBe(MODULE.toLowerCase());
  expect(value).toBe(0n);
  expect(operation).toBe(0);
  const signatureBytes = (signatures.length - 2) / 2;
  expect(signatureBytes).toBe(130);

  const inner = decodeFunctionData({ abi: moduleReadAbi, data: innerData });
  const expectedFunction: 'executeEscalated' | 'cancelEscalated' = action === 'approve'
    ? 'executeEscalated'
    : 'cancelEscalated';
  expect(inner.functionName).toBe(expectedFunction);
  expect(inner.args?.[0]).toBe(requestId);

  // All three transactions happen in one guided run. Anchor the read-only log
  // scan to the confirmed Safe receipt instead of replaying the module's full
  // history on every manual release gate.
  const recentWindow = 2_000n;
  const candidateStart = receipt.blockNumber > recentWindow ? receipt.blockNumber - recentWindow : DEPLOY_BLOCK;
  const fromBlock = candidateStart > DEPLOY_BLOCK ? candidateStart : DEPLOY_BLOCK;
  const toBlock = receipt.blockNumber;
  const terminalEvent = action === 'approve' ? approvalEvent : cancellationEvent;
  const expectedTerminalName: 'EscalationExecuted' | 'EscalationCancelled' = action === 'approve'
    ? 'EscalationExecuted'
    : 'EscalationCancelled';
  const terminalLogs = await findRequestEventLogs(terminalEvent, requestId, fromBlock, toBlock);
  expect(terminalLogs).toHaveLength(1);
  expect(terminalLogs[0].transactionHash.toLowerCase()).toBe(decisionHash.toLowerCase());

  const [requestLogs, finalizeLogs] = await Promise.all([
    findRequestEventLogs(requestEvent, requestId, fromBlock, toBlock),
    findRequestEventLogs(escalationEvent, requestId, fromBlock, toBlock),
  ]);
  expect(requestLogs).toHaveLength(1);
  expect(finalizeLogs).toHaveLength(1);
  const requestTx = requestLogs[0].transactionHash as `0x${string}`;
  const finalizeTx = finalizeLogs[0].transactionHash as `0x${string}`;
  const [requestReceipt, finalizeReceipt] = await Promise.all([
    withRpc((client) => client.getTransactionReceipt({ hash: requestTx })),
    withRpc((client) => client.getTransactionReceipt({ hash: finalizeTx })),
  ]);
  expect(requestReceipt.status).toBe('success');
  expect(finalizeReceipt.status).toBe('success');

  return {
    safeOwnerCount: owners.length as 2,
    request: {
      hash: requestTx,
      status: 'success' as const,
      etherscanUrl: `${ETHERSCAN_TX}${requestTx}`,
    },
    teeFinalize: {
      hash: finalizeTx,
      status: 'success' as const,
      terminalEvent: 'EscalationReady' as const,
      etherscanUrl: `${ETHERSCAN_TX}${finalizeTx}`,
    },
    safeDecision: {
      hash: decisionHash,
      status: 'success' as const,
      blockNumber: receipt.blockNumber.toString(),
      outerTarget: transaction.to as `0x${string}`,
      moduleTarget,
      moduleAction: expectedFunction,
      requestId: requestIdText,
      operation: 0 as const,
      signatureBytes: signatureBytes as 130,
      signatureCount: 2 as const,
      terminalEvent: expectedTerminalName,
      terminalEventCount: terminalLogs.length as 1,
      etherscanUrl: `${ETHERSCAN_TX}${decisionHash}`,
    },
  };
}

function buildLiveEvidence({
  action,
  observedUiSha,
  runId,
  requestId,
  transactionHash,
  attestation,
  onchain,
}: {
  action: LiveReleaseAction;
  observedUiSha: string;
  runId: string;
  requestId: string;
  transactionHash: `0x${string}`;
  attestation: LiveDecisionAttestation;
  onchain: Awaited<ReturnType<typeof verifyOnchainDecision>>;
}): LiveReleaseEvidenceV1 {
  const chainState = action === 'approve' ? 2 : 5;
  return {
    schema: 'veilguard.live-release-evidence',
    version: 1,
    generatedAt: new Date().toISOString(),
    workflow: {
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      sourceCommit: SOURCE_COMMIT,
    },
    production: {
      baseUrl: LIVE_BASE_URL,
      expectedUiSha: expectedUiSha(),
      observedUiSha,
    },
    chain: {
      id: 11155111,
      network: 'ethereum-sepolia',
      module: deployments.contracts.VeilGuardModule as `0x${string}`,
      safe: deployments.contracts.Safe as `0x${string}`,
      safeThreshold: 2,
      safeOwnerCount: onchain.safeOwnerCount,
    },
    scenario: { name: 'ShieldOps', runId, requestId },
    decision: {
      action,
      origin: 'user',
      chainState,
      transactionHash,
      etherscanUrl: `${ETHERSCAN_TX}${transactionHash}`,
    },
    transactions: {
      request: onchain.request,
      teeFinalize: onchain.teeFinalize,
      safeDecision: onchain.safeDecision,
    },
    attestation,
  };
}

async function readLiveDecisionAttestation(runId: string, requestId: string) {
  const query = new URLSearchParams({ runId, requestId });
  const response = await fetch(`${LIVE_BASE_URL}/api/demo-decision?${query}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() as any };
}

async function settleBoundReject(runId: string, requestId: string): Promise<LiveDecisionAttestation> {
  for (let attempt = 0; attempt < 125; attempt++) {
    const attested = await readLiveDecisionAttestation(runId, requestId);
    if (attested.status === 200 && attested.body?.origin === 'user') {
      expect(attested.body).toEqual(expect.objectContaining({
        ok: true,
        requestId: Number(requestId),
        action: 'reject',
        chainState: 5,
        hash: expect.stringMatching(/^0x[0-9a-f]{64}$/i),
      }));
      return attested.body as LiveDecisionAttestation;
    }
    if (attested.status === 200 && attested.body?.origin === 'timeout') {
      throw new Error(`bound Reject request #${requestId} expired by watchdog; it cannot be represented as a user decision`);
    }
    if (attested.status === 200 && attested.body?.chainState !== 3) {
      throw new Error(`bound Reject request #${requestId} reached state ${attested.body?.chainState} without a user attestation`);
    }

    let response: Response;
    try {
      response = await fetch(`${LIVE_BASE_URL}/api/demo-decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId, requestId: Number(requestId), action: 'reject' }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // The endpoint is run/request/action idempotent. A missing HTTP response
      // is ambiguous, so re-attest the same object instead of creating a run.
      console.info(`[live-reject] decision response delayed; re-attesting request #${requestId}`, error);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      continue;
    }
    const body = await response.json().catch(() => ({})) as any;
    if (response.status === 202) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      continue;
    }
    if (!response.ok) throw new Error(body?.error ?? `bound Reject returned ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`bound Reject request #${requestId} did not produce a user attestation before the release timeout`);
}

async function recoverBoundReject(observedUiSha: string) {
  if (!RECOVERY_RUN_ID || !/^[A-Za-z0-9_-]{8,96}$/.test(RECOVERY_RUN_ID)) {
    throw new Error('bound Reject recovery requires a valid run ID');
  }
  if (!RECOVERY_REQUEST_ID || !/^\d{1,9}$/.test(RECOVERY_REQUEST_ID)) {
    throw new Error('bound Reject recovery requires a valid request ID');
  }
  if (!RECOVERY_REQUEST_TX || !/^0x[0-9a-f]{64}$/i.test(RECOVERY_REQUEST_TX)) {
    throw new Error('bound Reject recovery requires the exact request transaction');
  }
  const request = await withRpc((client) => client.readContract({
    address: MODULE,
    abi: moduleReadAbi,
    functionName: 'getRequest',
    args: [BigInt(RECOVERY_REQUEST_ID)],
  }));
  expect([3, 5], 'a bound Reject may only resume from awaiting or cancelled state').toContain(Number(request[5]));
  const requestReceipt = await withRpc((client) => client.getTransactionReceipt({ hash: RECOVERY_REQUEST_TX }));
  expect(requestReceipt.status, 'recovered request transaction must be successful').toBe('success');
  expect(requestReceipt.to?.toLowerCase(), 'recovered request transaction must target the module').toBe(MODULE.toLowerCase());
  const requestEvents = parseEventLogs({
    abi: [requestEvent],
    logs: requestReceipt.logs,
    eventName: 'SpendRequested',
    strict: true,
  });
  expect(requestEvents).toHaveLength(1);
  expect(requestEvents[0].args.requestId, 'recovered transaction must create the exact request').toBe(BigInt(RECOVERY_REQUEST_ID));

  const recoveryBase = {
    schema: 'veilguard.live-release-recovery' as const,
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    workflow: {
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      sourceCommit: SOURCE_COMMIT,
    },
    production: {
      baseUrl: LIVE_BASE_URL,
      expectedUiSha: expectedUiSha(),
      observedUiSha,
    },
    scenario: {
      name: 'ShieldOps' as const,
      runId: RECOVERY_RUN_ID,
      requestId: RECOVERY_REQUEST_ID,
    },
  };
  await persistRecoveryPointer({
    ...recoveryBase,
    phase: 'request-bound',
    activeBroadcast: {
      mission: 'approval',
      requestId: RECOVERY_REQUEST_ID,
      transactionHash: RECOVERY_REQUEST_TX,
    },
    decision: { action: 'reject' },
  });

  const attestation = await settleBoundReject(RECOVERY_RUN_ID, RECOVERY_REQUEST_ID);
  await persistRecoveryPointer({
    ...recoveryBase,
    generatedAt: new Date().toISOString(),
    phase: 'decision-observed',
    activeBroadcast: {
      mission: 'approval',
      requestId: RECOVERY_REQUEST_ID,
      transactionHash: RECOVERY_REQUEST_TX,
    },
    decision: {
      action: 'reject',
      transactionHash: attestation.hash,
      etherscanUrl: `${ETHERSCAN_TX}${attestation.hash}`,
    },
    attestation,
  });
  const onchain = await verifyOnchainDecision('reject', RECOVERY_REQUEST_ID, attestation.hash);
  expect(onchain.request.hash.toLowerCase(), 'recovered request pointer must match the on-chain request event')
    .toBe(RECOVERY_REQUEST_TX.toLowerCase());
  const evidence = buildLiveEvidence({
    action: 'reject',
    observedUiSha,
    runId: RECOVERY_RUN_ID,
    requestId: RECOVERY_REQUEST_ID,
    transactionHash: attestation.hash,
    attestation,
    onchain,
  });
  await persistEvidence(evidence);
  console.info(`[live-reject] recovered exact bound request ${JSON.stringify(evidence)}`);
}

test.describe('production Sepolia release gate', () => {
  test.describe.configure({ mode: 'serial', retries: 0 });

  const action = releaseAction();
  test(`ShieldOps ${action} executes one user-attested Safe path`, async ({ page }) => {
    test.setTimeout(720_000);

    // This check runs before any CTA that can mutate Sepolia.
    const observedUiSha = await assertProductionUiSha(page);

    if (RECOVERY_MODE === 'bound') {
      expect(action, 'only the sequential Reject job may resume a bound request').toBe('reject');
      await recoverBoundReject(observedUiSha);
      return;
    }

    console.info(`[live-${action}] starting fresh production run`);
    await startFreshLiveRun(page);
    const startedSession = await readSessionEvidence(page);
    expect(startedSession.runId).toMatch(/^[A-Za-z0-9_-]{8,96}$/);
    let boundSession = startedSession;
    const recoveryBase = {
      schema: 'veilguard.live-release-recovery' as const,
      version: 1 as const,
      generatedAt: new Date().toISOString(),
      workflow: {
        repository: process.env.GITHUB_REPOSITORY,
        runId: process.env.GITHUB_RUN_ID,
        sourceCommit: SOURCE_COMMIT,
      },
      production: {
        baseUrl: LIVE_BASE_URL,
        expectedUiSha: expectedUiSha(),
        observedUiSha,
      },
      scenario: {
        name: 'ShieldOps' as const,
        runId: startedSession.runId!,
      },
    };
    await persistRecoveryPointer({
      ...recoveryBase,
      phase: 'run-started',
      decision: { action },
    });

    try {
      await submitSelectedInvoice(page, /payment completed privately/i);
      console.info(`[live-${action}] CloudNode direct execution confirmed`);
      const routineSession = await readSessionEvidence(page);
      await persistRecoveryPointer({
        ...recoveryBase,
        generatedAt: new Date().toISOString(),
        phase: 'routine-observed',
        scenario: {
          ...recoveryBase.scenario,
          ...(routineSession.routineRequestId ? { routineRequestId: routineSession.routineRequestId } : {}),
        },
        decision: { action },
        ...(routineSession.activeBroadcast ? { activeBroadcast: routineSession.activeBroadcast } : {}),
      });

      const continueToShieldOps = page.getByRole('button', { name: /continue to shieldops/i });
      await expect(continueToShieldOps).toBeVisible();
      await continueToShieldOps.click();
      await expect(page.getByRole('article', { name: /ShieldOps payment detail/i })).toBeVisible();
      await submitSelectedInvoice(page, /payment held for approval/i);
      console.info(`[live-${action}] ShieldOps escrow reservation confirmed`);

      boundSession = await readSessionEvidence(page);
      expect(boundSession.runId).toBe(startedSession.runId);
      expect(boundSession.requestId).toMatch(/^\d+$/);
      await persistRecoveryPointer({
        ...recoveryBase,
        generatedAt: new Date().toISOString(),
        phase: 'request-bound',
        scenario: {
          ...recoveryBase.scenario,
          ...(boundSession.routineRequestId ? { routineRequestId: boundSession.routineRequestId } : {}),
          requestId: boundSession.requestId!,
        },
        decision: { action },
        ...(boundSession.activeBroadcast ? { activeBroadcast: boundSession.activeBroadcast } : {}),
      });

      const decision = action === 'approve'
      ? page.getByRole('button', { name: /approve payment/i })
      : page.getByRole('button', { name: /reject & return funds/i });
    await expect(decision).toBeEnabled();
    await decision.click();

    const activeDecision = action === 'approve'
      ? page.getByRole('button', { name: /executing 2-of-2/i })
      : page.getByRole('button', { name: /returning funds/i });
    await expect(activeDecision).toHaveAttribute('aria-busy', 'true', { timeout: 3_000 });
    console.info(`[live-${action}] decision accepted with visible busy state`);

    let transactionLink: string | null;
    if (action === 'approve') {
      await expect(page.getByText(/committee approved the policy exception/i)).toBeVisible({ timeout: 240_000 });
      const approvalLink = page.getByRole('link', { name: /view approval/i });
      await expect(approvalLink).toHaveAttribute('href', /sepolia\.etherscan\.io\/tx\/0x[0-9a-f]{64}/i);
      transactionLink = await approvalLink.getAttribute('href');
    } else {
      await expect(page.getByText(/user rejected · funds returned/i).first()).toBeVisible({ timeout: 240_000 });
      const moreActions = page.locator('summary').filter({ hasText: 'More actions' });
      await expect(moreActions).toBeVisible();
      await moreActions.click();
      await page.getByRole('button', { name: /open request detail/i }).click();
      await expect(page.locator('header.request-detail-heading').getByRole('heading', { name: /request #\d+/i, level: 1 })).toBeVisible();
      const cancellationLink = page.getByText('Safe cancellation', { exact: true }).locator('..').getByRole('link');
      await expect(cancellationLink).toHaveAttribute('href', /sepolia\.etherscan\.io\/tx\/0x[0-9a-f]{64}/i);
      transactionLink = await cancellationLink.getAttribute('href');
    }

    const session = await readSessionEvidence(page);
    expect(session.runId).toMatch(/^[A-Za-z0-9_-]{8,96}$/);
    expect(session.requestId).toMatch(/^\d+$/);
    expect(session.decision).toBe(action);
    expect(session.transactionHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(transactionLink).toContain(session.transactionHash);

    await persistRecoveryPointer({
      ...recoveryBase,
      generatedAt: new Date().toISOString(),
      phase: 'decision-observed',
      decision: {
        action,
        transactionHash: session.transactionHash as `0x${string}`,
        etherscanUrl: transactionLink!,
      },
    });

    const attestation = await readDecisionAttestation(page, session.runId!, session.requestId!);
    const chainState = action === 'approve' ? 2 : 5;
    expect(attestation.status).toBe(200);
    expect(attestation.body).toEqual(expect.objectContaining({
      ok: true,
      requestId: Number(session.requestId),
      origin: 'user',
      action,
      chainState,
      hash: session.transactionHash,
    }));
    const onchain = await verifyOnchainDecision(
      action,
      session.requestId!,
      session.transactionHash as `0x${string}`,
    );

    const evidence = buildLiveEvidence({
      action,
      observedUiSha,
      runId: session.runId!,
      requestId: session.requestId!,
      transactionHash: session.transactionHash as `0x${string}`,
      attestation: attestation.body,
      onchain,
    });
    await persistEvidence(evidence);
    console.info(`[live-${action}] ${JSON.stringify(evidence)}`);
    } finally {
      // This must not turn a post-decision verification failure into a blind
      // fresh run. Best-effort session + server attestation recovery always
      // leaves a versioned run/request/tx pointer in the uploaded artifact.
      try {
        const latest = await readSessionEvidence(page);
        let attestation: LiveDecisionAttestation | undefined;
        if (boundSession.runId && boundSession.requestId) {
          const recovered = await readDecisionAttestation(page, boundSession.runId, boundSession.requestId);
          if (recovered.status === 200
            && recovered.body?.origin === 'user'
            && recovered.body.action === action) {
            attestation = recovered.body;
          }
        }
        const transactionHash = (latest.transactionHash ?? attestation?.hash) as `0x${string}` | undefined;
        const phase: LiveReleaseRecoveryPointerV1['phase'] = transactionHash
          ? 'decision-observed'
          : latest.requestId
            ? 'request-bound'
            : latest.routineRequestId
              ? 'routine-observed'
              : 'run-started';
        await persistRecoveryPointer({
          ...recoveryBase,
          generatedAt: new Date().toISOString(),
          phase,
          scenario: {
            ...recoveryBase.scenario,
            ...(latest.routineRequestId ? { routineRequestId: latest.routineRequestId } : {}),
            ...(latest.requestId ? { requestId: latest.requestId } : {}),
          },
          decision: {
            action,
            ...(transactionHash ? {
              transactionHash,
              etherscanUrl: `${ETHERSCAN_TX}${transactionHash}`,
            } : {}),
          },
          ...(latest.activeBroadcast ? { activeBroadcast: latest.activeBroadcast } : {}),
          ...(attestation ? { attestation } : {}),
        });
      } catch (recoveryError) {
        console.error(`[live-${action}] unable to refresh recovery pointer`, recoveryError);
      }
    }
  });
});
