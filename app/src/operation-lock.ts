export type OperationFeedback = 'global' | 'inline';

export type OperationSpec = {
  /** Stable operation identity used in user-facing conflict messages. */
  key: string;
  label: string;
  /**
   * Actual resources whose nonce or contract slot must remain serialized.
   * Read-only work deliberately supplies no resources and is never blocked.
   */
  resources?: readonly string[];
  feedback?: OperationFeedback;
};

export type ActiveOperation = OperationSpec & {
  token: symbol;
  startedAt: number;
};

export type OperationAcquireResult =
  | { acquired: true; operation: ActiveOperation }
  | { acquired: false; blocker: ActiveOperation };

/**
 * Coordinates browser-side mutations by the resources that can actually race
 * (wallet nonce, Safe nonce, mandate slot, request finalization), rather than
 * freezing the entire application behind one boolean flag.
 */
export class OperationCoordinator {
  private readonly active = new Map<string, ActiveOperation>();

  acquire(spec: OperationSpec, now = Date.now()): OperationAcquireResult {
    const resources = [...new Set(spec.resources ?? [])];
    for (const resource of resources) {
      const blocker = this.active.get(resource);
      if (blocker) return { acquired: false, blocker };
    }

    const operation: ActiveOperation = {
      ...spec,
      resources,
      feedback: spec.feedback ?? 'global',
      token: Symbol(spec.key),
      startedAt: now,
    };
    resources.forEach((resource) => this.active.set(resource, operation));
    return { acquired: true, operation };
  }

  release(operation: ActiveOperation): void {
    for (const resource of operation.resources ?? []) {
      // A delayed finally block must never release a newer owner of the same
      // resource. Tokens make release ownership explicit.
      if (this.active.get(resource)?.token === operation.token) this.active.delete(resource);
    }
  }

  blockerFor(resources: readonly string[]): ActiveOperation | undefined {
    for (const resource of resources) {
      const blocker = this.active.get(resource);
      if (blocker) return blocker;
    }
    return undefined;
  }
}

export type LocalOperationLock = { current: boolean };

/** Component-local same-frame guard; global mutation conflicts use the coordinator. */
export function acquireLocalOperationLock(lock: LocalOperationLock): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseLocalOperationLock(lock: LocalOperationLock): void {
  lock.current = false;
}
