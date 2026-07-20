// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GuidedActionPointer } from '../src/components/GuidedActionPointer';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('coach points to and focuses the declared real action without activating it', async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  const status = vi.fn();
  const complete = vi.fn();
  const action = vi.fn();
  const { unmount } = render(
    <>
      <button
        type="button"
        data-guided-action="mission-violation"
        data-guided-instruction="Click “Submit confidential payment”"
        onClick={action}
        ref={(element) => {
          if (element) element.getBoundingClientRect = () => ({
            x: 120, y: 260, top: 260, right: 420, bottom: 304, left: 120,
            width: 300, height: 44, toJSON: () => ({}),
          });
        }}
      >Submit confidential payment</button>
      <GuidedActionPointer
        intent={{
          id: 7,
          step: 3,
          route: { page: 'payment-inbox' },
          role: 'delegate',
          selected: { scenarioKey: 'violation' },
          targetId: 'mission-violation',
          instruction: 'fallback',
        }}
        onStatusChange={status}
        onComplete={complete}
      />
    </>,
  );

  const button = screen.getByRole('button', { name: 'Submit confidential payment' });
  await waitFor(() => expect(button).toHaveClass('guided-action-target'));
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute('aria-describedby', 'guided-action-coach-7');
  expect(screen.getByRole('status')).toHaveTextContent('Click “Submit confidential payment”');
  expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto', block: 'center' }));
  expect(status).toHaveBeenCalledWith('found');
  expect(action).not.toHaveBeenCalled();

  fireEvent.click(button);
  expect(action).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(1);
  unmount();
  expect(button).not.toHaveClass('guided-action-target');
  expect(button).not.toHaveAttribute('aria-describedby');
});

test('focus follows the same logical action when the routed CTA element is replaced', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 120, y: 260, top: 260, right: 420, bottom: 304, left: 120,
      width: 300, height: 44, toJSON: () => ({}),
    }),
  });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  const intent = {
    id: 8,
    step: 3,
    route: { page: 'payment-detail' as const, requestId: '3' },
    role: 'delegate' as const,
    selected: { scenarioKey: 'violation' as const, requestId: '3' },
    targetId: 'mission-violation',
    instruction: 'Click “Decrypt the private reason”',
  };
  const status = vi.fn();
  const complete = vi.fn();
  const renderTree = (key: string) => (
    <>
      <button key={key} type="button" data-guided-action="mission-violation">
        Decrypt the private reason
      </button>
      <GuidedActionPointer intent={intent} onStatusChange={status} onComplete={complete} />
    </>
  );
  const { rerender } = render(renderTree('initial'));
  const initial = screen.getByRole('button', { name: 'Decrypt the private reason' });
  await waitFor(() => expect(initial).toHaveFocus());

  rerender(renderTree('replacement'));
  const replacement = screen.getByRole('button', { name: 'Decrypt the private reason' });
  expect(replacement).not.toBe(initial);
  await waitFor(() => expect(replacement).toHaveFocus());
  expect(replacement).toHaveClass('guided-action-target');
  expect(complete).not.toHaveBeenCalled();
});

test('missing target lookup stops after the bounded recovery window', () => {
  vi.useFakeTimers();
  const status = vi.fn();
  render(
    <GuidedActionPointer
      intent={{
        id: 9,
        step: 5,
        route: { page: 'audit-detail', packetId: '8' },
        role: 'auditor',
        selected: { packetId: '8' },
        targetId: 'mission-audit',
        instruction: 'Click “Unlock disclosed values”',
      }}
      onStatusChange={status}
      onComplete={vi.fn()}
    />,
  );

  expect(status).toHaveBeenCalledWith('locating');
  act(() => vi.advanceTimersByTime(2_499));
  expect(status).not.toHaveBeenCalledWith('missing');
  act(() => vi.advanceTimersByTime(1));
  expect(status).toHaveBeenLastCalledWith('missing');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('a late target cannot steal focus after the bounded lookup expires', async () => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 20, y: 120, top: 120, right: 220, bottom: 164, left: 20,
      width: 200, height: 44, toJSON: () => ({}),
    }),
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  const status = vi.fn();
  const intent = {
    id: 10,
    step: 5,
    route: { page: 'audit-detail' as const, packetId: '8' },
    role: 'auditor' as const,
    selected: { packetId: '8' },
    targetId: 'mission-audit',
    instruction: 'Unlock values',
  };
  const complete = vi.fn();
  function Harness({ show }: { show: boolean }) {
    return <>{show && <button type="button" data-guided-action="mission-audit">Late action</button>}<GuidedActionPointer intent={intent} onStatusChange={status} onComplete={complete} /></>;
  }
  const { rerender } = render(<Harness show={false} />);
  act(() => vi.advanceTimersByTime(2_500));
  expect(status).toHaveBeenLastCalledWith('missing');

  rerender(<Harness show />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('button', { name: 'Late action' })).not.toHaveFocus();
  expect(screen.getByRole('button', { name: 'Late action' })).not.toHaveClass('guided-action-target');
});

test('coach synchronizes instruction changes on the same action node', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 20, y: 120, top: 120, right: 220, bottom: 164, left: 20,
      width: 200, height: 44, toJSON: () => ({}),
    }),
  });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  const intent = {
    id: 11,
    step: 2,
    route: { page: 'payment-inbox' as const },
    role: 'delegate' as const,
    selected: { scenarioKey: 'approval' as const },
    targetId: 'mission-approval',
    instruction: 'Verify the receipt',
  };
  const pointer = <GuidedActionPointer intent={intent} onStatusChange={vi.fn()} onComplete={vi.fn()} />;
  const { rerender } = render(<><button type="button" data-guided-action="mission-approval" data-guided-instruction="Open current request">Current</button>{pointer}</>);
  expect(await screen.findByText('Open current request')).toBeInTheDocument();

  rerender(<><button type="button" data-guided-action="mission-approval" data-guided-instruction="Retry invoice">Current</button>{pointer}</>);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Retry invoice'));
});

