import { useEffect, useRef, type ReactNode } from 'react';

type ModalDialogProps = {
  labelledBy: string;
  describedBy?: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * Native modal semantics with deterministic focus entry and restoration.
 * `showModal()` makes the rest of the page inert and keeps keyboard focus
 * inside the dialog without recreating a fragile focus trap in application code.
 */
export function ModalDialog({
  labelledBy,
  describedBy,
  className = '',
  onClose,
  children,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }

    const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      ?? dialog.querySelector<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      );
    window.requestAnimationFrame(() => initial?.focus());

    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      const returnTarget = returnFocusRef.current;
      window.requestAnimationFrame(() => {
        if (returnTarget?.isConnected) returnTarget.focus();
        else document.getElementById('main-content')?.focus();
      });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`modal ${className}`.trim()}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
