// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  saveAdminDisclosureCheckpoint,
  updateAdminDisclosureGroup,
} from '../src/disclosure-checkpoint';
import { encodeAbiParameters, encodeEventTopics } from 'viem';

const handle = `0x${'1'.repeat(64)}` as `0x${string}`;
const liveFinanceAdmin = '0x4444444444444444444444444444444444444444' as const;

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
  window.location.hash = '';
  sessionState.current = guidedSession();
  appContext.current = {
    account: '0x1111111111111111111111111111111111111111',
    financeAdmin: liveFinanceAdmin,
    demoRole: 'delegate',
    requests: [request(0, 11n, 2), request(1, 12n, 5), request(2, 13n, 4)],
    startDemo: vi.fn(),
    toast: vi.fn(),
  };
  completeMission.mockReset();
  advanceGuidedMission.mockReset();
  vi.mocked(walletWrite).mockReset();
  vi.mocked(publicClient.waitForTransactionReceipt).mockReset();
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
    route: { page: 'audit-packets' },
    role: 'auditor',
    selected: { packetId: '8' },
  });
  expect(appContext.current.startDemo).toHaveBeenCalledWith('auditor');
  expect(window.location.hash).toBe('#/audit');
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
  transactionHash: `0x${string}`;
}) {
  let checkpoint = createAdminDisclosureCheckpoint({
    runKey: options.runKey,
    account: liveFinanceAdmin,
    auditor: ROLES.auditor,
    groups: { 1: ['11'] },
  });
  checkpoint = updateAdminDisclosureGroup(checkpoint, '1', {
    transactionHash: options.transactionHash,
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

  fireEvent.click(screen.getByRole('button', { name: /create packets with admin wallet/i }));
  await screen.findByText(/Review Bundle updated/i);
  expect(walletWrite).toHaveBeenCalledTimes(2);
  expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(3);
  expect(publicClient.waitForTransactionReceipt).toHaveBeenNthCalledWith(3, expect.objectContaining({ hash: secondHash }));
  expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: firstHash });
  expect(publicClient.readContract).toHaveBeenCalledTimes(3);
  expect(screen.getByText(/2 packets/i)).toBeInTheDocument();
});

test('a locally complete Admin checkpoint stays in Review until its chain evidence is verified', async () => {
  const hash = `0x${'d'.repeat(64)}` as `0x${string}`;
  appContext.current.demoRole = null;
  appContext.current.account = liveFinanceAdmin;
  appContext.current.requests = [request(0, 11n, 2)];
  seedAdminCheckpoint({
    runKey: 'launch-selection-test',
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
    runKey: 'launch-selection-test',
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
    runKey: 'launch-selection-test',
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
});
