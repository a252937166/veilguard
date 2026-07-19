// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const appContext = vi.hoisted(() => ({ current: {} as any }));
const sessionState = vi.hoisted(() => ({ current: null as any }));
const completeMission = vi.hoisted(() => vi.fn());
const advanceGuidedMission = vi.hoisted(() => vi.fn());

vi.mock('../src/App', () => ({ useApp: () => appContext.current }));
vi.mock('../src/demo-session', async () => {
  const actual = await vi.importActual<typeof import('../src/demo-session')>('../src/demo-session');
  return { ...actual, loadDemoSession: () => sessionState.current };
});
vi.mock('../src/missions', () => ({ completeMission, advanceGuidedMission }));
vi.mock('../src/nox', () => ({ publicClient: {
  getBlockNumber: vi.fn(async () => 100n),
  getLogs: vi.fn(),
  getTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  getTransactionReceipt: vi.fn(),
  readContract: vi.fn(),
} }));
vi.mock('../src/walletTx', () => ({ walletWrite: vi.fn() }));

import { DEMO_SCENARIOS, demoMemoHash } from '../src/demo-scenarios';
import { ROLES } from '../src/config';
import { createDemoSession, demoSessionReducer } from '../src/demo-session';
import { DisclosureView } from '../src/views/DisclosureView';
import { publicClient } from '../src/nox';
import { walletWrite } from '../src/walletTx';
import { ADDR, moduleAbi } from '../src/config';
import {
  createAdminDisclosureCheckpoint,
  loadAdminDisclosureCheckpoint,
  removeAdminDisclosureCheckpoint,
  saveAdminDisclosureCheckpoint,
  updateAdminDisclosureGroup,
} from '../src/disclosure-checkpoint';
import { encodeAbiParameters, encodeEventTopics } from 'viem';

const handle = `0x${'1'.repeat(64)}` as `0x${string}`;
const liveFinanceAdmin = '0x4444444444444444444444444444444444444444' as const;
const walletRunKey = `wallet:${ADDR.VeilGuardModule.toLowerCase()}`;

function guidedSession(options: { includeRoutine?: boolean } = {}) {
  let session = createDemoSession({ runId: 'launch-selection-test', now: 1 });
  const reduce = (action: any) => {
    session = demoSessionReducer(session, { ...action, runId: session.runId });
  };
  if (options.includeRoutine !== false) reduce({ type: 'ROUTINE_EXECUTED', requestId: '11', at: 2 });
  reduce({ type: 'BIND_REQUEST', mission: 'approval', requestId: '12', at: 3 });
  reduce({ type: 'VIOLATION_BLOCKED', requestId: '13', at: 4 });
  return session;
}

function request(index: number, id: bigint, state: number) {
  const scenario = DEMO_SCENARIOS[index];
  const mandateId = index === 2 ? 2n : 1n;
  const delegate = '0x1111111111111111111111111111111111111111' as `0x${string}`;
  return {
    id,
    mandateId,
    delegate,
    recipient: scenario.recipient,
    memoHash: demoMemoHash('launch-selection-test', scenario.key, mandateId, delegate),
    createdAt: 1n,
    state,
    amount: handle,
    decision: handle,
    blockedReason: handle,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  removeAdminDisclosureCheckpoint(walletRunKey, liveFinanceAdmin);
  window.location.hash = '';
  sessionState.current = guidedSession();
  appContext.current = {
    account: '0x1111111111111111111111111111111111111111',
    financeAdmin: liveFinanceAdmin,
    demoRole: 'delegate',
    requests: [request(0, 11n, 2), request(1, 12n, 5), request(2, 13n, 4)],
    run: vi.fn(async (_operation, fn) => {
      try {
        await fn();
        return { accepted: true, status: 'succeeded' };
      } catch {
        return { accepted: true, status: 'failed' };
      }
    }),
    startDemo: vi.fn(),
    toast: vi.fn(),
  };
  completeMission.mockReset();
  advanceGuidedMission.mockReset();
  vi.mocked(walletWrite).mockReset();
  vi.mocked(publicClient.waitForTransactionReceipt).mockReset();
  vi.mocked(publicClient.getBlockNumber).mockClear();
  vi.mocked(publicClient.getLogs).mockReset();
  vi.mocked(publicClient.getTransaction).mockReset();
  vi.mocked(publicClient.getTransactionReceipt).mockReset();
  vi.mocked(publicClient.readContract).mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({
      bundleId: handle,
      bundleKind: 'ui-aggregate',
      onchainObject: false,
      packets: [{ packetId: 8, mandateId: 1, requestIds: [11], manifestHash: handle, reused: false }],
      fixedPolicyFields: ['autoLimit', 'budgetLeft', 'reserveFloor'],
    }),
  }));
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  removeAdminDisclosureCheckpoint(walletRunKey, liveFinanceAdmin);
  vi.unstubAllGlobals();
});

