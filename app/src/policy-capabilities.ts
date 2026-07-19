export type PolicyCapabilities = {
  canPropose: boolean;
  canPause: boolean;
  canActivate: boolean;
  canRetire: boolean;
  canResume: boolean;
  canRotateAdmin: false;
  activateBlockedReason?: string;
  retireBlockedReason?: string;
};

export function derivePolicyCapabilities(input: {
  isFinanceAdmin: boolean;
  isSafeOwner: boolean;
  policyState?: number;
  paused: boolean;
  hasPendingRequest: boolean;
  hasActiveDelegatePendingRequest: boolean;
}): PolicyCapabilities {
  const { isFinanceAdmin, isSafeOwner, policyState, paused, hasPendingRequest, hasActiveDelegatePendingRequest } = input;
  const retireState = policyState === 1 || policyState === 2;
  const activationBlocked = policyState === 1 && hasActiveDelegatePendingRequest;
  return {
    canPropose: isFinanceAdmin,
    canPause: isFinanceAdmin && !paused,
    canActivate: isSafeOwner && policyState === 1 && !activationBlocked,
    canRetire: isSafeOwner && retireState && !hasPendingRequest,
    canResume: isSafeOwner && paused,
    canRotateAdmin: false,
    ...(activationBlocked ? { activateBlockedReason: "Resolve the active mandate's in-flight request before activating this draft." } : {}),
    ...(retireState && hasPendingRequest ? { retireBlockedReason: 'Resolve the in-flight request before retiring this mandate.' } : {}),
  };
}
