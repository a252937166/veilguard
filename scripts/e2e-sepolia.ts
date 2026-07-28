/**
 * Sepolia E2E — recoverable three-state and selective-disclosure coverage.
 *
 * Prerequisite: deploy-sepolia.ts and smoke-sepolia.ts completed with the same
 * deployment-bound Fresh checkpoint. Every ID comes from the exact receipt
 * event that created it. Every broadcast hash is persisted before receipt
 * polling, so a restart follows the original transaction instead of creating a
 * replacement request or packet.
 *
 * Run: npx hardhat run scripts/e2e-sepolia.ts --network sepolia
 */
import { network } from 'hardhat';
import { readFileSync } from 'node:fs';
import {
  createWalletClient,
  encodeFunctionData,
  http,
  padHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';
import { assertAuditPacketBinding } from './lib/audit-packet.mjs';
import { checkpointPath } from './lib/fresh-checkpoint.mjs';
import { createFreshRunController } from './lib/fresh-run.js';
import { requireSingleModuleEvent } from './lib/module-events.js';
import {
  retryNoxRead,
  waitForHandlesResolved,
  waitUntilSimulatable,
  type NoxUsabilityTiming,
} from './lib/nox-consistency.js';
import { env, RPC, safeExec2of2 } from './safe-lib.js';

const deployments = JSON.parse(
  readFileSync(new URL('../deployments.json', import.meta.url), 'utf8'),
);
const { ConfidentialUSDC, Safe, VeilGuardModule } = deployments.contracts;
const GATEWAY_STATUS =
  'https://gateway-testnets.noxprotocol.dev/v0/public/handles/status';
const usdc = (n: number) => BigInt(Math.round(n * 1e6));

const conn = await network.connect('sepolia');
const { viem } = conn;
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const wallet = (key: string) =>
  createWalletClient({
    account: privateKeyToAccount(env(key)! as `0x${string}`),
    chain: sepolia,
    transport: http(RPC),
  });
const admin = wallet('DEMO_ADMIN_KEY');
const delegate = wallet('DEMO_DELEGATE_KEY');
const auditor = wallet('DEMO_AUDITOR_KEY');
const safeKeys = {
  ownerAKey: env('DEMO_ADMIN_KEY')!,
  ownerBKey: env('DEMO_SIGNER_B_KEY')!,
};
const clientFor = async (client: any) =>
  createViemHandleClient({
    ...client,
    getAddresses: async () => [client.account.address],
  });
const delegateClient = await clientFor(delegate);
const adminClient = await clientFor(admin);
const auditorClient = await clientFor(auditor);
const deployerClient = await clientFor(deployer);

const moduleAbi = JSON.parse(
  readFileSync(
    new URL(
      '../artifacts/contracts/VeilGuardModule.sol/VeilGuardModule.json',
      import.meta.url,
    ),
    'utf8',
  ),
).abi;
const wrapperAbi = [
  {
    type: 'function',
    name: 'confidentialBalanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

const run = createFreshRunController({
  publicClient,
  chainId: sepolia.id,
  module: VeilGuardModule,
  safe: Safe,
  path: checkpointPath(env('FRESH_RUN_CHECKPOINT_PATH')),
});

const safeCall = (
  fn: string,
  args: unknown[],
  onBroadcast: (hash: `0x${string}`) => void = () => {},
) =>
  safeExec2of2(
    Safe,
    VeilGuardModule,
    encodeFunctionData({ abi: moduleAbi, functionName: fn, args }),
    safeKeys,
    console.log,
    onBroadcast,
  );

const sendSimulated = async (label: string, client: any, request: any) => {
  const gas = await waitUntilSimulatable(
    label,
    () =>
      publicClient.estimateContractGas({
        ...request,
        account: client.account,
      }),
  );
  return client.writeContract({ ...request, gas: (gas * 12n) / 10n });
};

const getRequest = async (id: bigint) =>
  (await publicClient.readContract({
    address: VeilGuardModule,
    abi: moduleAbi,
    functionName: 'getRequest',
    args: [id],
  })) as any[];
const getMandate = async (id: bigint) =>
  (await publicClient.readContract({
    address: VeilGuardModule,
    abi: moduleAbi,
    functionName: 'getMandate',
    args: [id],
  })) as any[];
const requestState = async (id: bigint) => Number((await getRequest(id))[5]);

const waitForRequestState = async (
  id: bigint,
  target: number,
  timeoutMs = 60_000,
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await requestState(id)) === target) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
};

const decryptHandle = async (
  label: string,
  client: any,
  handle: `0x${string}`,
) => {
  const resolution = await waitForHandlesResolved(GATEWAY_STATUS, [handle]);
  let usability: NoxUsabilityTiming | undefined;
  const decrypted = await retryNoxRead(
    label,
    () => client.decrypt(handle),
    {
      resolvedAt: resolution.resolvedAt,
      onUsable: (timing) => {
        usability = timing;
      },
    },
  );
  return {
    value: BigInt((decrypted as { value: bigint }).value),
    resolution,
    usability,
  };
};

const decryptBudget = async (mandateId: bigint) => {
  const mandate = await getMandate(mandateId);
  return decryptHandle(
    'E2E finance-admin budget decrypt',
    adminClient,
    mandate[6] as `0x${string}`,
  );
};

const assertRequestBinding = (
  request: any[],
  requestId: bigint,
  mandateId: bigint,
) => {
  if (
    requestId <= 0n
    || BigInt(request[0]) !== mandateId
    || String(request[1]).toLowerCase() !== delegate.account.address.toLowerCase()
    || String(request[2]).toLowerCase() !== deployer.account.address.toLowerCase()
  ) {
    throw new Error('stored E2E request does not match its receipt-bound actors');
  }
};

type RequestFlow = {
  id: bigint;
  decision: number;
  state: number;
};

const requestAndFinalize = async ({
  key,
  amount,
  memo,
  expectedDecision,
}: {
  key: string;
  amount: number;
  memo: `0x${string}`;
  expectedDecision: number;
}): Promise<RequestFlow> => {
  const mandateId = BigInt(run.value<string>('smoke.mandateId')!);
  const requestKey = `e2e.${key}.request`;
  const existingRequestId = run.value<string>(`e2e.${key}.requestId`);
  if (existingRequestId && !run.stage(requestKey)?.hash) {
    throw new Error(`${key} request ID exists without its creating transaction hash`);
  }
  const { receipt } = await run.transaction({
    key: requestKey,
    label: `${key} requestSpend ${amount}`,
    broadcast: async () => {
      const encrypted = await delegateClient.encryptInput(
        usdc(amount),
        'uint256',
        VeilGuardModule,
      );
      return sendSimulated(`${key} exact requestSpend input`, delegate, {
        address: VeilGuardModule,
        abi: moduleAbi,
        functionName: 'requestSpend',
        args: [
          mandateId,
          deployer.account.address,
          encrypted.handle,
          encrypted.handleProof,
          padHex(memo, { size: 32 }),
        ],
      });
    },
  });
  const event = requireSingleModuleEvent({
    abi: moduleAbi,
    module: VeilGuardModule,
    receipt,
    eventName: 'SpendRequested',
    label: `${key} requestSpend`,
  });
  const requestId = BigInt(event.args.requestId);
  const checkpointId = run.value<string>(`e2e.${key}.requestId`);
  if (checkpointId && BigInt(checkpointId) !== requestId) {
    throw new Error(`${key} checkpoint request ID does not match its receipt`);
  }
  if (
    BigInt(event.args.mandateId) !== mandateId
    || String(event.args.delegate).toLowerCase()
      !== delegate.account.address.toLowerCase()
    || String(event.args.recipient).toLowerCase()
      !== deployer.account.address.toLowerCase()
  ) {
    throw new Error(`${key} SpendRequested event actor binding mismatch`);
  }
  run.setValue(`e2e.${key}.requestId`, String(requestId));

  let request = await getRequest(requestId);
  assertRequestBinding(request, requestId, mandateId);
  if (
    String(event.args.decisionHandle).toLowerCase()
    !== String(request[7]).toLowerCase()
  ) {
    throw new Error(`${key} decision handle differs between event and storage`);
  }

  const finalizeKey = `e2e.${key}.finalize`;
  if (Number(request[5]) === 1) {
    const handle = request[7] as `0x${string}`;
    const resolution = await waitForHandlesResolved(GATEWAY_STATUS, [handle]);
    let usability: NoxUsabilityTiming | undefined;
    const { value, decryptionProof } = await retryNoxRead(
      `${key} public decision decrypt`,
      () => delegateClient.publicDecrypt(handle),
      {
        resolvedAt: resolution.resolvedAt,
        onUsable: (timing) => {
          usability = timing;
        },
      },
    );
    const decision = Number(value);
    if (decision !== expectedDecision) {
      throw new Error(`${key} expected decision ${expectedDecision}, got ${decision}`);
    }
    run.markStage(`e2e.${key}.decision`, {
      status: 'verified',
      decision,
      resolvedMs: resolution.elapsedMs,
      resolvedToUsableMs: usability?.resolvedToUsableMs ?? 0,
    });
    await run.transaction({
      key: finalizeKey,
      label: `${key} finalize`,
      broadcast: () =>
        sendSimulated(`${key} exact finalize proof`, deployer, {
          address: VeilGuardModule,
          abi: moduleAbi,
          functionName: 'finalize',
          args: [requestId, decryptionProof],
        }),
    });
    request = await getRequest(requestId);
  } else {
    if (!run.stage(finalizeKey)?.hash) {
      throw new Error(
        `${key} request advanced without its finalize transaction hash; `
        + 'refusing unbound recovery',
      );
    }
    await run.transaction({
      key: finalizeKey,
      label: `${key} recover finalize`,
      broadcast: async () => {
        throw new Error('checkpoint recovery must never rebroadcast finalize');
      },
    });
    request = await getRequest(requestId);
  }

  const state = Number(request[5]);
  if (state === 1) {
    throw new Error(`${key} finalize receipt confirmed but request is still pending`);
  }
  const recordedDecision = Number(
    run.stage(`e2e.${key}.decision`)?.decision ?? expectedDecision,
  );
  if (recordedDecision !== expectedDecision) {
    throw new Error(`${key} recovered decision does not match the scenario`);
  }
  return { id: requestId, decision: recordedDecision, state };
};

console.log('— VeilGuard recoverable Sepolia E2E —');

// Missing or mismatched checkpoint data is rejected before the first E2E write.
const mandateValue = run.value<string>('smoke.mandateId');
const smokeRequestValue = run.value<string>('smoke.requestId');
if (!mandateValue || !smokeRequestValue || !run.stage('smoke.complete')) {
  throw new Error(
    'E2E requires a completed Smoke stage in the deployment-bound Fresh checkpoint',
  );
}
const mandateId = BigInt(mandateValue);
const smokeRequestId = BigInt(smokeRequestValue);

if (!run.stage('e2e.preflight')) {
  const [
    mandate,
    smokeRequest,
    nextMandateId,
    nextRequestId,
    nextPacketId,
    pendingRequest,
  ] = await Promise.all([
    getMandate(mandateId),
    getRequest(smokeRequestId),
    publicClient.readContract({
      address: VeilGuardModule,
      abi: moduleAbi,
      functionName: 'nextMandateId',
    }),
    publicClient.readContract({
      address: VeilGuardModule,
      abi: moduleAbi,
      functionName: 'nextRequestId',
    }),
    publicClient.readContract({
      address: VeilGuardModule,
      abi: moduleAbi,
      functionName: 'nextPacketId',
    }),
    publicClient.readContract({
      address: VeilGuardModule,
      abi: moduleAbi,
      functionName: 'pendingRequestOf',
      args: [mandateId],
    }),
  ]);
  assertRequestBinding(smokeRequest, smokeRequestId, mandateId);
  if (
    Number(mandate[4]) !== 2
    || Number(smokeRequest[5]) !== 2
    || BigInt(nextMandateId as bigint) !== mandateId + 1n
    || BigInt(nextRequestId as bigint) !== smokeRequestId + 1n
    || BigInt(nextPacketId as bigint) !== 1n
    || BigInt(pendingRequest as bigint) !== 0n
  ) {
    throw new Error(
      'Fresh E2E checkpoint is missing but the Smoke boundary is not exact; '
      + 'refusing to create replacement evidence',
    );
  }
  const baselineBudget = await decryptBudget(mandateId);
  const payeeHandle = (await publicClient.readContract({
    address: ConfidentialUSDC,
    abi: wrapperAbi,
    functionName: 'confidentialBalanceOf',
    args: [deployer.account.address],
  })) as `0x${string}`;
  const baselinePayee = await decryptHandle(
    'E2E baseline payee decrypt',
    deployerClient,
    payeeHandle,
  );
  if (baselineBudget.value !== usdc(75) || baselinePayee.value !== usdc(25)) {
    throw new Error('Fresh E2E private-value baseline does not match completed Smoke');
  }
  run.markStage('e2e.preflight', {
    status: 'verified',
    mandateId: String(mandateId),
    smokeRequestId: String(smokeRequestId),
    budgetRaw: String(baselineBudget.value),
    payeeRaw: String(baselinePayee.value),
  });
}

console.log('[A] escalate 60 → Safe cancels');
const cancelled = await requestAndFinalize({
  key: 'cancelled',
  amount: 60,
  memo: '0xa1',
  expectedDecision: 2,
});
if (![3, 5].includes(cancelled.state)) {
  throw new Error(`cancel scenario expected AwaitingSafeApproval/Cancelled, got ${cancelled.state}`);
}
let cancelRecovery = Boolean(run.stage('e2e.cancelled.safe')?.hash);
await run.safeAction({
  key: 'e2e.cancelled.safe',
  label: `cancel request #${cancelled.id}`,
  isComplete: async () => {
    if ((await requestState(cancelled.id)) === 5) return true;
    if (!cancelRecovery) return false;
    return waitForRequestState(cancelled.id, 5);
  },
  execute: (onBroadcast) => {
    cancelRecovery = true;
    return safeCall('cancelEscalated', [cancelled.id], onBroadcast);
  },
});
// A later request legitimately consumes the budget restored by cancellation.
// On recovery, retain the historical checkpoint value once that downstream
// Safe execution is confirmed instead of comparing today's aggregate state
// with an earlier stage boundary. A merely-created or ambiguous downstream
// request is not enough to bypass this assertion.
const downstreamExecution = run.stage('e2e.executed.safe');
const downstreamE2eAdvanced = Boolean(
  downstreamExecution?.hash
  && ['success', 'verified'].includes(String(downstreamExecution.status)),
);
if (!downstreamE2eAdvanced) {
  const restoredBudget = await decryptBudget(mandateId);
  if (restoredBudget.value !== usdc(75)) {
    throw new Error('Safe cancellation did not restore the encrypted budget');
  }
  run.markStage('e2e.cancelled.complete', {
    status: 'verified',
    requestId: String(cancelled.id),
    budgetRaw: String(restoredBudget.value),
    resolvedToUsableMs: restoredBudget.usability?.resolvedToUsableMs ?? 0,
  });
} else {
  run.markStage('e2e.cancelled.complete', {
    status: 'verified',
    requestId: String(cancelled.id),
    recoveredAfterDownstreamAdvance: true,
  });
}

console.log('[B] escalate 60 → Safe executes');
const executed = await requestAndFinalize({
  key: 'executed',
  amount: 60,
  memo: '0xb1',
  expectedDecision: 2,
});
if (![3, 2].includes(executed.state)) {
  throw new Error(`execute scenario expected AwaitingSafeApproval/Executed, got ${executed.state}`);
}
let executeRecovery = Boolean(run.stage('e2e.executed.safe')?.hash);
await run.safeAction({
  key: 'e2e.executed.safe',
  label: `execute request #${executed.id}`,
  isComplete: async () => {
    if ((await requestState(executed.id)) === 2) return true;
    if (!executeRecovery) return false;
    return waitForRequestState(executed.id, 2);
  },
  execute: (onBroadcast) => {
    executeRecovery = true;
    return safeCall('executeEscalated', [executed.id], onBroadcast);
  },
});
const remainingBudget = await decryptBudget(mandateId);
if (remainingBudget.value !== usdc(15)) {
  throw new Error('Safe execution produced an unexpected encrypted budget');
}
const payeeHandle = (await publicClient.readContract({
  address: ConfidentialUSDC,
  abi: wrapperAbi,
  functionName: 'confidentialBalanceOf',
  args: [deployer.account.address],
})) as `0x${string}`;
const payee = await decryptHandle(
  'E2E final payee decrypt',
  deployerClient,
  payeeHandle,
);
if (payee.value !== usdc(85)) {
  throw new Error('Safe execution produced an unexpected payee balance');
}
run.markStage('e2e.executed.complete', {
  status: 'verified',
  requestId: String(executed.id),
  budgetRaw: String(remainingBudget.value),
  payeeRaw: String(payee.value),
});

console.log('[C] request 500 → blocked with private budget reason');
const blocked = await requestAndFinalize({
  key: 'blocked',
  amount: 500,
  memo: '0xc1',
  expectedDecision: 3,
});
const blockedRequest = await getRequest(blocked.id);
if (Number(blockedRequest[5]) !== 4) {
  throw new Error(`blocked scenario expected Blocked(4), got ${blockedRequest[5]}`);
}
const blockedReason = await decryptHandle(
  'E2E blocked reason decrypt',
  delegateClient,
  blockedRequest[8] as `0x${string}`,
);
const postBlockedBudget = await decryptBudget(mandateId);
if (blockedReason.value !== 1n || postBlockedBudget.value !== usdc(15)) {
  throw new Error('blocked request reason or encrypted budget is incorrect');
}
run.markStage('e2e.blocked.complete', {
  status: 'verified',
  requestId: String(blocked.id),
  reason: String(blockedReason.value),
  budgetRaw: String(postBlockedBudget.value),
});

console.log('[D] create and validate the selective-disclosure Audit Packet');
const requestIds = [
  smokeRequestId,
  cancelled.id,
  executed.id,
  blocked.id,
] as const;
const existingPacketId = run.value<string>('e2e.packetId');
if (existingPacketId && !run.stage('e2e.audit.packet')?.hash) {
  throw new Error(
    'Audit Packet ID exists without its tracked transaction hash; '
    + 'refusing a possible duplicate packet',
  );
}
const { receipt: packetReceipt } = await run.transaction({
  key: 'e2e.audit.packet',
  label: 'createAuditPacket',
  broadcast: () =>
    sendSimulated('E2E exact createAuditPacket', admin, {
      address: VeilGuardModule,
      abi: moduleAbi,
      functionName: 'createAuditPacket',
      args: [auditor.account.address, mandateId, requestIds],
    }),
});
const packetEvent = requireSingleModuleEvent({
  abi: moduleAbi,
  module: VeilGuardModule,
  receipt: packetReceipt,
  eventName: 'AuditPacketCreated',
  label: 'E2E createAuditPacket',
});
const packetId = BigInt(packetEvent.args.packetId);
if (existingPacketId && BigInt(existingPacketId) !== packetId) {
  throw new Error('Audit Packet checkpoint ID does not match its receipt');
}
run.setValue('e2e.packetId', String(packetId));
const [packet, mandate] = await Promise.all([
  publicClient.readContract({
    address: VeilGuardModule,
    abi: moduleAbi,
    functionName: 'getAuditPacket',
    args: [packetId],
  }) as Promise<any[]>,
  getMandate(mandateId),
]);
const validatedPacket = assertAuditPacketBinding({
  module: VeilGuardModule,
  event: packetEvent,
  packet,
  auditor: auditor.account.address,
  mandateId,
  policyVersion: Number(mandate[3]),
  requestIds,
  expectedSnapshotCount: 11,
});

const expectedSnapshots = [
  { label: 'policy.autoLimit', raw: usdc(40) },
  { label: 'policy.budgetLeft', raw: usdc(15) },
  { label: 'policy.reserveFloor', raw: usdc(500) },
  { label: `request#${smokeRequestId}.amount`, raw: usdc(25) },
  { label: `request#${smokeRequestId}.blockedReason`, raw: 0n },
  { label: `request#${cancelled.id}.amount`, raw: usdc(60) },
  { label: `request#${cancelled.id}.blockedReason`, raw: 0n },
  { label: `request#${executed.id}.amount`, raw: usdc(60) },
  { label: `request#${executed.id}.blockedReason`, raw: 0n },
  { label: `request#${blocked.id}.amount`, raw: usdc(500) },
  { label: `request#${blocked.id}.blockedReason`, raw: 1n },
] as const;
const snapshotResolution = await waitForHandlesResolved(
  GATEWAY_STATUS,
  validatedPacket.snapshots,
);
const snapshotValues: bigint[] = [];
let maxResolvedToUsableMs = 0;
for (const snapshot of validatedPacket.snapshots) {
  let usability: NoxUsabilityTiming | undefined;
  const decrypted = await retryNoxRead(
    'E2E auditor snapshot decrypt',
    () => auditorClient.decrypt(snapshot as `0x${string}`),
    {
      resolvedAt: snapshotResolution.resolvedAt,
      onUsable: (timing) => {
        usability = timing;
      },
    },
  );
  snapshotValues.push(BigInt((decrypted as { value: bigint }).value));
  maxResolvedToUsableMs = Math.max(
    maxResolvedToUsableMs,
    usability?.resolvedToUsableMs ?? 0,
  );
}
const snapshotMismatches = expectedSnapshots.flatMap(
  ({ label, raw }, index) =>
    snapshotValues[index] === raw
      ? []
      : [`${label}: expected ${raw}, got ${snapshotValues[index]}`],
);
if (
  snapshotValues.length !== expectedSnapshots.length
  || snapshotMismatches.length > 0
) {
  throw new Error(
    `Audit Packet decrypted snapshot mismatch: ${snapshotMismatches.join('; ')}`,
  );
}

run.markStage('e2e.complete', {
  status: 'verified',
  mandateId: String(mandateId),
  requestIds: requestIds.map(String),
  packetId: String(packetId),
  manifestHash: validatedPacket.manifestHash,
  snapshotCount: snapshotValues.length,
  resolvedToUsableMs: maxResolvedToUsableMs,
});

console.log('\n✅ E2E complete — all states, recovery and Audit Packet bindings verified.');
process.exit(0);