test('guided builder submits and records the exact selected subset', async () => {
  render(<DisclosureView />);
  const cloud = await screen.findByRole('checkbox', { name: /CloudNode/i });
  const shield = screen.getByRole('checkbox', { name: /ShieldOps/i });
  const atlas = screen.getByRole('checkbox', { name: /Atlas Contractor/i });
  await waitFor(() => {
    expect(cloud).toBeChecked();
    expect(shield).toBeChecked();
    expect(atlas).toBeChecked();
  });

  fireEvent.click(cloud);
  fireEvent.click(shield);
  fireEvent.click(atlas);
  expect(screen.getByRole('button', { name: /review selected scope/i })).toBeDisabled();
  expect(cloud).not.toBeChecked();

  fireEvent.click(cloud);
  fireEvent.click(screen.getByRole('button', { name: /review selected scope/i }));
  expect(screen.getByText('#11')).toBeInTheDocument();
  expect(screen.queryByText('#12')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /request facilitated packet creation/i }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const [, init] = (fetch as any).mock.calls[0];
  expect(JSON.parse(init.body)).toEqual({ runId: 'launch-selection-test', requestIds: ['11'] });
  expect(completeMission).toHaveBeenCalledWith('audit', expect.objectContaining({
    includedRequestIds: ['11'],
    packetIds: [8],
    runId: 'launch-selection-test',
  }));
});

test('guided preparation restores Select, preselects the current uncovered scope and hands off Review to Create', async () => {
  sessionState.current = {
    ...sessionState.current,
    tour: { ...sessionState.current.tour, active: true, step: 4 },
  };
  render(<DisclosureView />);
  const cloud = await screen.findByRole('checkbox', { name: /CloudNode/i });
  const shield = screen.getByRole('checkbox', { name: /ShieldOps/i });
  const atlas = screen.getByRole('checkbox', { name: /Atlas Contractor/i });
  await waitFor(() => {
    expect(cloud).toBeChecked();
    expect(shield).toBeChecked();
    expect(atlas).toBeChecked();
  });

  // Simulate a user changing the prepared scope and progressing on the same
  // route before pressing Launch again.
  fireEvent.click(shield);
  const reviewAction = screen.getByRole('button', { name: /review selected scope/i });
  expect(reviewAction).toHaveAttribute('data-guided-action', 'mission-disclosure');
  expect(reviewAction).toHaveAttribute('data-guided-follow', 'true');
  fireEvent.click(reviewAction);

  const createAction = screen.getByRole('button', { name: /request facilitated packet creation/i });
  expect(createAction).toHaveAttribute('data-guided-action', 'mission-disclosure');
  expect(createAction).not.toHaveAttribute('data-guided-follow');

  act(() => {
    window.dispatchEvent(new CustomEvent('vg-guided-prepare', {
      detail: { targetId: 'mission-disclosure', role: 'delegate', step: 4 },
    }));
  });

  expect(await screen.findByRole('heading', { name: /select terminal requests/i })).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByRole('checkbox', { name: /CloudNode/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /ShieldOps/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Atlas Contractor/i })).toBeChecked();
  });

  // The explicit command is idempotent while already on Select as well.
  const preparedCloud = screen.getByRole('checkbox', { name: /CloudNode/i });
  fireEvent.click(preparedCloud);
  expect(preparedCloud).not.toBeChecked();
  act(() => {
    window.dispatchEvent(new CustomEvent('vg-guided-prepare', {
      detail: { targetId: 'mission-disclosure', role: 'delegate', step: 4 },
    }));
  });
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /CloudNode/i })).toBeChecked());
});

