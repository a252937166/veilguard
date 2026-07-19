// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  pollDemoSafeDecision,
  SafeDecisionDock,
  SafeDecisionProgress,
  type SafeDecisionFlow,
} from '../src/components/SafeDecisionProgress';

const flow = (overrides: Partial<SafeDecisionFlow> = {}): SafeDecisionFlow => ({
  requestId: '33',
  action: 'approve',
  phase: 'validating',
  startedAt: Date.now(),
  ...overrides,
});

describe('Safe decision feedback', () => {
  test('announces the real stage and exposes the broadcast hash before settlement', () => {
    render(<SafeDecisionProgress flow={flow({
      phase: 'confirming',
      hash: `0x${'1'.repeat(64)}`,
    })} />);

    const progress = screen.getByRole('progressbar', { name: /safe decision processing stages/i });
    expect(progress).toHaveAttribute('aria-valuenow', '3');
    expect(progress).toHaveAttribute('aria-valuetext', expect.stringContaining('Safe transaction'));
    expect(screen.getByRole('link', { name: /view tx/i })).toHaveAttribute('href', expect.stringContaining('sepolia.etherscan.io/tx/'));
  });

  test('keeps both bounded actions inside the shared dock', () => {
    render(
      <SafeDecisionDock flow={flow({ phase: 'signing', action: 'reject' })}>
        <button type="button">Reject &amp; return funds</button>
        <button type="button">Approve payment</button>
      </SafeDecisionDock>,
    );
    expect(screen.getByRole('region', { name: /safe decision actions/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  test('polls deterministic phase snapshots and settles only after a confirmed receipt', async () => {
    const hash = `0x${'2'.repeat(64)}` as const;
    const replies = [
      new Response(JSON.stringify({ ok: true, processing: true, phase: 'validating', action: 'approve', requestId: 33 }), { status: 202 }),
      new Response(JSON.stringify({ ok: true, processing: true, phase: 'confirming', action: 'approve', requestId: 33, hash }), { status: 202 }),
      new Response(JSON.stringify({ ok: true, phase: 'settled', action: 'approve', requestId: 33, hash, state: 'safe-approved' }), { status: 200 }),
    ];
    const fetchImpl = vi.fn(async () => replies.shift()!);
    const snapshots: SafeDecisionFlow[] = [];

    const result = await pollDemoSafeDecision({
      runId: 'run_12345678',
      requestId: '33',
      action: 'approve',
      onProgress: (snapshot) => snapshots.push(snapshot),
      fetchImpl: fetchImpl as typeof fetch,
      pollDelayMs: 0,
      maxPolls: 4,
    });

    expect(result.state).toBe('safe-approved');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(snapshots.some((snapshot) => snapshot.phase === 'confirming' && snapshot.hash === hash)).toBe(true);
    expect(snapshots.at(-1)).toMatchObject({ phase: 'settled', hash });
  });

  test.each([409, 410, 503])('preserves a recoverable broadcast instead of painting HTTP %s as settled', async (status) => {
    const hash = `0x${'3'.repeat(64)}` as const;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: 'decision is not settled yet',
      details: { phase: 'recovering', hash },
    }), { status }));
    const snapshots: SafeDecisionFlow[] = [];

    await expect(pollDemoSafeDecision({
      runId: 'run_12345678',
      requestId: '33',
      action: 'approve',
      onProgress: (snapshot) => snapshots.push(snapshot),
      fetchImpl: fetchImpl as typeof fetch,
      pollDelayMs: 0,
      maxPolls: 1,
    })).rejects.toThrow('decision is not settled yet');

    expect(snapshots.at(-1)).toMatchObject({
      phase: 'recovering',
      status: 'recoverable-error',
      hash,
    });
    expect(snapshots.at(-1)?.phase).not.toBe('settled');
  });
});
