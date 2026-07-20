import { describe, expect, test, vi } from 'vitest';
import { requestFinalize } from '../src/finalize-courier';

describe('proof courier recovery boundary', () => {
  test.each(['TimeoutError', 'AbortError', 'TypeError'])('%s keeps the exact request in recovery', async (name) => {
    const error = new Error('response unavailable');
    error.name = name;
    const fetchImpl = vi.fn().mockRejectedValue(error);

    await expect(requestFinalize(46n, fetchImpl)).resolves.toBe('response-delayed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('/api/finalize', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ requestId: 46 }),
    }));
  });

  test('an explicit server rejection remains an actionable failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'proof rejected' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(requestFinalize(46n, fetchImpl)).rejects.toThrow('proof rejected');
  });

  test('202 means the background keeper owns the request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ processing: true }), { status: 202 }));
    await expect(requestFinalize(46n, fetchImpl)).resolves.toBe('accepted');
  });
});