test('guided preparation safely resets a Result surface without creating another packet', async () => {
  sessionState.current = {
    ...sessionState.current,
    tour: { ...sessionState.current.tour, active: true, step: 4 },
  };
  render(<DisclosureView />);
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /CloudNode/i })).toBeChecked());
  fireEvent.click(screen.getByRole('button', { name: /review selected scope/i }));
  fireEvent.click(screen.getByRole('button', { name: /request facilitated packet creation/i }));
  expect(await screen.findByText(/Review Bundle updated/i)).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);

  act(() => {
    window.dispatchEvent(new CustomEvent('vg-guided-prepare', {
      detail: { targetId: 'mission-disclosure', role: 'delegate', step: 4 },
    }));
  });

  expect(await screen.findByRole('heading', { name: /select terminal requests/i })).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByRole('checkbox', { name: /CloudNode/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /ShieldOps/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Atlas Contractor/i })).toBeChecked();
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('missing mission IDs never shift approval and violation scenario labels', async () => {
  sessionState.current = guidedSession({ includeRoutine: false });
  appContext.current.requests = [request(1, 12n, 5), request(2, 13n, 4)];
  render(<DisclosureView />);

  expect(await screen.findByRole('checkbox', { name: /ShieldOps.*Request #12/i })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /Atlas Contractor.*Request #13/i })).toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: /CloudNode/i })).not.toBeInTheDocument();
});

test('observer and real Admin modes expose honest, different capabilities', async () => {
  sessionState.current = null;
  appContext.current.demoRole = null;
  appContext.current.account = undefined;
  const { rerender } = render(<DisclosureView />);
  expect(screen.getByText(/authorised execution required/i)).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

  appContext.current.account = liveFinanceAdmin;
  rerender(<DisclosureView />);
  expect(screen.getByText(/finance admin wallet action/i)).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: /auditor address/i })).toHaveValue(ROLES.auditor);
  expect(screen.getByRole('button', { name: /review selected scope/i })).toBeDisabled();
  fireEvent.click(await screen.findByRole('checkbox', { name: /CloudNode/i }));
  expect(screen.getByRole('button', { name: /review selected scope/i })).toBeEnabled();
});

