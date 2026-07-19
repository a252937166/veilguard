// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { encodeAbiParameters, keccak256 } from 'viem';

const appContext = vi.hoisted(() => ({ current: {} as any }));
const sessionState = vi.hoisted(() => ({ current: null as any }));
const readContract = vi.hoisted(() => vi.fn());
const decrypt = vi.hoisted(() => vi.fn(async () => ({ value: 1_000_000n })));
const completeMission = vi.hoisted(() => vi.fn());

vi.mock('../src/App', () => ({ useApp: () => appContext.current }));
vi.mock('../src/demo-session', async () => {
  const actual = await vi.importActual<typeof import('../src/demo-session')>('../src/demo-session');
  return { ...actual, loadDemoSession: () => sessionState.current };
});
vi.mock('../src/missions', () => ({ completeMission }));
vi.mock('../src/txlog', () => ({ fetchRequestTxs: () => Promise.resolve(new Map()) }));
vi.mock('../src/nox', () => ({
  publicClient: { readContract },
  handleClientFor: async () => ({ decrypt }),
  waitResolved: vi.fn(async () => undefined),
}));

import { createDemoSession } from '../src/demo-session';
import { AuditorView } from '../src/views/AuditorView';

const auditor = '0x1111111111111111111111111111111111111111' as const;
const delegate = '0x2222222222222222222222222222222222222222' as const;
const recipient = '0x3333333333333333333333333333333333333333' as const;

function handle(seed: number): `0x${string}` {
  return `0x${seed.toString(16).padStart(64, '0')}`;
}

function packet(
  id: bigint,
  mandateId: bigint,
  requestIds: bigint[],
  handleSeed: number,
) {
  const snapshotHandles = Array.from(
    { length: 3 + requestIds.length * 2 },
    (_, index) => handle(handleSeed + index),
  );
  const manifestHash = keccak256(encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'uint32' },
      { type: 'uint256[]' },
      { type: 'bytes32[]' },
    ],
    [auditor, mandateId, 1, requestIds, snapshotHandles],
  ));
  return [auditor, mandateId, 1, manifestHash, 1_700_000_000n + id, requestIds, snapshotHandles];
}

const packetOne = packet(1n, 17n, [11n], 100);
const packetTwo = packet(2n, 18n, [12n, 13n], 200);

function request(id: bigint, mandateId: bigint, state: number) {
  return {
    id,
    mandateId,
    delegate,
    recipient,
    memoHash: handle(Number(id) + 300),
    createdAt: 1_700_000_000n,
    state,
    amount: handle(Number(id) + 400),
    decision: handle(Number(id) + 500),
    blockedReason: handle(Number(id) + 600),
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = '#/audit/1';

  const session = createDemoSession({ runId: 'launch-audit-handoff', now: 1 });
  session.missions.routine.requestId = '11';
  session.missions.approval.requestId = '12';
  session.missions.violation.requestId = '13';
  session.missions.audit.packetIds = ['1', '2'];
  session.missions.audit.includedRequestIds = ['11', '12', '13'];
  sessionState.current = session;

  appContext.current = {
    account: auditor,
    requests: [request(11n, 17n, 2), request(12n, 18n, 5), request(13n, 18n, 4)],
    toast: vi.fn(),
  };

  readContract.mockReset();
  readContract.mockImplementation(async ({ functionName, args }: any) => {
    if (functionName === 'nextPacketId') return 3n;
    if (functionName === 'getAuditPacket') return args[0] === 1n ? packetOne : packetTwo;
    throw new Error(`Unexpected contract read: ${String(functionName)}`);
  });
  decrypt.mockClear();
  completeMission.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = '';
});

test('guided audit hands off from unlock through every request and the remaining packet', async () => {
  render(<AuditorView />);

  expect(await screen.findByRole('heading', { name: 'Packet #1' })).toBeInTheDocument();
  const unlockOne = screen.getByRole('button', { name: 'Unlock disclosed values' });
  expect(unlockOne).toHaveAttribute('data-guided-action', 'mission-audit');
  expect(unlockOne).toHaveAttribute('data-guided-follow', 'true');

  fireEvent.click(unlockOne);
  const reviewOne = await screen.findByRole('button', { name: 'Review included requests' });
  await waitFor(() => expect(reviewOne).toHaveAttribute('data-guided-action', 'mission-audit'));
  expect(reviewOne).toHaveAttribute('data-guided-follow', 'true');
  expect(completeMission).not.toHaveBeenCalled();

  fireEvent.click(reviewOne);
  const firstDisposition = await screen.findByRole('group', { name: 'Review request 11' });
  expect(firstDisposition).toHaveAttribute('data-guided-action', 'mission-audit');
  expect(firstDisposition).toHaveAttribute('data-guided-follow', 'true');
  fireEvent.click(within(firstDisposition).getByRole('button', { name: 'Reviewed' }));

  const continueButton = await screen.findByRole('button', { name: 'Continue to Packet #2' });
  expect(continueButton).toHaveAttribute('data-guided-action', 'mission-audit');
  expect(continueButton).toHaveAttribute('data-guided-follow', 'true');
  expect(completeMission).not.toHaveBeenCalled();

  fireEvent.click(continueButton);
  expect(await screen.findByRole('heading', { name: 'Packet #2' })).toBeInTheDocument();
  const unlockTwo = screen.getByRole('button', { name: 'Unlock disclosed values' });
  expect(unlockTwo).toHaveAttribute('data-guided-action', 'mission-audit');
  expect(unlockTwo).toHaveAttribute('data-guided-follow', 'true');

  fireEvent.click(unlockTwo);
  const reviewTwo = await screen.findByRole('button', { name: 'Review included requests' });
  await waitFor(() => expect(reviewTwo).toHaveAttribute('data-guided-action', 'mission-audit'));
  fireEvent.click(reviewTwo);

  const secondDisposition = await screen.findByRole('group', { name: 'Review request 12' });
  fireEvent.click(within(secondDisposition).getByRole('button', { name: 'Reviewed' }));
  const thirdDisposition = await screen.findByRole('group', { name: 'Review request 13' });
  expect(thirdDisposition).toHaveAttribute('data-guided-action', 'mission-audit');
  expect(thirdDisposition).toHaveAttribute('data-guided-follow', 'true');
  fireEvent.click(within(thirdDisposition).getByRole('button', { name: 'Flag follow-up' }));

  await waitFor(() => expect(completeMission).toHaveBeenCalledWith('audit', expect.objectContaining({
    packetIds: [1n, 2n],
    includedRequestIds: ['11', '12', '13'],
    reviewedRequestIds: ['11', '12'],
    flaggedRequestIds: ['13'],
    packetUnlocked: true,
    integrityVerified: true,
    runId: 'launch-audit-handoff',
  })));
  expect(screen.queryByRole('button', { name: /Continue to Packet/i })).not.toBeInTheDocument();
});

test('an explicit unavailable packet route never falls back to a different granted packet', async () => {
  window.location.hash = '#/audit/99';
  render(<AuditorView />);

  expect(await screen.findByRole('heading', { name: 'Packet #99 is unavailable to this auditor' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Packet #1' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Packet #2' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Unlock disclosed values' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Continue to Packet/i })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Open granted packet list' }));
  expect(await screen.findByRole('heading', { name: 'Packet #2' })).toBeInTheDocument();
});
