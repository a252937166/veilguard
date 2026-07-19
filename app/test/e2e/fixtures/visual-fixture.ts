import type { Page, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  multicall3Abi,
  parseAbiItem,
  type Hex,
} from 'viem';

const deployments = JSON.parse(readFileSync(new URL('../../../src/deployments.json', import.meta.url), 'utf8')) as {
  contracts: Record<'TestUSDC' | 'ConfidentialUSDC' | 'Safe' | 'VeilGuardModule' | 'NoxCompute', `0x${string}`>;
  roles: Record<'financeAdmin' | 'signerB' | 'delegate' | 'auditor' | 'deployer', `0x${string}`>;
};
const moduleAbi = JSON.parse(readFileSync(new URL('../../../src/module-abi.json', import.meta.url), 'utf8')) as any[];
const ADDR = deployments.contracts;
const ROLES = deployments.roles;
const safeAbi = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
] as const;

const DEMO_RECIPIENTS = {
  cloudNode: '0x04ebe79419f42f12748aba1502331e336219b1f7',
  shieldOps: '0xe32148e45c3b1f8a692bec3baa0079ad103a4c6b',
  atlas: '0x6152f8ebe4e9b35c5042e095fc0e4af98c6a347d',
} as const;
const VIOLATION_DELEGATE = '0xdfc0c6e0baed0948d8ba22a4917438938f2a40f4' as const;
const FREEPLAY_DELEGATE = '0x2fc2dc420540b3a93d6fa45f07c536c305a96497' as const;

export type VisualSurface =
  | 'landing'
  | 'payments'
  | 'request-detail'
  | 'approval-decision'
  | 'disclosure-review'
  | 'audit-review';

type VisualMandate = {
  id: bigint;
  delegate: `0x${string}`;
  validFrom: bigint;
  validUntil: bigint;
  version: number;
  state: number;
  autoLimit: Hex;
  budgetLeft: Hex;
  reserveFloor: Hex;
  recipients: `0x${string}`[];
};

type VisualRequest = {
  id: bigint;
  mandateId: bigint;
  delegate: `0x${string}`;
  recipient: `0x${string}`;
  memoHash: Hex;
  createdAt: bigint;
  state: number;
  amount: Hex;
  decision: Hex;
  blockedReason: Hex;
};

type VisualPacket = {
  id: bigint;
  auditor: `0x${string}`;
  mandateId: bigint;
  policyVersion: number;
  manifestHash: Hex;
  createdAt: bigint;
  requestIds: bigint[];
  snapshotHandles: Hex[];
};

export type VisualFixtureV1 = {
  version: 1;
  nowIso: string;
  runId: string;
  delegate: `0x${string}`;
  owners: readonly `0x${string}`[];
  financeAdmin: `0x${string}`;
  mandates: VisualMandate[];
  requests: VisualRequest[];
  packets: VisualPacket[];
  transactionHashes: Record<'request1' | 'request2' | 'request3' | 'direct' | 'escalated' | 'approved' | 'blocked', Hex>;
};

const MAIN_DELEGATE = '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532' as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const FIXED_BLOCK = 11_296_120n;
const hex32 = (value: number): Hex => `0x${value.toString(16).padStart(64, '0')}`;
const MEMO_DOMAIN = keccak256(new TextEncoder().encode('VEILGUARD_DEMO_RUN_V1'));
const memoHash = (
  runId: string,
  scenario: 'routine' | 'approval' | 'violation',
  mandateId: bigint,
  delegate: `0x${string}`,
): Hex => keccak256(encodeAbiParameters(
  [
    { type: 'bytes32' },
    { type: 'uint256' },
    { type: 'address' },
    { type: 'bytes32' },
    { type: 'bytes32' },
    { type: 'uint256' },
    { type: 'address' },
  ],
  [
    MEMO_DOMAIN,
    11_155_111n,
    ADDR.VeilGuardModule,
    keccak256(new TextEncoder().encode(runId)),
    keccak256(new TextEncoder().encode(scenario)),
    mandateId,
    delegate,
  ],
));

