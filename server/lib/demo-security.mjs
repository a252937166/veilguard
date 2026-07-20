import { encodeAbiParameters, keccak256, stringToBytes } from 'viem';

const RUN_DOMAIN = keccak256(stringToBytes('VEILGUARD_DEMO_RUN_V1'));

/**
 * FIFO critical section which keeps accepting work after a failed task. The
 * returned function is intentionally tiny so the Safe nonce boundary can be
 * tested without importing the side-effectful HTTP provisioner.
 */
export function createSerialExecutor() {
  let tail = Promise.resolve();
  return function serialise(task) {
    const next = tail.then(task, task);
    tail = next.catch(() => {});
    return next;
  };
}

/** Exact public wire commitment shared by the browser and provisioner. */
export function buildDemoMemoHash({ chainId, module, runId, scenario, mandateId, delegate }) {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' },
      { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' },
    ],
    [
      RUN_DOMAIN, BigInt(chainId), module, keccak256(stringToBytes(runId)),
      keccak256(stringToBytes(scenario)), BigInt(mandateId), delegate,
    ],
  ));
}

export function sameAddressList(actual, expected) {
  return actual.length === expected.length
    && actual.every((address, index) => address.toLowerCase() === expected[index].toLowerCase());
}
