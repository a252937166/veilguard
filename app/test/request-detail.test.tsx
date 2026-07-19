// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { deriveRequestDetailModel, type SpendRequestLike } from '../src/domain';
import { RequestDetailView } from '../src/views/RequestDetailView';

const request: SpendRequestLike = {
  id: 33n,
  mandateId: 9n,
  delegate: '0x1111111111111111111111111111111111111111',
  recipient: '0x2222222222222222222222222222222222222222',
  memoHash: `0x${'3'.repeat(64)}`,
  createdAt: 1_700_000_000n,
  state: 2,
  amount: `0x${'4'.repeat(64)}`,
  decision: `0x${'5'.repeat(64)}`,
  blockedReason: `0x${'6'.repeat(64)}`,
};

afterEach(cleanup);

test('request detail renders one real request object without an invoice draft', () => {
  const tx = `0x${'7'.repeat(64)}` as const;
  const model = deriveRequestDetailModel(request, {
    transactions: { request: tx, finalize: tx },
    events: { outcomePath: 'direct' },
  });
  render(
    <RequestDetailView
      request={request as any}
      model={model}
      transactions={{ request: tx, finalize: tx, outcomePath: 'direct' }}
      authorizedAmount={<span>25 cUSDC</span>}
      purpose="Infrastructure renewal"
      activeOperation={<section aria-label="Active payment operation">CloudNode payment is still evaluating</section>}
      onBack={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );

  expect(screen.getByRole('heading', { name: 'Request #33', level: 1 })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Request summary' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Request timeline' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Transactions' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Payment Inbox' })).not.toBeInTheDocument();
  expect(screen.queryByText('Draft')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Active payment operation' })).toHaveTextContent('still evaluating');
  expect(document.querySelector('.status-badge')).toHaveTextContent('Executed within mandate');
  expect(document.querySelector('.status-badge')).toHaveClass('ok');

  const publicSide = screen.getByRole('region', { name: 'What the public chain sees' });
  expect(within(publicSide).getByText('Encrypted handle')).toBeInTheDocument();
  expect(publicSide).not.toHaveTextContent('25 cUSDC');
  expect(publicSide).not.toHaveTextContent('Infrastructure renewal');
});

test('cancelled detail claims a user Reject only with authenticated origin', () => {
  const cancelled = { ...request, state: 5 };
  const props = {
    request: cancelled as any,
    transactions: { cancellation: `0x${'8'.repeat(64)}` as const, outcomePath: 'approval' as const },
    authorizedAmount: <span>60 cUSDC</span>,
    purpose: 'Emergency response',
    onBack: vi.fn(),
    onRefresh: vi.fn(),
  };
  const { rerender } = render(
    <RequestDetailView
      {...props}
      model={deriveRequestDetailModel(cancelled, {
        transactions: props.transactions,
        events: { outcomePath: 'approval', decisionOrigin: 'unknown' },
      })}
    />,
  );
  expect(document.querySelector('.status-badge')).toHaveTextContent('Cancelled and refunded');
  expect(screen.getByText(/no user Reject is claimed/i)).toBeInTheDocument();

  rerender(
    <RequestDetailView
      {...props}
      model={deriveRequestDetailModel(cancelled, {
        transactions: props.transactions,
        events: { outcomePath: 'approval', decisionOrigin: 'user', safeAction: 'reject' },
      })}
    />,
  );
  expect(document.querySelector('.status-badge')).toHaveTextContent('User rejected · refunded');
  expect(screen.getByText(/authenticated by the run-bound server receipt/i)).toBeInTheDocument();
});