const manifestFor = (packet: Omit<VisualPacket, 'manifestHash'>): Hex => keccak256(encodeAbiParameters(
  [
    { type: 'address' },
    { type: 'uint256' },
    { type: 'uint32' },
    { type: 'uint256[]' },
    { type: 'bytes32[]' },
  ],
  [packet.auditor, packet.mandateId, packet.policyVersion, packet.requestIds, packet.snapshotHandles],
));

export function createVisualFixture(surface: VisualSurface): VisualFixtureV1 {
  const now = 1_721_297_100n; // 2024-07-18 10:05:00 UTC
  const approvalState = surface === 'approval-decision' || surface === 'payments' ? 3 : 2;
  const mandates: VisualMandate[] = [
    {
      id: 1n,
      delegate: MAIN_DELEGATE,
      validFrom: now - 86_400n,
      validUntil: now + 2_592_000n,
      version: 4,
      state: 2,
      autoLimit: hex32(11),
      budgetLeft: hex32(12),
      reserveFloor: hex32(13),
      recipients: [DEMO_RECIPIENTS.cloudNode, DEMO_RECIPIENTS.shieldOps],
    },
    {
      id: 2n,
      delegate: VIOLATION_DELEGATE,
      validFrom: now - 86_400n,
      validUntil: now + 2_592_000n,
      version: 4,
      state: 2,
      autoLimit: hex32(21),
      budgetLeft: hex32(22),
      reserveFloor: hex32(23),
      recipients: [DEMO_RECIPIENTS.atlas],
    },
    {
      id: 3n,
      delegate: FREEPLAY_DELEGATE,
      validFrom: now - 86_400n,
      validUntil: now + 2_592_000n,
      version: 4,
      state: 2,
      autoLimit: hex32(31),
      budgetLeft: hex32(32),
      reserveFloor: hex32(33),
      recipients: [DEMO_RECIPIENTS.cloudNode, DEMO_RECIPIENTS.shieldOps, DEMO_RECIPIENTS.atlas],
    },
  ];
  const requests: VisualRequest[] = [
    {
      id: 1n,
      mandateId: 1n,
      delegate: MAIN_DELEGATE,
      recipient: DEMO_RECIPIENTS.cloudNode,
      memoHash: memoHash('launch-visual-v1', 'routine', 1n, MAIN_DELEGATE),
      createdAt: now - 1_100n,
      state: 2,
      amount: hex32(101),
      decision: hex32(102),
      blockedReason: hex32(103),
    },
    {
      id: 2n,
      mandateId: 1n,
      delegate: MAIN_DELEGATE,
      recipient: DEMO_RECIPIENTS.shieldOps,
      memoHash: memoHash('launch-visual-v1', 'approval', 1n, MAIN_DELEGATE),
      createdAt: now - 620n,
      state: approvalState,
      amount: hex32(201),
      decision: hex32(202),
      blockedReason: hex32(203),
    },
    {
      id: 3n,
      mandateId: 2n,
      delegate: VIOLATION_DELEGATE,
      recipient: DEMO_RECIPIENTS.atlas,
      memoHash: memoHash('launch-visual-v1', 'violation', 2n, VIOLATION_DELEGATE),
      createdAt: now - 240n,
      state: 4,
      amount: hex32(301),
      decision: hex32(302),
      blockedReason: hex32(303),
    },
  ];

  const packet1WithoutManifest: Omit<VisualPacket, 'manifestHash'> = {
    id: 1n,
    auditor: ROLES.auditor,
    mandateId: 1n,
    policyVersion: 4,
    createdAt: now - 120n,
    requestIds: [1n, 2n],
    snapshotHandles: [hex32(401), hex32(402), hex32(403), hex32(404), hex32(405), hex32(406), hex32(407)],
  };
  const packet2WithoutManifest: Omit<VisualPacket, 'manifestHash'> = {
    id: 2n,
    auditor: ROLES.auditor,
    mandateId: 2n,
    policyVersion: 4,
    createdAt: now - 60n,
    requestIds: [3n],
    snapshotHandles: [hex32(501), hex32(502), hex32(503), hex32(504), hex32(505)],
  };

  return {
    version: 1,
    nowIso: '2024-07-18T10:05:00.000Z',
    runId: 'launch-visual-v1',
    delegate: MAIN_DELEGATE,
    owners: [ROLES.financeAdmin, ROLES.signerB],
    financeAdmin: ROLES.financeAdmin,
    mandates,
    requests,
    packets: [
      { ...packet1WithoutManifest, manifestHash: manifestFor(packet1WithoutManifest) },
      { ...packet2WithoutManifest, manifestHash: manifestFor(packet2WithoutManifest) },
    ],
    transactionHashes: {
      request1: hex32(901),
      request2: hex32(902),
      request3: hex32(903),
      direct: hex32(911),
      escalated: hex32(912),
      approved: hex32(913),
      blocked: hex32(914),
    },
  };
}

