import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ProvisionChallengeError,
  createProvisionChallengeService,
} from '../lib/provision-security.mjs';

const moduleAddress = '0x02e9b09f5929604b101244661835605b1ee67fea';
const applicant = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);

function service(options = {}) {
  let counter = 0;
  return createProvisionChallengeService({
    chainId: 11155111,
    module: moduleAddress,
    nonce: () => `0x${String(++counter).padStart(64, '0')}`,
    ...options,
  });
}

test('challenge is typed, JSON-safe, stable until consumed and reflected in health', () => {
  const challenges = service({ now: () => 1_000_000 });
  const first = challenges.issue(applicant.address);
  const second = challenges.issue(applicant.address.toLowerCase());

  assert.deepEqual(second, first);
  assert.equal(first.typedData.domain.chainId, 11155111);
  assert.equal(first.typedData.domain.verifyingContract.toLowerCase(), moduleAddress);
  assert.equal(first.typedData.message.applicant, applicant.address);
  assert.equal(typeof first.typedData.message.expiresAt, 'string');
  assert.doesNotThrow(() => JSON.stringify(first));
  assert.deepEqual(challenges.status(), {
    required: true,
    pending: 1,
    ttlSeconds: 300,
    persistence: 'process-local-single-use',
  });
});

test('only the challenged wallet can consume a nonce and it is single-use', async () => {
  const challenges = service({ now: () => 1_000_000 });
  const challenge = challenges.issue(applicant.address);
  const signature = await applicant.signTypedData(challenge.typedData);

  assert.equal(
    await challenges.verify({
      address: applicant.address,
      challengeId: challenge.challengeId,
      signature,
    }),
    applicant.address,
  );
  await assert.rejects(
    challenges.verify({
      address: applicant.address,
      challengeId: challenge.challengeId,
      signature,
    }),
    (error) => error instanceof ProvisionChallengeError && error.status === 401,
  );
});

test('a wrong signature fails closed and consumes the nonce', async () => {
  const challenges = service({ now: () => 1_000_000 });
  const challenge = challenges.issue(applicant.address);
  const wrongSignature = await other.signTypedData(challenge.typedData);

  await assert.rejects(
    challenges.verify({
      address: applicant.address,
      challengeId: challenge.challengeId,
      signature: wrongSignature,
    }),
    /does not match/,
  );
  await assert.rejects(
    challenges.verify({
      address: applicant.address,
      challengeId: challenge.challengeId,
      signature: wrongSignature,
    }),
    /missing, expired or already used/,
  );
});

test('expired challenges are rejected and purged', async () => {
  let currentTime = 1_000_000;
  const challenges = service({ now: () => currentTime, ttlMs: 60_000 });
  const challenge = challenges.issue(applicant.address);
  const signature = await applicant.signTypedData(challenge.typedData);
  currentTime += 60_001;

  await assert.rejects(
    challenges.verify({
      address: applicant.address,
      challengeId: challenge.challengeId,
      signature,
    }),
    /missing, expired or already used/,
  );
  assert.equal(challenges.status().pending, 0);
});
