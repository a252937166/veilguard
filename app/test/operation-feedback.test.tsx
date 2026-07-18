// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { PaymentProgress } from '../src/components/PaymentProgress';
import { acquireOperationLock, releaseOperationLock } from '../src/operation-lock';

describe('long-action feedback', () => {
  test('closes the same-frame multi-click gap synchronously', () => {
    const lock = { current: false };
    expect(acquireOperationLock(lock)).toBe(true);
    expect(acquireOperationLock(lock)).toBe(false);
    releaseOperationLock(lock);
    expect(acquireOperationLock(lock)).toBe(true);
  });

  test('reports a truthful staged payment state without a fabricated percentage', () => {
    render(<PaymentProgress
      isDemo
      flow={{ phase: 'evaluating', label: 'Nox is evaluating three private rules…', startedAt: Date.now() - 2_000, expect: 30 }}
    />);

    const progress = screen.getByRole('progressbar', { name: /confidential payment processing stages/i });
    expect(progress).toHaveAttribute('aria-valuenow', '4');
    expect(progress).toHaveAttribute('aria-valuetext', expect.stringContaining('TEE'));
    expect(screen.getByText(/Nox is evaluating/i)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  test('makes receipt recovery explicit and warns against duplicate submission', () => {
    render(<PaymentProgress
      isDemo
      flow={{
        phase: 'recovering',
        label: 'Receipt is delayed — recovering the request from chain state…',
        startedAt: Date.now() - 65_000,
        tx: `0x${'1'.repeat(64)}`,
      }}
    />);

    expect(screen.getByText(/do not submit it again/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view tx/i })).toHaveAttribute('href', expect.stringContaining('sepolia.etherscan.io/tx/'));
  });
});