const eventAbi = {
  requested: parseAbiItem('event SpendRequested(uint256 indexed requestId, uint256 indexed mandateId, address indexed delegate, address recipient, bytes32 decisionHandle)'),
  executed: parseAbiItem('event SpendExecuted(uint256 indexed requestId)'),
  blocked: parseAbiItem('event SpendBlocked(uint256 indexed requestId)'),
  escalated: parseAbiItem('event EscalationReady(uint256 indexed requestId)'),
  approved: parseAbiItem('event EscalationExecuted(uint256 indexed requestId)'),
} as const;

type EventKey = keyof typeof eventAbi;

function visualLogs(fixture: VisualFixtureV1) {
  let logIndex = 0;
  const makeLog = (
    kind: EventKey,
    request: VisualRequest,
    transactionHash: Hex,
  ) => {
    const abi = eventAbi[kind];
    const args = kind === 'requested'
      ? {
          requestId: request.id,
          mandateId: request.mandateId,
          delegate: request.delegate,
          recipient: request.recipient,
          decisionHandle: request.decision,
        }
      : { requestId: request.id };
    const topics = encodeEventTopics({ abi: [abi], eventName: abi.name, args: args as never });
    const data = kind === 'requested'
      ? encodeAbiParameters(
          [{ type: 'address' }, { type: 'bytes32' }],
          [request.recipient, request.decision],
        )
      : '0x';
    const index = logIndex++;
    return {
      address: ADDR.VeilGuardModule,
      blockHash: hex32(800),
      blockNumber: `0x${FIXED_BLOCK.toString(16)}`,
      data,
      logIndex: `0x${index.toString(16)}`,
      removed: false,
      topics,
      transactionHash,
      transactionIndex: '0x0',
    };
  };

  const [routine, approval, blocked] = fixture.requests;
  return [
    makeLog('requested', routine, fixture.transactionHashes.request1),
    makeLog('requested', approval, fixture.transactionHashes.request2),
    makeLog('requested', blocked, fixture.transactionHashes.request3),
    makeLog('executed', routine, fixture.transactionHashes.direct),
    makeLog('escalated', approval, fixture.transactionHashes.escalated),
    ...(approval.state === 2 ? [makeLog('approved', approval, fixture.transactionHashes.approved)] : []),
    makeLog('blocked', blocked, fixture.transactionHashes.blocked),
  ];
}

