import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeAbiParameters, keccak256 } from 'viem';
import { assertAuditPacketBinding } from '../../scripts/lib/audit-packet.mjs';
import { createFreshRunController } from '../../scripts/lib/fresh-run.ts';
import {
  checkpointStage,
  loadFreshCheckpoint,
  markCheckpointStage,
  newFreshCheckpoint,
  recordCheckpointBroadcast,
  recordCheckpointReceipt,
  saveFreshCheckpoint,
  setCheckpointValue,
} from '../../scripts/lib/fresh-checkpoint.mjs';

const address = (digit) => `0x${digit.repeat(40)}`;
const hash = (digit) => `0x${digit.repeat(64)}`;
const identity = {
  chainId: 11155111,
  module: address('1'),
  safe: address('2'),
};

test('whitelisted Fresh helpers cannot hide wallet or governance execution', async () => {
  const helperPaths = [
    '../../scripts/lib/audit-packet.mjs',
    '../../scripts/lib/fresh-checkpoint.mjs',
    '../../scripts/lib/fresh-run.ts',
    '../../scripts/lib/module-events.ts',
    '../../scripts/lib/nox-consistency.ts',
  ];
  for (const helperPath of helperPaths) {
    const source = await readFile(new URL(helperPath, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /safeExec2of2|createWalletClient|privateKeyToAccount|writeContract|sendTransaction|executeTransaction/,
      `${helperPath} must remain incapable of signing or broadcasting by itself`,
    );
  }
});

test('Fresh entrypoints honor the checkpoint path loaded from .env', async () => {
  for (const script of [
    '../../scripts/deploy-sepolia.ts',
    '../../scripts/smoke-sepolia.ts',
    '../../scripts/e2e-sepolia.ts',
  ]) {
    const source = await readFile(new URL(script, import.meta.url), 'utf8');
    assert.match(
      source,
      /checkpointPath\(env\('FRESH_RUN_CHECKPOINT_PATH'\)\)/,
      `${script} must bridge its .env value into the checkpoint helper`,
    );
  }
});

test('Fresh checkpoint is atomic, permissioned and deployment-bound', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'veilguard-fresh-checkpoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'checkpoint.json');

  let checkpoint = newFreshCheckpoint(identity);
  checkpoint = setCheckpointValue(checkpoint, 'mandateId', '1');
  checkpoint = recordCheckpointBroadcast(checkpoint, 'smoke.propose', hash('a'));
  checkpoint = saveFreshCheckpoint(path, checkpoint);

  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')));
  assert.equal(loadFreshCheckpoint(path, identity).values.mandateId, '1');
  assert.throws(
    () => loadFreshCheckpoint(path, { ...identity, module: address('3') }),
    /different deployment/,
  );

  const same = recordCheckpointBroadcast(checkpoint, 'smoke.propose', hash('a'));
  assert.equal(checkpointStage(same, 'smoke.propose').hash, hash('a'));
  assert.throws(
    () => recordCheckpointBroadcast(checkpoint, 'smoke.propose', hash('b')),
    /refusing duplicate broadcast/,
  );
});

test('Fresh checkpoint binds a successful receipt to the tracked broadcast', () => {
  let checkpoint = newFreshCheckpoint(identity);
  checkpoint = recordCheckpointBroadcast(checkpoint, 'e2e.request.execute', hash('a'));
  assert.throws(
    () => recordCheckpointReceipt(checkpoint, 'e2e.request.execute', {
      transactionHash: hash('b'),
      status: 'success',
      blockNumber: 1n,
    }),
    /does not match/,
  );
  checkpoint = recordCheckpointReceipt(checkpoint, 'e2e.request.execute', {
    transactionHash: hash('a'),
    status: 'success',
    blockNumber: 42n,
  }, { requestId: '3' });
  checkpoint = markCheckpointStage(checkpoint, 'e2e.request.execute', {
    state: 'Executed',
  });
  assert.deepEqual(
    {
      status: checkpointStage(checkpoint, 'e2e.request.execute').status,
      blockNumber: checkpointStage(checkpoint, 'e2e.request.execute').blockNumber,
      requestId: checkpointStage(checkpoint, 'e2e.request.execute').requestId,
      state: checkpointStage(checkpoint, 'e2e.request.execute').state,
    },
    {
      status: 'success',
      blockNumber: '42',
      requestId: '3',
      state: 'Executed',
    },
  );
});

