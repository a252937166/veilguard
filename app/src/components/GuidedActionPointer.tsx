import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ActiveGuidedFocusIntent } from '../GuidedTour';

type GuidedPointerStatus = 'locating' | 'found' | 'missing';
type GuidedPointerPosition = CSSProperties & { '--guided-arrow-x'?: string };

export function GuidedActionPointer({
  intent,
  onStatusChange,
  onComplete,
}: {
  intent: ActiveGuidedFocusIntent;
  onStatusChange: (status: GuidedPointerStatus) => void;
  onComplete: () => void;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [instruction, setInstruction] = useState(intent.instruction);
  const [placement, setPlacement] = useState<'above' | 'below'>('above');
  const [position, setPosition] = useState<GuidedPointerPosition>({ top: 12, left: 12 });
  const targetRef = useRef<HTMLElement | null>(null);
  const statusChangeRef = useRef(onStatusChange);
  const completeRef = useRef(onComplete);
  statusChangeRef.current = onStatusChange;
  completeRef.current = onComplete;

  // Focus only after the coach has committed, so aria-describedby always
  // references a real node when keyboard and screen-reader users arrive.
  useLayoutEffect(() => {
    if (!target) return;
    try { target.focus({ preventScroll: true }); } catch { target.focus(); }
  }, [target]);

  useEffect(() => {
    let missingTimer = 0;
    let frame = 0;
    let expired = false;
    let observer: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let originalDescription: string | null = null;
    let originalTabIndex: string | null = null;
    let insertedTabIndex = false;
    let targetClickHandler: ((event: MouseEvent) => void) | null = null;
    let following = false;
    const coachId = `guided-action-coach-${intent.id}`;

    const updatePosition = () => {
      const element = targetRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const width = Math.min(286, window.innerWidth - 24);
      const nextPlacement = rect.top >= 116 ? 'above' : 'below';
      const left = Math.max(12, Math.min(
        rect.left + rect.width / 2 - width / 2,
        window.innerWidth - width - 12,
      ));
      const arrowX = Math.max(18, Math.min(rect.left + rect.width / 2 - left, width - 18));
      setPlacement(nextPlacement);
      setPosition({
        width,
        left,
        top: nextPlacement === 'above'
          ? Math.max(12, rect.top - 12)
          : Math.min(window.innerHeight - 12, rect.bottom + 12),
        '--guided-arrow-x': `${arrowX}px`,
      });
    };

    const detach = (updateReactState = true) => {
      const element = targetRef.current;
      if (!element) return;
      element.classList.remove('guided-action-target');
      if (originalDescription === null) element.removeAttribute('aria-describedby');
      else element.setAttribute('aria-describedby', originalDescription);
      if (insertedTabIndex) {
        if (originalTabIndex === null) element.removeAttribute('tabindex');
        else element.setAttribute('tabindex', originalTabIndex);
      }
      if (targetClickHandler) element.removeEventListener('click', targetClickHandler);
      targetClickHandler = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      targetRef.current = null;
      if (updateReactState) setTarget(null);
    };

    const scheduleMissing = () => {
      if (missingTimer || expired) return;
      missingTimer = window.setTimeout(() => {
        missingTimer = 0;
        if (targetRef.current) return;
        expired = true;
        observer?.disconnect();
        statusChangeRef.current('missing');
      }, 2_500);
    };

    const attach = (element: HTMLElement) => {
      const nextInstruction = element.dataset.guidedInstruction ?? intent.instruction;
      if (targetRef.current === element) {
        setInstruction(nextInstruction);
        updatePosition();
        statusChangeRef.current('found');
        return;
      }
      detach();
      targetRef.current = element;
      insertedTabIndex = false;
      originalDescription = element.getAttribute('aria-describedby');
      originalTabIndex = element.getAttribute('tabindex');
      const describedBy = [originalDescription, coachId].filter(Boolean).join(' ');
      element.setAttribute('aria-describedby', describedBy);
      if (!element.matches('button, a, input, select, textarea, [tabindex]')) {
        element.setAttribute('tabindex', '-1');
        insertedTabIndex = true;
      }
      element.classList.add('guided-action-target');
      targetClickHandler = (event: MouseEvent) => {
        const actionableSelector = 'button, a, input, select, textarea, [role="button"], [role="link"]';
        const clicked = event.target instanceof Element
          ? event.target.closest<HTMLElement>(actionableSelector)
          : null;
        const activatedControl = element.matches(actionableSelector)
          ? element
          : clicked && element.contains(clicked)
            ? clicked
            : null;
        // Group targets describe a choice. Clicking their padding is not a
        // choice and must not dismiss or advance the guide.
        if (!activatedControl) return;
        if (element.dataset.guidedFollow !== 'true') {
          completeRef.current();
          return;
        }
        // Follow actions can stay busy for many seconds while Nox handles
        // resolve and decrypt. Keep the current control highlighted and let
        // the observer hand the coach directly to the next real control.
        // The missing timer is only meaningful after this control leaves.
        following = true;
        window.clearTimeout(missingTimer);
        missingTimer = 0;
        statusChangeRef.current('locating');
        window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(locate);
      };
      element.addEventListener('click', targetClickHandler);
      setInstruction(nextInstruction);
      setTarget(element);
      window.clearTimeout(missingTimer);
      missingTimer = 0;
      statusChangeRef.current('found');
      resizeObserver = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(updatePosition);
      resizeObserver?.observe(element);
      element.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center',
        inline: 'nearest',
      });
      frame = window.requestAnimationFrame(updatePosition);
    };

    const locate = () => {
      if (expired) return;
      const matches = Array.from(document.querySelectorAll<HTMLElement>(
        `[data-guided-action="${intent.targetId}"]`,
      ));
      const next = matches.find((element) => {
        const rect = element.getBoundingClientRect();
        const disabled = 'disabled' in element && Boolean((element as HTMLButtonElement).disabled);
        return !disabled && rect.width > 0 && rect.height > 0;
      });
      const current = targetRef.current;
      if (next) {
        if (following && next !== current) following = false;
        attach(next);
        return;
      }

      const busyTarget = following
        ? matches.find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        : null;
      if (busyTarget && busyTarget !== current) {
        // Some async controls replace their DOM node when they enter a busy
        // state. Rebind to that visible replacement without ever entering the
        // missing-target countdown.
        attach(busyTarget);
        statusChangeRef.current('locating');
        return;
      }

      // Keep a busy action highlighted while it is disabled in place. Its
      // marker disappears (or moves) only when the UI has a genuine next step.
      if (current?.isConnected && current.dataset.guidedAction === intent.targetId) {
        // React may reconcile the control's className while toggling its busy
        // state. Restore the imperative coach marker without rebinding or
        // stealing focus from the in-flight action.
        current.classList.add('guided-action-target');
        setInstruction(current.dataset.guidedInstruction ?? intent.instruction);
        updatePosition();
        if (following) statusChangeRef.current('locating');
        return;
      }
      if (current) {
        detach();
        following = false;
      }
      statusChangeRef.current('locating');
      scheduleMissing();
    };

    statusChangeRef.current('locating');
    locate();
    observer = new MutationObserver(() => {
      if (expired) return;
      window.cancelAnimationFrame(frame);
      // DOM transitions such as enabled -> busy and busy -> next action are
      // already delivered after React commits. Reconcile the coach now so a
      // rerender cannot leave a one-frame gap or outrun a fake/slow RAF.
      locate();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-guided-action', 'data-guided-instruction', 'disabled'],
    });
    const onViewportScroll = () => updatePosition();
    const onViewportResize = () => {
      targetRef.current?.scrollIntoView({
        behavior: 'auto',
        block: 'center',
        inline: 'nearest',
      });
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updatePosition);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') completeRef.current();
    };
    window.addEventListener('resize', onViewportResize);
    window.addEventListener('scroll', onViewportScroll, true);
    document.addEventListener('keydown', onKeyDown);
    if (!targetRef.current) scheduleMissing();

    return () => {
      window.clearTimeout(missingTimer);
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', onViewportResize);
      window.removeEventListener('scroll', onViewportScroll, true);
      document.removeEventListener('keydown', onKeyDown);
      detach(false);
    };
  }, [intent]);

  if (!target) return null;

  return (
    <div
      id={`guided-action-coach-${intent.id}`}
      className={`guided-action-coach ${placement}`}
      style={position}
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true">Next</span>
      <b>{instruction}</b>
    </div>
  );
}
