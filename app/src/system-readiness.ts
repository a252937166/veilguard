import { ADDR, safeAbi } from './config';
import { handlesResolved, publicClient } from './nox';

export type ReadinessCheck = {
  ok: boolean | null;
  detail: string;
};

export type SystemReadiness = {
  rpc: ReadinessCheck;
  keeper: ReadinessCheck;
  gateway: ReadinessCheck;
  safeThreshold: ReadinessCheck;
  module: ReadinessCheck;
};

export const INITIAL_SYSTEM_READINESS: SystemReadiness = {
  rpc: { ok: null, detail: 'Contacting Sepolia' },
  keeper: { ok: null, detail: 'Contacting proof service' },
  gateway: { ok: null, detail: 'No decision handle yet' },
  safeThreshold: { ok: null, detail: 'Reading Safe configuration' },
  module: { ok: null, detail: 'Reading Safe modules' },
};

async function probeRpc(): Promise<ReadinessCheck> {
  try {
    const block = await publicClient.getBlockNumber();
    return { ok: true, detail: `Sepolia block ${block.toString()}` };
  } catch {
    return { ok: false, detail: 'All browser RPC endpoints unavailable' };
  }
}

async function probeKeeper(): Promise<ReadinessCheck> {
  try {
    const response = await fetch('/api/health', { signal: AbortSignal.timeout(6_000) });
    const result = await response.json();
    const ok = Boolean(response.ok && result?.ok && result?.sweep !== false);
    return { ok, detail: ok ? 'Proof-gated finalizer online' : 'Health response is degraded' };
  } catch {
    return { ok: false, detail: 'Proof service unavailable' };
  }
}

async function probeGateway(handle?: string): Promise<ReadinessCheck> {
  if (!handle) return { ok: null, detail: 'No decision handle yet' };
  const ok = await handlesResolved([handle]);
  return { ok, detail: ok ? 'Latest decision handle resolved' : 'Latest decision handle unresolved' };
}

async function probeSafeThreshold(): Promise<ReadinessCheck> {
  try {
    const threshold = await publicClient.readContract({
      address: ADDR.Safe,
      abi: safeAbi,
      functionName: 'getThreshold',
    });
    const ok = threshold === 2n;
    return { ok, detail: ok ? '2-of-2 signatures required' : `Unexpected threshold: ${threshold.toString()}` };
  } catch {
    return { ok: false, detail: 'Safe threshold unreadable' };
  }
}

async function probeModule(): Promise<ReadinessCheck> {
  try {
    const enabled = await publicClient.readContract({
      address: ADDR.Safe,
      abi: safeAbi,
      functionName: 'isModuleEnabled',
      args: [ADDR.VeilGuardModule],
    });
    return {
      ok: enabled === true,
      detail: enabled === true ? 'VeilGuard Module enabled on Safe' : 'VeilGuard Module is not enabled',
    };
  } catch {
    return { ok: false, detail: 'Safe module state unreadable' };
  }
}

export async function probeSystemReadiness(latestDecisionHandle?: string): Promise<SystemReadiness> {
  const [rpc, keeper, gateway, safeThreshold, module] = await Promise.all([
    probeRpc(),
    probeKeeper(),
    probeGateway(latestDecisionHandle),
    probeSafeThreshold(),
    probeModule(),
  ]);
  return { rpc, keeper, gateway, safeThreshold, module };
}
