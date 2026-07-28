export type NoxRetryOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (error: unknown) => boolean;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

export class NoxProductionError extends Error {
  phase: "resolution" | "simulation" | "read";
  attempts: number;
  timeoutMs: number;
  code: "NOX_OPERATION_NOT_RETRYABLE" | "NOX_PROPAGATION_TIMEOUT";
}

export function areNoxHandlesResolved(
  statusUrl: string,
  handles: readonly string[],
  options?: NoxRetryOptions,
): Promise<boolean>;

export function waitForNoxHandlesResolved(
  statusUrl: string,
  handles: readonly string[],
  options?: NoxRetryOptions,
): Promise<void>;

export function retryNoxRead<T>(
  label: string,
  operation: () => Promise<T>,
  options?: NoxRetryOptions,
): Promise<T>;

export function waitUntilNoxSimulatable<T>(
  label: string,
  simulate: () => Promise<T>,
  options?: NoxRetryOptions,
): Promise<T>;

export function resolveThenRetryNoxRead<T>(args: {
  statusUrl: string;
  handles: readonly string[];
  label: string;
  operation: () => Promise<T>;
  resolution?: NoxRetryOptions;
  usability?: NoxRetryOptions;
}): Promise<T>;
