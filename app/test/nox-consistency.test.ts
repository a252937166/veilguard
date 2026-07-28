import { describe, expect, test, vi } from 'vitest';
import {
  NoxConsistencyError,
  retryNoxRead,
  waitForHandlesResolved,
  waitUntilSimulatable,
} from '../../scripts/lib/nox-consistency';

function fakeClock() {
  let at = 0;
  return {
    now: () => at,
    sleep: vi.fn(async (ms: number) => { at += ms; }),
  };
}

describe('Nox eventual-consistency barriers', () => {
  test('repeats the exact read-only simulation and returns its first usable result', async () => {
    const clock = fakeClock();
    const simulate = vi.fn()
      .mockRejectedValueOnce(new Error('handle not propagated'))
      .mockRejectedValueOnce(new Error('execution reverted'))
      .mockResolvedValueOnce({ request: 'ready' });
    const onRetry = vi.fn();
    const onUsable = vi.fn();

    await expect(waitUntilSimulatable('requestSpend input propagation', simulate, {
      timeoutMs: 10_000,
      intervalMs: 2_000,
      now: clock.now,
      sleep: clock.sleep,
      onRetry,
      resolvedAt: 1_000,
      onUsable,
    })).resolves.toEqual({ request: 'ready' });

    expect(simulate).toHaveBeenCalledTimes(3);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      elapsedMs: 0,
      remainingMs: 10_000,
    });
    expect(onUsable).toHaveBeenCalledWith({
      attempts: 3,
      startedAt: 0,
      usableAt: 4_000,
      elapsedMs: 4_000,
      resolvedAt: 1_000,
      resolvedToUsableMs: 3_000,
    });
  });

  test('retries a resolved handle read without exposing intermediate SDK errors', async () => {
    const clock = fakeClock();
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('gateway replica lagging'))
      .mockResolvedValueOnce({ value: 1n });

    await expect(retryNoxRead('decision public decrypt', read, {
      timeoutMs: 5_000,
      intervalMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    })).resolves.toEqual({ value: 1n });
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('timeout errors redact labels and discard handle, address and RPC details', async () => {
    const clock = fakeClock();
    const address = `0x${'1'.repeat(40)}`;
    const handle = `0x${'2'.repeat(64)}`;
    const operation = vi.fn(async () => {
      throw new Error(`execution reverted for ${handle} actor ${address} at https://rpc.invalid/private`);
    });

    const failure = retryNoxRead(`snapshot ${handle}`, operation, {
      timeoutMs: 2_000,
      intervalMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((error) => error);

    const error = await failure;
    expect(error).toBeInstanceOf(NoxConsistencyError);
    expect(error).toMatchObject({
      code: 'NOX_PROPAGATION_TIMEOUT',
      phase: 'read',
      attempts: 3,
      timeoutMs: 2_000,
    });
    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain(address);
    expect(error.message).not.toContain(handle);
    expect(error.message).not.toContain('rpc.invalid');
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  test('a known terminal failure stops after one attempt with a sanitized error', async () => {
    const operation = vi.fn(async () => {
      throw new Error(`user rejected decrypt for 0x${'3'.repeat(40)}`);
    });

    await expect(retryNoxRead('wallet decrypt', operation, {
      shouldRetry: () => false,
    })).rejects.toMatchObject({
      code: 'NOX_OPERATION_NOT_RETRYABLE',
      attempts: 1,
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('status polling returns timing without returning or logging the handles', async () => {
    const clock = fakeClock();
    const handle = `0x${'4'.repeat(64)}`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payload: { statuses: [{ handle, resolved: false }] },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payload: { statuses: [{ handle, resolved: true }] },
      })));

    await expect(waitForHandlesResolved('https://gateway.invalid/v0/public/handles/status', [handle], {
      fetchImpl,
      timeoutMs: 10_000,
      intervalMs: 1_500,
      now: clock.now,
      sleep: clock.sleep,
    })).resolves.toEqual({
      attempts: 2,
      startedAt: 0,
      resolvedAt: 1_500,
      elapsedMs: 1_500,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
