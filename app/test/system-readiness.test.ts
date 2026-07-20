import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBlockNumber: vi.fn(),
  readContract: vi.fn(),
  handlesResolved: vi.fn(),
}));

vi.mock('../src/nox', () => ({
  publicClient: {
    getBlockNumber: mocks.getBlockNumber,
    readContract: mocks.readContract,
  },
  handlesResolved: mocks.handlesResolved,
}));

import { probeSystemReadiness } from '../src/system-readiness';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBlockNumber.mockResolvedValue(7_654_321n);
  mocks.handlesResolved.mockResolvedValue(true);
  mocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getThreshold') return 2n;
    if (functionName === 'isModuleEnabled') return true;
    throw new Error(`Unexpected function ${functionName}`);
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, sweep: true }),
  })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('readiness is green only when live RPC, gateway, Safe threshold and module checks pass', async () => {
  const result = await probeSystemReadiness(`0x${'1'.repeat(64)}`);

  expect(result.rpc.ok).toBe(true);
  expect(result.keeper.ok).toBe(true);
  expect(result.gateway.ok).toBe(true);
  expect(result.safeThreshold).toMatchObject({ ok: true, detail: '2-of-2 signatures required' });
  expect(result.module.ok).toBe(true);
});

test('an unresolved handle and incorrect Safe configuration can never render as ready', async () => {
  mocks.handlesResolved.mockResolvedValue(false);
  mocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => (
    functionName === 'getThreshold' ? 1n : false
  ));

  const result = await probeSystemReadiness(`0x${'2'.repeat(64)}`);

  expect(result.gateway).toMatchObject({ ok: false, detail: 'Latest decision handle unresolved' });
  expect(result.safeThreshold).toMatchObject({ ok: false, detail: 'Unexpected threshold: 1' });
  expect(result.module).toMatchObject({ ok: false, detail: 'VeilGuard Module is not enabled' });
});

test('gateway remains explicitly pending before any decision handle exists', async () => {
  const result = await probeSystemReadiness();

  expect(mocks.handlesResolved).not.toHaveBeenCalled();
  expect(result.gateway).toEqual({ ok: null, detail: 'No decision handle yet' });
});