test('Audit Packet validator binds event, storage, scope and ABI manifest', () => {
  const auditor = address('3');
  const requestIds = [1n, 2n, 3n, 4n];
  const snapshots = Array.from({ length: 11 }, (_, index) =>
    `0x${(index + 1).toString(16).padStart(64, '0')}`);
  const manifestHash = keccak256(encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'uint32' },
      { type: 'uint256[]' },
      { type: 'bytes32[]' },
    ],
    [auditor, 1n, 1, requestIds, snapshots],
  ));
  const event = {
    address: identity.module,
    args: { auditor, mandateId: 1n, manifestHash },
  };
  const packet = [auditor, 1n, 1, manifestHash, 123n, requestIds, snapshots];

  const validated = assertAuditPacketBinding({
    module: identity.module,
    event,
    packet,
    auditor,
    mandateId: 1n,
    policyVersion: 1,
    requestIds,
  });
  assert.equal(validated.manifestHash, manifestHash);
  assert.equal(validated.snapshots.length, 11);

  assert.throws(
    () => assertAuditPacketBinding({
      module: identity.module,
      event,
      packet: [...packet.slice(0, 5), [1n, 2n, 4n, 3n], snapshots],
      auditor,
      mandateId: 1n,
      policyVersion: 1,
      requestIds,
    }),
    /request IDs mismatch/,
  );
  assert.throws(
    () => assertAuditPacketBinding({
      module: identity.module,
      event: { ...event, args: { ...event.args, manifestHash: hash('f') } },
      packet,
      auditor,
      mandateId: 1n,
      policyVersion: 1,
      requestIds,
    }),
    /manifest/,
  );
});

test('Fresh transaction recovery follows the persisted hash and never rebroadcasts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'veilguard-fresh-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'checkpoint.json');
  const receipt = {
    transactionHash: hash('a'),
    status: 'success',
    blockNumber: 7n,
    logs: [],
  };
  let broadcasts = 0;
  let waits = 0;
  const publicClient = {
    waitForTransactionReceipt: async ({ hash: requested }) => {
      waits += 1;
      assert.equal(requested, hash('a'));
      return receipt;
    },
  };
  const options = {
    publicClient,
    chainId: identity.chainId,
    module: identity.module,
    safe: identity.safe,
    path,
    log: () => {},
  };

  const first = createFreshRunController(options);
  await first.transaction({
    key: 'smoke.request',
    label: 'request',
    broadcast: async () => {
      broadcasts += 1;
      return hash('a');
    },
  });
  assert.equal(broadcasts, 1);
  assert.equal(loadFreshCheckpoint(path, identity).stages['smoke.request'].status, 'success');

  const resumed = createFreshRunController(options);
  const recovered = await resumed.transaction({
    key: 'smoke.request',
    label: 'request',
    broadcast: async () => {
      broadcasts += 1;
      return hash('b');
    },
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.hash, hash('a'));
  assert.equal(broadcasts, 1);
  assert.equal(waits, 2);
});

test('Fresh transaction recovery fails closed on an ambiguous stage without a hash', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'veilguard-fresh-ambiguous-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'checkpoint.json');
  saveFreshCheckpoint(
    path,
    markCheckpointStage(newFreshCheckpoint(identity), 'e2e.request', {
      status: 'preparing',
    }),
  );
  let broadcasts = 0;
  const run = createFreshRunController({
    publicClient: {
      waitForTransactionReceipt: async () => {
        throw new Error('must not wait without a hash');
      },
    },
    chainId: identity.chainId,
    module: identity.module,
    safe: identity.safe,
    path,
    log: () => {},
  });
  await assert.rejects(
    run.transaction({
      key: 'e2e.request',
      label: 'request',
      broadcast: async () => {
        broadcasts += 1;
        return hash('a');
      },
    }),
    /refusing a possible duplicate transaction/,
  );
  assert.equal(broadcasts, 0);
});

test('Fresh Safe recovery reconciles an already-complete ambiguous no-hash stage', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'veilguard-fresh-safe-reconcile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'checkpoint.json');
  saveFreshCheckpoint(
    path,
    markCheckpointStage(newFreshCheckpoint(identity), 'e2e.safe', {
      status: 'preparing',
    }),
  );
  let stateChecks = 0;
  let waits = 0;
  let executions = 0;
  const run = createFreshRunController({
    publicClient: {
      waitForTransactionReceipt: async () => {
        waits += 1;
        throw new Error('must not wait without a tracked hash');
      },
    },
    chainId: identity.chainId,
    module: identity.module,
    safe: identity.safe,
    path,
    log: () => {},
  });

  await run.safeAction({
    key: 'e2e.safe',
    label: 'Safe action',
    isComplete: async () => {
      stateChecks += 1;
      return true;
    },
    execute: async () => {
      executions += 1;
      return { executeTxHash: hash('d') };
    },
  });

  const recovered = loadFreshCheckpoint(path, identity).stages['e2e.safe'];
  assert.equal(stateChecks, 1);
  assert.equal(waits, 0);
  assert.equal(executions, 0);
  assert.equal(recovered.status, 'verified');
  assert.equal(recovered.recoveredFromChainState, true);
  assert.equal(recovered.reconciledAmbiguousCheckpoint, true);
  assert.equal(recovered.hash, undefined);
});