function encodeContractResult(fixture: VisualFixtureV1, target: string, data: Hex): Hex {
  const targetLower = target.toLowerCase();
  const abi = targetLower === ADDR.Safe.toLowerCase() ? safeAbi : moduleAbi;
  const decoded = decodeFunctionData({ abi: abi as never, data });
  const args = (decoded.args ?? []) as readonly unknown[];
  let result: unknown;

  switch (decoded.functionName) {
    case 'nextMandateId': result = BigInt(fixture.mandates.length + 1); break;
    case 'nextRequestId': result = BigInt(fixture.requests.length + 1); break;
    case 'nextPacketId': result = BigInt(fixture.packets.length + 1); break;
    case 'getOwners': result = [...fixture.owners]; break;
    case 'financeAdmin': result = fixture.financeAdmin; break;
    case 'paused': result = false; break;
    case 'cooldownUntil': result = 0n; break;
    case 'activeMandateOf': {
      const delegate = String(args[0]).toLowerCase();
      result = fixture.mandates.find((mandate) => mandate.delegate.toLowerCase() === delegate)?.id ?? 0n;
      break;
    }
    case 'pendingRequestOf': result = 0n; break;
    case 'getMandate': {
      const mandate = fixture.mandates.find((candidate) => candidate.id === BigInt(args[0] as bigint));
      if (!mandate) throw new Error(`Unknown visual mandate ${String(args[0])}`);
      result = [
        mandate.delegate,
        mandate.validFrom,
        mandate.validUntil,
        mandate.version,
        mandate.state,
        mandate.autoLimit,
        mandate.budgetLeft,
        mandate.reserveFloor,
        mandate.recipients,
      ];
      break;
    }
    case 'getRequest': {
      const request = fixture.requests.find((candidate) => candidate.id === BigInt(args[0] as bigint));
      if (!request) throw new Error(`Unknown visual request ${String(args[0])}`);
      result = [
        request.mandateId,
        request.delegate,
        request.recipient,
        request.memoHash,
        request.createdAt,
        request.state,
        request.amount,
        request.decision,
        request.blockedReason,
      ];
      break;
    }
    case 'getAuditPacket': {
      const packet = fixture.packets.find((candidate) => candidate.id === BigInt(args[0] as bigint));
      if (!packet) throw new Error(`Unknown visual packet ${String(args[0])}`);
      result = [
        packet.auditor,
        packet.mandateId,
        packet.policyVersion,
        packet.manifestHash,
        packet.createdAt,
        packet.requestIds,
        packet.snapshotHandles,
      ];
      break;
    }
    case 'isAllowedRecipient': result = true; break;
    case 'safe': result = ADDR.Safe; break;
    case 'token': result = ADDR.ConfidentialUSDC; break;
    default: throw new Error(`Unsupported visual eth_call ${decoded.functionName}`);
  }

  return encodeFunctionResult({
    abi: abi as never,
    functionName: decoded.functionName as never,
    result: result as never,
  });
}

function ethCallResult(fixture: VisualFixtureV1, call: { to?: string; data?: Hex }): Hex {
  if (!call.to || !call.data) throw new Error('Visual eth_call is missing a target or calldata.');
  if (call.to.toLowerCase() !== MULTICALL3) return encodeContractResult(fixture, call.to, call.data);

  const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data });
  if (decoded.functionName !== 'aggregate3') throw new Error(`Unsupported Multicall3 function ${decoded.functionName}`);
  const calls = decoded.args[0];
  const results = calls.map((item) => {
    try {
      return { success: true, returnData: encodeContractResult(fixture, item.target, item.callData) };
    } catch {
      return { success: false, returnData: '0x' as const };
    }
  });
  return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results });
}

function rpcResponse(fixture: VisualFixtureV1, logs: ReturnType<typeof visualLogs>, request: any) {
  const method = request.method as string;
  let result: unknown;
  switch (method) {
    case 'net_listening': result = true; break;
    case 'net_version': result = '11155111'; break;
    case 'eth_chainId': result = '0xaa36a7'; break;
    case 'eth_blockNumber': result = `0x${FIXED_BLOCK.toString(16)}`; break;
    case 'eth_getCode': result = '0x6000'; break;
    case 'eth_call': result = ethCallResult(fixture, request.params[0]); break;
    case 'eth_getLogs': {
      const topic = request.params?.[0]?.topics?.[0]?.toLowerCase?.();
      result = topic ? logs.filter((log) => log.topics[0]?.toLowerCase() === topic) : logs;
      break;
    }
    default: throw new Error(`Unexpected visual RPC method ${method}`);
  }
  return { jsonrpc: '2.0', id: request.id, result };
}

