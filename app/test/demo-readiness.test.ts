import { expect, test, vi } from 'vitest';
import { fetchDemoReadiness } from '../src/demo-readiness';

test('read-only readiness retries one delayed response and then succeeds', async () => {
  const retry = vi.fn();
  const sleep = vi.fn(async () => {});
  const fetchImpl = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ready: true }), { status: 200 }));

  await expect(fetchDemoReadiness({
    delegate: '0xdelegate', fetchImpl, sleep, onRetry: retry,
  })).resolves.toEqual({ ready: true });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(retry).toHaveBeenCalledWith(2);
  expect(sleep).toHaveBeenCalledWith(750);
});

test('a real not-ready response is returned without a second request', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    ready: false,
    reason: 'a payment is already in flight',
  }), { status: 200 }));
  await expect(fetchDemoReadiness({ delegate: '0xdelegate', fetchImpl })).resolves.toEqual({
    ready: false,
    reason: 'a payment is already in flight',
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('two unavailable responses fail closed without a write', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new TypeError('network unavailable'));
  await expect(fetchDemoReadiness({
    delegate: '0xdelegate', fetchImpl, sleep: async () => {},
  })).rejects.toThrow('network unavailable');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