test('Fresh Safe recovery still fails closed when an ambiguous no-hash target is incomplete', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'veilguard-fresh-safe-incomplete-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'checkpoint.json');
  saveFreshCheckpoint(
    path,
    markCheckpointStage(newFreshCheckpoint(identity), 'e2e.safe', {
      status: 'preparing',
    }),
  );
  let stateChecks = 0;
  let executions = 0;
  const run = createFreshRunController({
    publicClient: {
      waitForTransactionReceipt: async () => {
        throw new Error('must not wait without a tracked hash');
      },
    },
    chainId: identity.chainId,
    module: identity.module,
    safe: identity.safe,
    path,
    log: () => {},
  });

  await assert.rejects(
    run.safeAction({
      key: 'e2e.safe',
      label: 'Safe action',
      isComplete: async () => {
        stateChecks += 1;
        return false;
      },
      execute: async () => {
        executions += 1;
        return { executeTxHash: hash('d') };
      },
    }),
    /refusing a possible duplicate Safe execution/,
  );
  assert.equal(stateChecks, 1);
  assert.equal(executions, 0);
});

test('Fresh Safe recovery binds the callback hash and verifies its receipt before state', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'veilguard-fresh-safe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'checkpoint.json');
  const order = [];
  let complete = false;
  let executions = 0;
  const options = {
    publicClient: {
      waitForTransactionReceipt: async ({ hash: requested }) => {
        order.push('wait');
        assert.equal(requested, hash('c'));
        return {
          transactionHash: hash('c'),
          status: 'success',
          blockNumber: 9n,
          logs: [],
        };
      },
    },
    chainId: identity.chainId,
    module: identity.module,
    safe: identity.safe,
    path,
    log: () => {},
  };
  const run = createFreshRunController(options);
  await run.safeAction({
    key: 'e2e.safe',
    label: 'Safe action',
    isComplete: async () => {
      order.push('state');
      return complete;
    },
    execute: async (onBroadcast) => {
      order.push('execute');
      executions += 1;
      onBroadcast(hash('c'));
      complete = true;
      return { executeTxHash: hash('c') };
    },
  });
  assert.deepEqual(order, ['state', 'execute', 'wait', 'state']);
  assert.equal(loadFreshCheckpoint(path, identity).stages['e2e.safe'].hash, hash('c'));

  order.length = 0;
  const resumed = createFreshRunController(options);
  await resumed.safeAction({
    key: 'e2e.safe',
    label: 'Safe action',
    isComplete: async () => {
      order.push('state');
      return true;
    },
    execute: async () => {
      executions += 1;
      return { executeTxHash: hash('d') };
    },
  });
  assert.deepEqual(order, ['wait', 'state']);
  assert.equal(executions, 1);
});

test('Smoke bypasses its historical payee balance only for a confirmed downstream Safe hash', async () => {
  const source = await readFile(
    new URL('../../scripts/smoke-sepolia.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /run\.stage\('e2e\.executed\.safe'\)/);
  assert.match(source, /downstreamExecution\?\.hash/);
  assert.match(source, /\['success', 'verified'\]\.includes\(String\(downstreamExecution\.status\)\)/);
  assert.doesNotMatch(
    source,
    /Boolean\(run\.stage\('e2e\.executed\.request'\)\)/,
  );
});

test('E2E bypasses its restored-budget boundary only for a confirmed downstream Safe hash', async () => {
  const source = await readFile(
    new URL('../../scripts/e2e-sepolia.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /run\.stage\('e2e\.executed\.safe'\)/);
  assert.match(source, /downstreamExecution\?\.hash/);
  assert.match(source, /\['success', 'verified'\]\.includes\(String\(downstreamExecution\.status\)\)/);
  assert.doesNotMatch(
    source,
    /if \(!run\.stage\('e2e\.executed\.request'\)\)/,
  );
});
