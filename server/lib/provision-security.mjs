import { randomBytes } from 'node:crypto';
import { getAddress, recoverTypedDataAddress } from 'viem';

export class ProvisionChallengeError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ProvisionChallengeError';
    this.status = status;
  }
}

const TYPES = Object.freeze({
  Provision: Object.freeze([
    Object.freeze({ name: 'applicant', type: 'address' }),
    Object.freeze({ name: 'nonce', type: 'bytes32' }),
    Object.freeze({ name: 'expiresAt', type: 'uint64' }),
  ]),
});

/**
 * In-memory, single-use ownership challenges. A restart invalidates every
 * outstanding challenge (fail closed); no signing secret or wallet identifier
 * is persisted server-side.
 */
export function createProvisionChallengeService({
  chainId,
  module,
  ttlMs = 5 * 60_000,
  maxPending = 1_000,
  now = () => Date.now(),
  nonce = () => `0x${randomBytes(32).toString('hex')}`,
  recover = recoverTypedDataAddress,
} = {}) {
  if (!Number.isInteger(Number(chainId)) || Number(chainId) < 1) {
    throw new Error('provision challenge chain id is required');
  }
  let verifyingContract;
  try { verifyingContract = getAddress(module); }
  catch { throw new Error('provision challenge module address is invalid'); }
  if (!Number.isFinite(ttlMs) || ttlMs < 60_000 || ttlMs > 15 * 60_000) {
    throw new Error('provision challenge TTL must be between 1 and 15 minutes');
  }
  if (!Number.isInteger(maxPending) || maxPending < 1) {
    throw new Error('provision challenge capacity must be a positive integer');
  }

  const pending = new Map();
  const domain = Object.freeze({
    name: 'VeilGuard Provisioning',
    version: '1',
    chainId: Number(chainId),
    verifyingContract,
  });

  const purge = () => {
    const current = now();
    for (const [key, value] of pending) {
      if (value.expiresAtMs <= current) pending.delete(key);
    }
  };

  const wire = (entry) => ({
    challengeId: entry.challengeId,
    expiresAt: new Date(entry.expiresAtMs).toISOString(),
    typedData: {
      domain,
      types: TYPES,
      primaryType: 'Provision',
      message: entry.message,
    },
  });

  return {
    issue(address) {
      let applicant;
      try { applicant = getAddress(address); }
      catch { throw new ProvisionChallengeError(400, 'invalid address'); }
      purge();
      const key = applicant.toLowerCase();
      const existing = pending.get(key);
      if (existing) return wire(existing);
      if (pending.size >= maxPending) {
        throw new ProvisionChallengeError(429, 'too many pending provisioning challenges');
      }

      const challengeId = nonce();
      if (!/^0x[0-9a-fA-F]{64}$/.test(challengeId)) {
        throw new Error('provision challenge nonce source returned an invalid bytes32');
      }
      const expiresAtSeconds = Math.ceil((now() + ttlMs) / 1000);
      const expiresAtMs = expiresAtSeconds * 1000;
      const entry = {
        challengeId,
        expiresAtMs,
        message: Object.freeze({
          applicant,
          nonce: challengeId,
          expiresAt: String(expiresAtSeconds),
        }),
      };
      pending.set(key, entry);
      return wire(entry);
    },

    async verify({ address, challengeId, signature } = {}) {
      let applicant;
      try { applicant = getAddress(address); }
      catch { throw new ProvisionChallengeError(400, 'invalid address'); }
      if (!/^0x[0-9a-fA-F]{64}$/.test(challengeId ?? '')) {
        throw new ProvisionChallengeError(400, 'invalid provisioning challenge');
      }
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature ?? '')) {
        throw new ProvisionChallengeError(400, 'invalid wallet signature');
      }

      purge();
      const key = applicant.toLowerCase();
      const entry = pending.get(key);
      if (!entry || entry.challengeId.toLowerCase() !== challengeId.toLowerCase()) {
        throw new ProvisionChallengeError(401, 'provisioning challenge is missing, expired or already used');
      }

      // Consume before the asynchronous recovery operation so concurrent POSTs
      // cannot both pass the same nonce. A bad signature is intentionally not
      // retryable; the wallet must request a fresh challenge.
      pending.delete(key);
      let recovered;
      try {
        recovered = await recover({
          domain,
          types: TYPES,
          primaryType: 'Provision',
          message: entry.message,
          signature,
        });
      } catch {
        throw new ProvisionChallengeError(401, 'wallet signature could not be verified');
      }
      if (recovered.toLowerCase() !== applicant.toLowerCase()) {
        throw new ProvisionChallengeError(401, 'wallet signature does not match the provisioning address');
      }
      return applicant;
    },

    status() {
      purge();
      return {
        required: true,
        pending: pending.size,
        ttlSeconds: Math.floor(ttlMs / 1000),
        persistence: 'process-local-single-use',
      };
    },
  };
}
