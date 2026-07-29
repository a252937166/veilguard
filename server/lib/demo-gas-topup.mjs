/**
 * Keep native-gas sponsorship behind an explicit opt-in boundary.
 *
 * The callback is deliberately injected so tests can prove that a disabled
 * release cannot reach the Admin transfer, even when the Delegate is below the
 * configured gas floor.
 */
export async function maybeTopUpDemoGas({
  balance,
  floor,
  enabled,
  topup,
} = {}) {
  if (typeof balance !== 'bigint' || balance < 0n) {
    throw new Error('demo gas balance must be a non-negative bigint');
  }
  if (typeof floor !== 'bigint' || floor < 1n) {
    throw new Error('demo gas floor must be a positive bigint');
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('demo gas top-up enabled must be boolean');
  }
  if (typeof topup !== 'function') {
    throw new Error('demo gas top-up callback is required');
  }
  if (balance >= floor) return { ready: true, toppedUp: false };
  if (!enabled) return { ready: false, toppedUp: false };

  await topup();
  return { ready: true, toppedUp: true };
}