test('a stale deployment role address does not inherit the rotated on-chain Admin capability', () => {
  sessionState.current = null;
  appContext.current.demoRole = null;
  appContext.current.account = ROLES.financeAdmin;
  appContext.current.financeAdmin = liveFinanceAdmin;
  render(<DisclosureView />);

  expect(screen.getByText(/authorised execution required/i)).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

test('guided remount selects only request IDs that are not already covered', async () => {
  sessionState.current = demoSessionReducer(guidedSession(), {
    type: 'AUDIT_PACKETS_CREATED', runId: 'launch-selection-test',
    packetIds: ['8'], requestIds: ['11'], at: 5,
  });
  render(<DisclosureView />);

  await waitFor(() => {
    expect(screen.getByRole('checkbox', { name: /CloudNode/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /ShieldOps/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Atlas Contractor/i })).toBeChecked();
  });
  expect(screen.getByText(/2 selected · 1\/3 already covered/i)).toBeInTheDocument();
});

test('mismatched live request identity is disabled before Review', async () => {
  const stale = { ...request(0, 11n, 2), memoHash: handle };
  appContext.current.requests = [stale, request(1, 12n, 5), request(2, 13n, 4)];
  render(<DisclosureView />);

  const cloud = await screen.findByRole('checkbox', { name: /Unverified CloudNode binding/i });
  expect(cloud).toBeDisabled();
  expect(cloud).not.toBeChecked();
  expect(screen.getByRole('alert')).toHaveTextContent(/run identity check failed/i);
  expect(screen.getByText(/identity mismatch/i)).toBeInTheDocument();
});

test('Continue as Auditor atomically advances tour role, route and selected packet', async () => {
  sessionState.current = demoSessionReducer(guidedSession(), {
    type: 'AUDIT_PACKETS_CREATED', runId: 'launch-selection-test',
    packetIds: ['8'], requestIds: ['11', '12', '13'], at: 5,
  });
  render(<DisclosureView />);

  fireEvent.click(await screen.findByRole('button', { name: /continue as auditor/i }));
  expect(advanceGuidedMission).toHaveBeenCalledWith({
    step: 5,
    route: { page: 'audit-detail', packetId: '8' },
    role: 'auditor',
    selected: { packetId: '8' },
  });
  expect(appContext.current.startDemo).toHaveBeenCalledWith('auditor');
  expect(window.location.hash).toBe('#/audit/8');
});

const packetLog = (packetId: bigint, mandateId: bigint) => ({
  address: ADDR.VeilGuardModule,
  topics: encodeEventTopics({
    abi: moduleAbi,
    eventName: 'AuditPacketCreated',
    args: { packetId, auditor: ROLES.auditor, mandateId },
  }),
  data: encodeAbiParameters([{ type: 'bytes32' }], [handle]),
});

const packetRead = (
  mandateId: bigint,
  requestIds: bigint[],
  options: { auditor?: `0x${string}`; manifest?: `0x${string}` } = {},
) => [
  options.auditor ?? ROLES.auditor,
  mandateId,
  1,
  options.manifest ?? handle,
  1n,
  requestIds,
  [],
] as const;

function seedAdminCheckpoint(options: {
  runKey: string;
  packetId?: number;
  manifestHash?: `0x${string}`;
  transactionHash?: `0x${string}`;
  signaturePendingAt?: number;
  signatureStartBlock?: string;
}) {
  let checkpoint = createAdminDisclosureCheckpoint({
    runKey: options.runKey,
    account: liveFinanceAdmin,
    auditor: ROLES.auditor,
    groups: { 1: ['11'] },
  });
  checkpoint = updateAdminDisclosureGroup(checkpoint, '1', {
    transactionHash: options.transactionHash,
    signaturePendingAt: options.signaturePendingAt,
    signatureStartBlock: options.signatureStartBlock,
    packetId: options.packetId,
    manifestHash: options.manifestHash,
  });
  saveAdminDisclosureCheckpoint(checkpoint);
}

test('Admin multi-mandate retry reuses checkpointed hashes and skips completed packets', async () => {
  const firstHash = `0x${'a'.repeat(64)}` as `0x${string}`;
  const secondHash = `0x${'b'.repeat(64)}` as `0x${string}`;
  sessionState.current = null;
  appContext.current.demoRole = null;
  appContext.current.account = liveFinanceAdmin;
  appContext.current.requests = [request(0, 11n, 2), request(2, 13n, 4)];
  vi.mocked(walletWrite).mockResolvedValueOnce(firstHash).mockResolvedValueOnce(secondHash);
  vi.mocked(publicClient.waitForTransactionReceipt)
    .mockResolvedValueOnce({ status: 'success', logs: [packetLog(8n, 1n)] } as any)
    .mockRejectedValueOnce(new Error('RPC interrupted'))
    .mockResolvedValueOnce({ status: 'success', logs: [packetLog(9n, 2n)] } as any);
  vi.mocked(publicClient.getTransactionReceipt)
    .mockResolvedValueOnce({ status: 'success', logs: [packetLog(8n, 1n)] } as any);
  vi.mocked(publicClient.readContract)
    .mockResolvedValueOnce(packetRead(1n, [11n]) as any)
    .mockResolvedValueOnce(packetRead(1n, [11n]) as any)
    .mockResolvedValueOnce(packetRead(2n, [13n]) as any);

  render(<DisclosureView />);
  fireEvent.click(await screen.findByRole('checkbox', { name: /CloudNode/i }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Atlas Contractor/i }));
  fireEvent.click(screen.getByRole('button', { name: /review selected scope/i }));
  fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/rpc interrupted/i);
  expect(walletWrite).toHaveBeenCalledTimes(2);
  expect(walletWrite).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 0 }));
  expect(appContext.current.run).toHaveBeenNthCalledWith(1, {
    key: 'audit-packet-create',
    label: 'Create audit packets',
    resources: [`wallet:${liveFinanceAdmin.toLowerCase()}`],
    feedback: 'inline',
  }, expect.any(Function));

  fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));
  await screen.findByText(/Review Bundle updated/i);
  expect(walletWrite).toHaveBeenCalledTimes(2);
  expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(3);
  expect(publicClient.waitForTransactionReceipt).toHaveBeenNthCalledWith(3, expect.objectContaining({ hash: secondHash }));
  expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: firstHash });
  expect(publicClient.readContract).toHaveBeenCalledTimes(3);
  expect(screen.getByText(/2 packets/i)).toBeInTheDocument();
  expect(appContext.current.run).toHaveBeenCalledTimes(2);
  expect(loadAdminDisclosureCheckpoint(walletRunKey, liveFinanceAdmin)).toBeNull();
});

