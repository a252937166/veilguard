import { describe, expect, test } from 'vitest';
import { demoMemoHash, scenarioByKey } from '../src/demo-scenarios';
import { signerDecisionHistory, signerRequestIdentity } from '../src/signer-evidence';
import type { RequestTxs } from '../src/txlog';

const handle = `0x${'1'.repeat(64)}` as const;
const delegate = '0x1111111111111111111111111111111111111111' as const;
const runId = 'launch-signer-evidence';

const request = (
  id: bigint,
  state: number,
  recipient: `0x${string}`,
  memoHash: `0x${string}` = handle,
) => ({
  id,
  mandateId: 9n,
  delegate,
  recipient,
  memoHash,
  state,
});

describe('Signer evidence boundaries', () => {
  test('keeps every recipient with an indexed approval or cancellation event', () => {
    const shieldOps = request(20n, 2, scenarioByKey('approval').recipient);
    const atlas = request(21n, 5, scenarioByKey('violation').recipient);
    const direct = request(22n, 2, scenarioByKey('routine').recipient);
    const unindexed = request(23n, 5, '0x2222222222222222222222222222222222222222');
    const transactions = new Map<string, RequestTxs>([
      ['20', { approval: `0x${'a'.repeat(64)}`, outcomePath: 'approval', safeAction: 'approve' }],
      ['21', { cancellation: `0x${'b'.repeat(64)}`, outcomePath: 'approval' }],
      ['22', { finalize: `0x${'c'.repeat(64)}`, outcomePath: 'direct' }],
    ]);

    expect(signerDecisionHistory(
      [shieldOps, atlas, direct, unindexed],
      transactions,
      { isDemoMode: false },
    ).map(({ id }) => id)).toEqual([21n, 20n]);
  });

  test('uses fixed vendor and purpose only for a run-bound Demo request', () => {
    const scenario = scenarioByKey('approval');
    const recipientOnlyMatch = request(30n, 3, scenario.recipient);
    const trusted = request(
      31n,
      3,
      scenario.recipient,
      demoMemoHash(runId, 'approval', 9n, delegate),
    );

    expect(signerRequestIdentity(runId, true, recipientOnlyMatch)).toEqual({
      trusted: false,
      vendor: 'Recipient identity unavailable',
      purpose: 'Private memo unavailable',
    });
    expect(signerRequestIdentity(runId, true, trusted)).toEqual({
      trusted: true,
      vendor: 'ShieldOps',
      purpose: 'Emergency security response',
    });
    expect(signerRequestIdentity(runId, false, trusted).trusted).toBe(false);
  });
});
