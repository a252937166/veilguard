export type OperationLock = { current: boolean };

/**
 * Acquires a synchronous UI operation lock. React state updates do not become
 * visible until the next render, so this closes the same-frame multi-click gap.
 */
export function acquireOperationLock(lock: OperationLock): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseOperationLock(lock: OperationLock): void {
  lock.current = false;
}