test('a conflicting wallet operation keeps Admin creation in Review and performs no wallet write', async () => {
  sessionState.current = null;
  appContext.current.demoRole = null;
  appContext.current.account = liveFinanceAdmin;
  appContext.current.requests = [request(0, 11n, 2)];
  appContext.current.run = vi.fn().mockResolvedValue({
    accepted: false,
    status: 'blocked',
    blocker: { key: 'mandate-proposal', label: 'Propose encrypted mandate', startedAt: 10 },
  });

  render(<DisclosureView />);
  fireEvent.click(await screen.findByRole('checkbox', { name: /CloudNode/i }));
  fireEvent.click(screen.getByRole('button', { name: /review selected scope/i }));
  fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/Propose encrypted mandate is using this wallet/i);
  expect(screen.getByRole('button', { name: /create packets with admin wallet/i })).toBeEnabled();
  expect(walletWrite).not.toHaveBeenCalled();
});

test('Admin creation aborts before the wallet when durable recovery storage is unavailable', async () => {
  sessionState.current = null;
  appContext.current.demoRole = null;
  appContext.current.account = liveFinanceAdmin;
  appContext.current.requests = [request(0, 11n, 2)];
  const nativeSetItem = Storage.prototype.setItem;
  const storageSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(key, value) {
    if (this === localStorage) throw new DOMException('storage disabled', 'QuotaExceededError');
    return nativeSetItem.call(this, key, value);
  });

  try {
    render(<DisclosureView />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /CloudNode/i }));
    fireEvent.click(screen.getByRole('button', { name: /review selected scope/i }));
    fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/durable recovery storage is unavailable/i);
    expect(walletWrite).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));
    await waitFor(() => expect(walletWrite).not.toHaveBeenCalled());
  } finally {
    storageSpy.mockRestore();
  }
});

test('an unknown wallet prompt survives reload and cannot be cleared or signed again', async () => {
  sessionState.current = null;
  appContext.current.demoRole = null;
  appContext.current.account = liveFinanceAdmin;
  appContext.current.requests = [request(0, 11n, 2)];
  seedAdminCheckpoint({
    runKey: walletRunKey,
    signaturePendingAt: Date.now(),
    signatureStartBlock: '99',
  });
  vi.mocked(publicClient.getLogs).mockResolvedValue([] as any);

  render(<DisclosureView />);
  expect(await screen.findByText(/wallet request.*unknown outcome/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));
  expect(await screen.findByText(/will not request another signature/i)).toBeInTheDocument();
  expect(walletWrite).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /clear marker|i rejected/i })).not.toBeInTheDocument();
  expect(screen.getByText(/cannot be cleared from this recovered page/i)).toBeInTheDocument();
  expect(loadAdminDisclosureCheckpoint(walletRunKey, liveFinanceAdmin)?.groups['1'].signaturePendingAt).toBeTypeOf('number');
  expect(walletWrite).not.toHaveBeenCalled();
});