test('follow targets hand the coach to the next real control before completing', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 20, y: 120, top: 120, right: 260, bottom: 164, left: 20,
      width: 240, height: 44, toJSON: () => ({}),
    }),
  });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  const complete = vi.fn();
  function Sequence() {
    const [reviewed, setReviewed] = useState(false);
    return (
      <>
        {reviewed
          ? <button type="button" data-guided-action="mission-disclosure" data-guided-instruction="Create packet">Create packet</button>
          : <button type="button" data-guided-action="mission-disclosure" data-guided-follow="true" data-guided-instruction="Review scope" onClick={() => setReviewed(true)}>Review scope</button>}
        <GuidedActionPointer
          intent={{
            id: 12,
            step: 4,
            route: { page: 'disclosure-builder' },
            role: 'delegate',
            selected: {},
            targetId: 'mission-disclosure',
            instruction: 'Review scope',
          }}
          onStatusChange={vi.fn()}
          onComplete={complete}
        />
      </>
    );
  }
  render(<Sequence />);
  const review = screen.getByRole('button', { name: 'Review scope' });
  await waitFor(() => expect(review).toHaveFocus());
  fireEvent.click(review);

  const create = await screen.findByRole('button', { name: 'Create packet' });
  await waitFor(() => expect(create).toHaveFocus());
  expect(complete).not.toHaveBeenCalled();
  fireEvent.click(create);
  expect(complete).toHaveBeenCalledTimes(1);
});

test('a slow follow action keeps its coach and hands off after a five second gateway delay', async () => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 20, y: 120, top: 120, right: 300, bottom: 164, left: 20,
      width: 280, height: 44, toJSON: () => ({}),
    }),
  });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  const status = vi.fn();
  const intent = {
    id: 14,
    step: 5,
    route: { page: 'audit-detail' as const, packetId: '1' },
    role: 'auditor' as const,
    selected: { packetId: '1' },
    targetId: 'mission-audit',
    instruction: 'Unlock disclosed values',
  };

  function SlowUnlock() {
    const [phase, setPhase] = useState<'locked' | 'unlocking' | 'review'>('locked');
    const unlock = () => {
      setPhase('unlocking');
      window.setTimeout(() => setPhase('review'), 5_000);
    };
    return (
      <>
        {phase === 'review' ? (
          <button type="button" data-guided-action="mission-audit" data-guided-instruction="Review included requests">
            Review included requests
          </button>
        ) : (
          <button
            type="button"
            data-guided-action="mission-audit"
            data-guided-follow="true"
            data-guided-instruction="Unlock disclosed values"
            disabled={phase === 'unlocking'}
            onClick={unlock}
          >
            {phase === 'unlocking' ? 'Unlocking values' : 'Unlock disclosed values'}
          </button>
        )}
        <GuidedActionPointer
          intent={intent}
          onStatusChange={status}
          onComplete={vi.fn()}
        />
      </>
    );
  }

  render(<SlowUnlock />);
  const unlock = screen.getByRole('button', { name: 'Unlock disclosed values' });
  expect(unlock).toHaveClass('guided-action-target');
  fireEvent.click(unlock);

  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('button', { name: 'Unlocking values' })).toBe(unlock);
  act(() => vi.advanceTimersByTime(16));
  expect(screen.getByRole('button', { name: 'Unlocking values' })).toHaveClass('guided-action-target');
  act(() => vi.advanceTimersByTime(2_500));
  expect(status).not.toHaveBeenCalledWith('missing');

  act(() => vi.advanceTimersByTime(2_500));
  await act(async () => { await Promise.resolve(); });
  const review = screen.getByRole('button', { name: 'Review included requests' });
  expect(review).toHaveClass('guided-action-target');
  expect(review).toHaveFocus();
  expect(screen.getByRole('status')).toHaveTextContent('Review included requests');
  expect(status).not.toHaveBeenCalledWith('missing');
});

test('choice-group padding does not dismiss the coach without a real control activation', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 20, y: 120, top: 120, right: 320, bottom: 180, left: 20,
      width: 300, height: 60, toJSON: () => ({}),
    }),
  });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  const complete = vi.fn();
  render(
    <>
      <div role="group" aria-label="Committee decision" data-guided-action="mission-approval">
        <button type="button">Reject</button>
        <button type="button">Approve</button>
      </div>
      <GuidedActionPointer
        intent={{
          id: 13,
          step: 2,
          route: { page: 'payment-detail', requestId: '60' },
          role: 'delegate',
          selected: { scenarioKey: 'approval', requestId: '60' },
          targetId: 'mission-approval',
          instruction: 'Choose Approve or Reject',
        }}
        onStatusChange={vi.fn()}
        onComplete={complete}
      />
    </>,
  );

  const group = screen.getByRole('group', { name: 'Committee decision' });
  await waitFor(() => expect(group).toHaveClass('guided-action-target'));
  fireEvent.click(group);
  expect(complete).not.toHaveBeenCalled();
  expect(group).toHaveClass('guided-action-target');

  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  expect(complete).toHaveBeenCalledTimes(1);
});