function sessionFor(fixture: VisualFixtureV1, surface: VisualSurface, role: 'delegate' | 'auditor') {
  const now = Date.parse(fixture.nowIso);
  const approvalComplete = fixture.requests[1].state === 2;
  const route = surface === 'payments' ? { page: 'payment-inbox' }
    : surface === 'request-detail' ? { page: 'payment-detail', requestId: '1' }
      : surface === 'approval-decision' ? { page: 'approval-detail', requestId: '2' }
        : surface === 'disclosure-review' ? { page: 'disclosure-builder' }
          : { page: 'audit-detail', packetId: '1' };
  return {
    version: 2,
    runId: fixture.runId,
    lifecycle: 'active',
    currentMission: approvalComplete ? 'audit' : 'approval',
    role,
    route,
    selected: surface === 'request-detail' || surface === 'approval-decision'
      ? { requestId: surface === 'request-detail' ? '1' : '2' }
      : surface === 'audit-review' ? { packetId: '1' } : {},
    missions: {
      routine: {
        runId: fixture.runId,
        status: 'complete',
        requestId: '1',
        outcome: 'executed',
        packetIds: [],
        includedRequestIds: [],
        reviewedRequestIds: [],
        flaggedRequestIds: [],
        updatedAt: now,
      },
      approval: {
        runId: fixture.runId,
        status: approvalComplete ? 'complete' : 'active',
        requestId: '2',
        ...(approvalComplete
          ? {
              outcome: 'safe-approved',
              decision: 'approve',
              decisionConfirmed: true,
              decisionTx: fixture.transactionHashes.approved,
            }
          : {}),
        packetIds: [],
        includedRequestIds: [],
        reviewedRequestIds: [],
        flaggedRequestIds: [],
        updatedAt: now,
      },
      violation: {
        runId: fixture.runId,
        status: approvalComplete ? 'complete' : 'locked',
        requestId: '3',
        outcome: 'blocked',
        reasonDecrypted: true,
        packetIds: [],
        includedRequestIds: [],
        reviewedRequestIds: [],
        flaggedRequestIds: [],
        updatedAt: now,
      },
      audit: {
        runId: fixture.runId,
        status: 'ready',
        packetIds: surface === 'audit-review' ? ['1', '2'] : [],
        includedRequestIds: surface === 'audit-review' ? ['1', '2', '3'] : [],
        reviewedRequestIds: [],
        flaggedRequestIds: [],
        updatedAt: now,
      },
    },
    tour: { active: false, step: 0, paused: false },
    restart: { status: 'idle' },
    createdAt: now - 1_200_000,
    updatedAt: now,
  };
}