test('the unknown-signature marker is durable before the wallet RPC and clears on explicit rejection', async () => {
  sessionState.current = null;
  appContext.current.demoRole = null;
  appContext.current.account = liveFinanceAdmin;
  appContext.current.requests = [request(0, 11n, 2)];
  let observedPending = false;
  vi.mocked(walletWrite).mockImplementationOnce(async (options: any) => {
    options.onRequestStarted();
    observedPending = !!loadAdminDisclosureCheckpoint(walletRunKey, liveFinanceAdmin)
      ?.groups['1'].signaturePendingAt;
    throw Object.assign(new Error('User rejected the request'), { code: 4001 });
  });

  render(<DisclosureView />);
  fireEvent.click(await screen.findByRole('checkbox', { name: /CloudNode/i }));
  fireEvent.click(screen.getByRole('button', { name: /review selected scope/i }));
  fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/explicitly rejected/i);
  expect(observedPending).toBe(true);
  expect(loadAdminDisclosureCheckpoint(walletRunKey, liveFinanceAdmin)?.groups['1'].signaturePendingAt).toBeUndefined();
});

test('an approved unknown wallet prompt is recovered from its exact packet event without re-signing', async () => {
  const hash = `0x${'8'.repeat(64)}` as `0x${string}`;
  sessionState.current = null;
  appContext.current.demoRole = null;
  appContext.current.account = liveFinanceAdmin;
  appContext.current.requests = [request(0, 11n, 2)];
  seedAdminCheckpoint({
    runKey: walletRunKey,
    signaturePendingAt: Date.now(),
    signatureStartBlock: '99',
  });
  vi.mocked(publicClient.getLogs).mockResolvedValueOnce([{
    args: { packetId: 8n },
    transactionHash: hash,
  }] as any);
  vi.mocked(publicClient.getTransaction).mockResolvedValueOnce({ from: liveFinanceAdmin } as any);
  vi.mocked(publicClient.readContract)
    .mockResolvedValueOnce(packetRead(1n, [11n]) as any)
    .mockResolvedValueOnce(packetRead(1n, [11n]) as any);
  vi.mocked(publicClient.waitForTransactionReceipt)
    .mockResolvedValueOnce({ status: 'success', logs: [packetLog(8n, 1n)] } as any);

  render(<DisclosureView />);
  await screen.findByText(/wallet request.*unknown outcome/i);
  fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));

  await screen.findByText(/Review Bundle updated/i);
  expect(walletWrite).not.toHaveBeenCalled();
  expect(publicClient.getTransaction).toHaveBeenCalledWith({ hash });
  expect(loadAdminDisclosureCheckpoint(walletRunKey, liveFinanceAdmin)).toBeNull();
});

test('a locally complete Admin checkpoint stays in Review until its chain evidence is verified', async () => {
  const hash = `0x${'d'.repeat(64)}` as `0x${string}`;
  appContext.current.demoRole = null;
  appContext.current.account = liveFinanceAdmin;
  appContext.current.requests = [request(0, 11n, 2)];
  seedAdminCheckpoint({
    runKey: walletRunKey,
    transactionHash: hash,
    packetId: 8,
    manifestHash: handle,
  });
  vi.mocked(publicClient.getTransactionReceipt)
    .mockResolvedValueOnce({ status: 'success', logs: [packetLog(8n, 1n)] } as any);
  vi.mocked(publicClient.readContract).mockResolvedValueOnce(packetRead(1n, [11n]) as any);

  render(<DisclosureView />);
  expect(await screen.findByText(/local transaction pointers/i)).toBeInTheDocument();
  expect(screen.queryByText(/Review Bundle updated/i)).not.toBeInTheDocument();
  expect(completeMission).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));
  await screen.findByText(/Review Bundle updated/i);
  expect(walletWrite).not.toHaveBeenCalled();
  expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash });
  expect(publicClient.readContract).toHaveBeenCalledWith(expect.objectContaining({
    functionName: 'getAuditPacket',
    args: [8n],
  }));
  expect(completeMission).toHaveBeenCalledWith('audit', expect.objectContaining({
    packetIds: [8],
    includedRequestIds: ['11'],
  }));
});

