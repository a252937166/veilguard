import { describe, expect, it } from 'vitest';
import { derivePolicyCapabilities } from '../src/policy-capabilities';

describe('policy capability boundaries', () => {
  it('lets the Finance Admin propose and tighten, but not widen governance', () => {
    expect(derivePolicyCapabilities({
      isFinanceAdmin: true,
      isSafeOwner: false,
      policyState: 2,
      paused: false,
      hasPendingRequest: false,
      hasActiveDelegatePendingRequest: false,
    })).toMatchObject({
      canPropose: true,
      canPause: true,
      canActivate: false,
      canRetire: false,
      canResume: false,
      canRotateAdmin: false,
    });
  });

  it('lets a Safe owner activate, retire, or resume only in valid states', () => {
    expect(derivePolicyCapabilities({
      isFinanceAdmin: false,
      isSafeOwner: true,
      policyState: 1,
      paused: false,
      hasPendingRequest: false,
      hasActiveDelegatePendingRequest: false,
    })).toMatchObject({ canActivate: true, canRetire: true, canResume: false });

    expect(derivePolicyCapabilities({
      isFinanceAdmin: false,
      isSafeOwner: true,
      policyState: 2,
      paused: true,
      hasPendingRequest: true,
      hasActiveDelegatePendingRequest: false,
    })).toMatchObject({
      canActivate: false,
      canRetire: false,
      canResume: true,
      retireBlockedReason: 'Resolve the in-flight request before retiring this mandate.',
    });
  });

  it('keeps observers read-only and never exposes admin rotation', () => {
    expect(derivePolicyCapabilities({
      isFinanceAdmin: false,
      isSafeOwner: false,
      policyState: 2,
      paused: false,
      hasPendingRequest: false,
      hasActiveDelegatePendingRequest: false,
    })).toEqual({
      canPropose: false,
      canPause: false,
      canActivate: false,
      canRetire: false,
      canResume: false,
      canRotateAdmin: false,
    });
  });

  it('blocks draft activation while the same delegate active mandate has an in-flight request', () => {
    expect(derivePolicyCapabilities({
      isFinanceAdmin: false,
      isSafeOwner: true,
      policyState: 1,
      paused: false,
      hasPendingRequest: false,
      hasActiveDelegatePendingRequest: true,
    })).toMatchObject({
      canActivate: false,
      activateBlockedReason: "Resolve the active mandate's in-flight request before activating this draft.",
    });
  });
});