export async function installVisualFixture(page: Page, surface: VisualSurface) {
  const fixture = createVisualFixture(surface);
  const logs = visualLogs(fixture);
  const role = surface === 'audit-review' ? 'auditor' : 'delegate';
  const session = surface === 'landing' ? null : sessionFor(fixture, surface, role);
  const unexpectedNetwork: string[] = [];

  const disclosedValues = Object.fromEntries([
    [fixture.packets[0].snapshotHandles[0], '25000000'],
    [fixture.packets[0].snapshotHandles[1], '915000000'],
    [fixture.packets[0].snapshotHandles[2], '300000000'],
    [fixture.packets[0].snapshotHandles[3], '25000000'],
    [fixture.packets[0].snapshotHandles[4], '0'],
    [fixture.packets[0].snapshotHandles[5], '60000000'],
    [fixture.packets[0].snapshotHandles[6], '0'],
    [fixture.packets[1].snapshotHandles[0], '25000000'],
    [fixture.packets[1].snapshotHandles[1], '315000000'],
    [fixture.packets[1].snapshotHandles[2], '300000000'],
    [fixture.packets[1].snapshotHandles[3], '600000000'],
    [fixture.packets[1].snapshotHandles[4], '1'],
  ]);

  await page.addInitScript(({ fixedIso, demoRole, demoSession, auditReviews, values }) => {
    const fixedTime = Date.parse(fixedIso);
    const NativeDate = Date;
    class FixedDate extends NativeDate {
      constructor(value?: string | number | Date) {
        super(value === undefined ? fixedTime : value);
      }
      static now() { return fixedTime; }
    }
    const withUtc = (options?: Intl.DateTimeFormatOptions) => ({ timeZone: 'UTC', ...options });
    FixedDate.prototype.toLocaleString = function(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return NativeDate.prototype.toLocaleString.call(this, locales, withUtc(options));
    };
    FixedDate.prototype.toLocaleDateString = function(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return NativeDate.prototype.toLocaleDateString.call(this, locales, withUtc(options));
    };
    FixedDate.prototype.toLocaleTimeString = function(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return NativeDate.prototype.toLocaleTimeString.call(this, locales, withUtc(options));
    };
    Object.defineProperty(window, 'Date', { configurable: true, value: FixedDate });
    sessionStorage.clear();
    localStorage.clear();
    if (demoRole) sessionStorage.setItem('vg_demo', demoRole);
    if (demoSession) sessionStorage.setItem('vg_demo_session_v2', JSON.stringify(demoSession));
    if (auditReviews) localStorage.setItem('vg_audit_reviews_v1', JSON.stringify(auditReviews));
    (window as any).__VG_VISUAL_DECRYPTED_VALUES__ = values;
  }, {
    fixedIso: fixture.nowIso,
    demoRole: session ? role : null,
    demoSession: session,
    auditReviews: surface === 'audit-review'
      ? {
          [`11155111:${ADDR.VeilGuardModule.toLowerCase()}:${ROLES.auditor.toLowerCase()}:1`]: {
            1: 'reviewed',
            2: 'flagged',
          },
        }
      : null,
    values: disclosedValues,
  });

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/demo-decision' && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          requestId: 2,
          chainState: 2,
          origin: 'user',
          action: 'approve',
          hash: fixture.transactionHashes.approved,
        }),
      });
      return;
    }
    if (surface === 'audit-review' && url.pathname === '/src/nox.ts') {
      const response = await route.fetch();
      const original = await response.text();
      const mockStart = original.indexOf('export function handleClientFor(account)');
      const sourceMapStart = original.indexOf('//# sourceMappingURL=');
      if (mockStart < 0 || sourceMapStart < 0) {
        unexpectedNetwork.push('Unable to install the test-only Nox decrypt adapter.');
        await route.fulfill({ response, body: original });
        return;
      }
      const mocked = `${original.slice(0, mockStart)}
export async function handleClientFor() {
  return {
    decrypt: async (handle) => ({
      value: window.__VG_VISUAL_DECRYPTED_VALUES__?.[String(handle).toLowerCase()] ?? "0",
      solidityType: "uint256",
    }),
  };
}
export async function handlesResolved() { return true; }
export async function waitResolved() {}
${original.slice(sourceMapStart)}`;
      await route.fulfill({ response, body: mocked });
      return;
    }
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      await route.continue();
      return;
    }
    const postData = request.postData();
    if (request.method() === 'POST' && postData) {
      try {
        const parsed = JSON.parse(postData);
        const requests = Array.isArray(parsed) ? parsed : [parsed];
        const responses = requests.map((item) => rpcResponse(fixture, logs, item));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(Array.isArray(parsed) ? responses : responses[0]),
        });
        return;
      } catch (error) {
        unexpectedNetwork.push(`${request.method()} ${request.url()} · ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      unexpectedNetwork.push(`${request.method()} ${request.url()}`);
    }
    await route.abort('blockedbyclient');
  });

  return { fixture, unexpectedNetwork };
}
