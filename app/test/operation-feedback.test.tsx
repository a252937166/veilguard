// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { PaymentProgress } from '../src/components/PaymentProgress';
import { OperationCoordinator } from '../src/operation-lock';

afterEach(cleanup);

describe('long-action feedback', () => {
  test('closes the same-frame multi-click gap synchronously', () => {
    const coordinator = new OperationCoordinator();
    const first = coordinator.acquire({ key: 'cloudnode', label: 'CloudNode payment', resources: ['wallet:delegate', 'mandate:9'] });
    expect(first.acquired).toBe(true);
    const duplicate = coordinator.acquire({ key: 'cloudnode-again', label: 'CloudNode retry', resources: ['mandate:9'] });
    expect(duplicate.acquired).toBe(false);
    if (!first.acquired) throw new Error('expected operation lock');
    coordinator.release(first.operation);
    expect(coordinator.acquire({ key: 'cloudnode-retry', label: 'CloudNode retry', resources: ['mandate:9'] }).acquired).toBe(true);
  });

  test('allows unrelated resources and never lets an old token release a newer owner', () => {
    const coordinator = new OperationCoordinator();
    const payment = coordinator.acquire({ key: 'payment', label: 'Payment', resources: ['wallet:delegate'] });
    const read = coordinator.acquire({ key: 'decrypt', label: 'Decrypt', resources: [] });
    const funds = coordinator.acquire({ key: 'funds', label: 'Funds', resources: ['wallet:visitor'] });
    expect(payment.acquired).toBe(true);
    expect(read.acquired).toBe(true);
    expect(funds.acquired).toBe(true);
    if (!payment.acquired) throw new Error('expected payment lock');
    coordinator.release(payment.operation);
    const replacement = coordinator.acquire({ key: 'replacement', label: 'Replacement', resources: ['wallet:delegate'] });
    expect(replacement.acquired).toBe(true);
    coordinator.release(payment.operation);
    expect(coordinator.blockerFor(['wallet:delegate'])?.key).toBe('replacement');
  });

  test('reports a truthful staged payment state without a fabricated percentage', () => {
    render(<PaymentProgress
      isDemo
      flow={{ phase: 'evaluating', label: 'Nox is evaluating three private rules…', startedAt: Date.now() - 2_000, expect: 30 }}
    />);

    const progress = screen.getByRole('progressbar', { name: /confidential payment processing stages/i });
    expect(progress).toHaveAttribute('aria-valuenow', '4');
    expect(progress).toHaveAttribute('aria-valuetext', expect.stringContaining('Private check'));
    expect(screen.getByText(/Nox is evaluating/i)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  test('makes receipt recovery explicit and warns against duplicate submission', () => {
    const { container } = render(<PaymentProgress
      isDemo
      flow={{
        phase: 'recovering',
        label: 'Receipt is delayed — recovering the request from chain state…',
        startedAt: Date.now() - 65_000,
        tx: `0x${'1'.repeat(64)}`,
      }}
    />);

    const progress = within(container).getByRole('progressbar');
    expect(within(container).getByText(/do not submit it again/i)).toBeInTheDocument();
    expect(progress).toHaveAttribute('aria-valuenow', '3');
    expect(progress).toHaveAttribute('aria-valuetext', expect.stringContaining('Submit'));
    expect(within(container).getByRole('link', { name: /view tx/i })).toHaveAttribute('href', expect.stringContaining('sepolia.etherscan.io/tx/'));
  });
});