test('tampered Admin checkpoint metadata cannot be rendered or complete the mission', async () => {
  const hash = `0x${'e'.repeat(64)}` as `0x${string}`;
  appContext.current.demoRole = null;
  appContext.current.account = liveFinanceAdmin;
  appContext.current.requests = [request(0, 11n, 2)];
  seedAdminCheckpoint({
    runKey: walletRunKey,
    transactionHash: hash,
    packetId: 999,
    manifestHash: handle,
  });
  vi.mocked(publicClient.getTransactionReceipt)
    .mockResolvedValueOnce({ status: 'success', logs: [packetLog(8n, 1n)] } as any);

  render(<DisclosureView />);
  await screen.findByText(/local transaction pointers/i);
  fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/recovery event does not match/i);
  expect(screen.queryByText(/Review Bundle updated/i)).not.toBeInTheDocument();
  expect(publicClient.readContract).not.toHaveBeenCalled();
  expect(walletWrite).not.toHaveBeenCalled();
  expect(completeMission).not.toHaveBeenCalled();
});

test('stale reverted Admin checkpoint cannot be reused as a successful packet', async () => {
  const hash = `0x${'f'.repeat(64)}` as `0x${string}`;
  appContext.current.demoRole = null;
  appContext.current.account = liveFinanceAdmin;
  appContext.current.requests = [request(0, 11n, 2)];
  seedAdminCheckpoint({
    runKey: walletRunKey,
    transactionHash: hash,
    packetId: 8,
    manifestHash: handle,
  });
  vi.mocked(publicClient.getTransactionReceipt)
    .mockResolvedValueOnce({ status: 'reverted', logs: [] } as any);

  render(<DisclosureView />);
  await screen.findByText(/local transaction pointers/i);
  fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/transaction reverted/i);
  expect(screen.queryByText(/Review Bundle updated/i)).not.toBeInTheDocument();
  expect(publicClient.readContract).not.toHaveBeenCalled();
  expect(walletWrite).not.toHaveBeenCalled();
  expect(completeMission).not.toHaveBeenCalled();

  const replacementHash = `0x${'9'.repeat(64)}` as `0x${string}`;
  vi.mocked(walletWrite).mockResolvedValueOnce(replacementHash);
  vi.mocked(publicClient.waitForTransactionReceipt)
    .mockResolvedValueOnce({ status: 'success', logs: [packetLog(10n, 1n)] } as any);
  vi.mocked(publicClient.readContract).mockResolvedValueOnce(packetRead(1n, [11n]) as any);
  fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));

  await screen.findByText(/Review Bundle updated/i);
  expect(walletWrite).toHaveBeenCalledTimes(1);
  expect(walletWrite).toHaveBeenCalledWith(expect.objectContaining({
    functionName: 'createAuditPacket',
    args: [ROLES.auditor, 1n, [11n]],
  }));
});

test('broadcast Admin pointers cannot be discarded or replaced by another scope', async () => {
  const hash = `0x${'7'.repeat(64)}` as `0x${string}`;
  sessionState.current = null;
  appContext.current.demoRole = null;
  appContext.current.account = liveFinanceAdmin;
  appContext.current.requests = [request(2, 13n, 4)];
  seedAdminCheckpoint({
    runKey: walletRunKey,
    transactionHash: hash,
  });

  render(<DisclosureView />);
  fireEvent.click(await screen.findByRole('checkbox', { name: /Atlas Contractor/i }));
  fireEvent.click(screen.getByRole('button', { name: /review selected scope/i }));
  fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/previous Audit Packet operation has 1 locked wallet or transaction pointer/i);
  expect(walletWrite).not.toHaveBeenCalled();
  expect(loadAdminDisclosureCheckpoint(walletRunKey, liveFinanceAdmin)?.groups['1']?.transactionHash).toBe(hash);
});

test('restored broadcast pointers lock auditor, scope and discard controls until verification', async () => {
  const hash = `0x${'6'.repeat(64)}` as `0x${string}`;
  appContext.current.demoRole = null;
  appContext.current.account = liveFinanceAdmin;
  appContext.current.requests = [request(0, 11n, 2)];
  seedAdminCheckpoint({ runKey: walletRunKey, transactionHash: hash });

  render(<DisclosureView />);
  await screen.findByText(/local transaction pointers/i);
  expect(screen.getByRole('button', { name: /recovery pointers locked/i })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /back to selection/i }));
  expect(screen.getByRole('textbox', { name: /auditor address/i })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /CloudNode/i })).toBeDisabled();
});
