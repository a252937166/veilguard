import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem';
import { requireSingleReceiptEvent } from '../lib/receipt-events.mjs';

const moduleAddress = '0x02e9b09f5929604b101244661835605b1ee67fea';
const delegate = '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532';
const abi = parseAbi([
  'event MandateProposed(uint256 indexed mandateId,address indexed delegate,uint32 version)',
]);

function log(address = moduleAddress) {
  return {
    address,
    topics: encodeEventTopics({
      abi,
      eventName: 'MandateProposed',
      args: { mandateId: 7n, delegate },
    }),
    data: encodeAbiParameters([{ type: 'uint32' }], [7]),
  };
}

test('derives the contract-assigned id from the unique configured-module receipt event', () => {
  const event = requireSingleReceiptEvent({
    abi,
    contract: moduleAddress,
    receipt: { logs: [log()] },
    eventName: 'MandateProposed',
    label: 'proposal',
  });
  assert.equal(event.args.mandateId, 7n);
  assert.equal(event.args.delegate.toLowerCase(), delegate);
});

test('fails closed for a missing, duplicate or foreign-contract event', () => {
  for (const logs of [
    [],
    [log(), log()],
    [log('0x1111111111111111111111111111111111111111')],
  ]) {
    assert.throws(
      () => requireSingleReceiptEvent({
        abi,
        contract: moduleAddress,
        receipt: { logs },
        eventName: 'MandateProposed',
        label: 'proposal',
      }),
      /expected exactly one/,
    );
  }
});
