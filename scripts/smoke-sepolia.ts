/**
 * Sepolia smoke test — one recoverable pass over a freshly deployed VeilGuard.
 *
 * Every broadcast hash is persisted before receipt polling. On restart the
 * script follows the same hash and event-derived object ID; it never derives an
 * ID from `next*Id - 1` and never creates a replacement object for an
 * incomplete checkpoint.
 *
 * Run: npx hardhat run scripts/smoke-sepolia.ts --network sepolia
 */
import { network } from 'hardhat';
import { readFileSync } from 'node:fs';
import {
  createWalletClient,
  encodeFunctionData,
  http,
  padHex,
  zeroHash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';
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
const { TestUSDC, ConfidentialUSDC, Safe, VeilGuardModule } = deployments.contracts;
const GATEWAY = 'https://gateway-testnets.noxprotocol.dev';
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
const safeKeys = {
  ownerAKey: env('DEMO_ADMIN_KEY')!,
  ownerBKey: env('DEMO_SIGNER_B_KEY')!,
};
const clientFor = async (w: any) =>
  await createViemHandleClient({ ...w, getAddresses: async () => [w.account.address] });

const erc20Abi = [
  { type: 'function', name: 'faucet', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const wrapperAbi = [
  { type: 'function', name: 'wrap', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'confidentialBalanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bytes32' }] },
] as const;
const moduleAbi = JSON.parse(
  readFileSync(
    new URL('../artifacts/contracts/VeilGuardModule.sol/VeilGuardModule.json', import.meta.url),
    'utf8',
  ),
).abi;

const run = createFreshRunController({
  publicClient,
  chainId: sepolia.id,
  module: VeilGuardModule,
  safe: Safe,
  path: checkpointPath(env('FRESH_RUN_CHECKPOINT_PATH')),
});

const waitResolved = (handles: readonly string[]) =>
  waitForHandlesResolved(`${GATEWAY}/v0/public/handles/status`, handles);

const sendSimulated = async (label: string, w: any, request: any) => {
  const gas = await waitUntilSimulatable(
    label,
    () => publicClient.estimateContractGas({ ...request, account: w.account }),
  );
  return w.writeContract({ ...request, gas: gas * 12n / 10n });
};

const getMandate = async (id: bigint) =>
  (await publicClient.readContract({
    address: VeilGuardModule,
    abi: moduleAbi,
    functionName: 'getMandate',
    args: [id],
  })) as any[];
const getRequest = async (id: bigint) =>
  (await publicClient.readContract({
    address: VeilGuardModule,
    abi: moduleAbi,
    functionName: 'getRequest',
    args: [id],
  })) as any[];

console.log('— VeilGuard Sepolia recoverable smoke —');

// A missing checkpoint is safe only at the exact untouched Fresh boundary.
if (!run.stage('smoke.preflight')) {
  const [
    nextMandateId,
    nextRequestId,
    nextPacketId,
    adminTokenBalance,
    wrapperAllowance,
    initialTreasuryHandle,
  ] = await Promise.all([
    publicClient.readContract({
      address: VeilGuardModule, abi: moduleAbi, functionName: 'nextMandateId',
    }),
    publicClient.readContract({
      address: VeilGuardModule, abi: moduleAbi, functionName: 'nextRequestId',
    }),
    publicClient.readContract({
      address: VeilGuardModule, abi: moduleAbi, functionName: 'nextPacketId',
    }),
    publicClient.readContract({
      address: TestUSDC, abi: erc20Abi, functionName: 'balanceOf', args: [admin.account.address],
    }),
    publicClient.readContract({
      address: TestUSDC,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [admin.account.address, ConfidentialUSDC],
    }),
    publicClient.readContract({
      address: ConfidentialUSDC,
      abi: wrapperAbi,
      functionName: 'confidentialBalanceOf',
      args: [Safe],
    }),
  ]);
  if (
    nextMandateId !== 1n
    || nextRequestId !== 1n
    || nextPacketId !== 1n
    || adminTokenBalance !== 0n
    || wrapperAllowance !== 0n
    || initialTreasuryHandle !== zeroHash
  ) {
    throw new Error(
      'Fresh smoke checkpoint is missing but on-chain setup is not untouched; '
      + 'refusing to replay funding or create replacement objects',
    );
  }
  run.markStage('smoke.preflight', {
    status: 'verified',
    nextMandateId: '1',
    nextRequestId: '1',
    nextPacketId: '1',
  });
}

console.log('[1] fund treasury with 1000 cUSDC');
await run.transaction({
  key: 'smoke.faucet',
  label: 'faucet',
  broadcast: () => admin.writeContract({
    address: TestUSDC,
    abi: erc20Abi,
    functionName: 'faucet',
    args: [usdc(1000)],
  }),
});
await run.transaction({
  key: 'smoke.approve',
  label: 'approve',
  broadcast: () => admin.writeContract({
    address: TestUSDC,
    abi: erc20Abi,
    functionName: 'approve',
    args: [ConfidentialUSDC, usdc(1000)],
  }),
});
await run.transaction({
  key: 'smoke.wrap',
  label: 'wrap→Safe',
  broadcast: () => admin.writeContract({
    address: ConfidentialUSDC,
    abi: wrapperAbi,
    functionName: 'wrap',
    args: [Safe, usdc(1000)],
  }),
});
const treasuryHandle = await publicClient.readContract({
  address: ConfidentialUSDC,
  abi: wrapperAbi,
  functionName: 'confidentialBalanceOf',
  args: [Safe],
}) as `0x${string}`;
if (treasuryHandle === zeroHash) throw new Error('treasury handle is still uninitialized');
const treasuryResolution = await waitResolved([treasuryHandle]);
console.log(`  treasury handle resolved in ${(treasuryResolution.elapsedMs / 1000).toFixed(1)}s`);

console.log('[2] propose + activate encrypted mandate');
let mandateId = BigInt(run.value<string>('smoke.mandateId') ?? '0');
if (mandateId === 0n) {
  const { receipt } = await run.transaction({
    key: 'smoke.propose',
    label: 'proposeMandate',
    broadcast: async () => {
      const adminClient = await clientFor(admin);
      const [limit, budget, floor] = await Promise.all([
        adminClient.encryptInput(usdc(40), 'uint256', VeilGuardModule),
        adminClient.encryptInput(usdc(100), 'uint256', VeilGuardModule),
        adminClient.encryptInput(usdc(500), 'uint256', VeilGuardModule),
      ]);
      const now = BigInt(Math.floor(Date.now() / 1000));
      return sendSimulated('proposeMandate input propagation', admin, {
        address: VeilGuardModule,
        abi: moduleAbi,
        functionName: 'proposeMandate',
        args: [
          delegate.account.address,
          0n,
          now + 86_400n * 30n,
          [deployer.account.address],
          limit.handle,
          limit.handleProof,
          budget.handle,
          budget.handleProof,
          floor.handle,
          floor.handleProof,
        ],
      });
    },
  });
  const event = requireSingleModuleEvent({
    abi: moduleAbi,
    module: VeilGuardModule,
    receipt,
    eventName: 'MandateProposed',
    label: 'smoke proposeMandate',
  });
  mandateId = BigInt(event.args.mandateId);
  if (mandateId <= 0n) throw new Error('MandateProposed emitted an invalid ID');
  if (
    String(event.args.delegate).toLowerCase() !== delegate.account.address.toLowerCase()
  ) {
    throw new Error('MandateProposed delegate does not match the Fresh role');
  }
  run.setValue('smoke.mandateId', String(mandateId));
}

await run.safeAction({
  key: 'smoke.activate',
  label: `activate mandate #${mandateId}`,
  isComplete: async () => Number((await getMandate(mandateId))[4]) === 2,
  execute: (onBroadcast) =>
    safeExec2of2(
      Safe,
      VeilGuardModule,
      encodeFunctionData({
        abi: moduleAbi,
        functionName: 'activateMandate',
        args: [mandateId],
      }),
      safeKeys,
      console.log,
      onBroadcast,
    ),
});

console.log('[3] delegate requests 25 cUSDC (within mandate)');
let requestId = BigInt(run.value<string>('smoke.requestId') ?? '0');
if (requestId === 0n) {
  const { receipt } = await run.transaction({
    key: 'smoke.request',
    label: 'requestSpend 25',
    broadcast: async () => {
      const delegateClient = await clientFor(delegate);
      const amount = await delegateClient.encryptInput(
        usdc(25),
        'uint256',
        VeilGuardModule,
      );
      return sendSimulated('requestSpend 25 input propagation', delegate, {
        address: VeilGuardModule,
        abi: moduleAbi,
        functionName: 'requestSpend',
        args: [
          mandateId,
          deployer.account.address,
          amount.handle,
          amount.handleProof,
          padHex('0x01', { size: 32 }),
        ],
      });
    },
  });
  const event = requireSingleModuleEvent({
    abi: moduleAbi,
    module: VeilGuardModule,
    receipt,
    eventName: 'SpendRequested',
    label: 'smoke requestSpend',
  });
  requestId = BigInt(event.args.requestId);
  if (
    requestId <= 0n
    || BigInt(event.args.mandateId) !== mandateId
    || String(event.args.delegate).toLowerCase() !== delegate.account.address.toLowerCase()
    || String(event.args.recipient).toLowerCase() !== deployer.account.address.toLowerCase()
  ) {
    throw new Error('SpendRequested event does not bind the Fresh smoke request');
  }
  run.setValue('smoke.requestId', String(requestId));
}

let request = await getRequest(requestId);
if (
  BigInt(request[0]) !== mandateId
  || String(request[1]).toLowerCase() !== delegate.account.address.toLowerCase()
  || String(request[2]).toLowerCase() !== deployer.account.address.toLowerCase()
) {
  throw new Error('stored Fresh smoke request does not match its checkpoint');
}
const finalizeStage = run.stage('smoke.finalize');
if (Number(request[5]) === 1) {
  const decisionHandle = request[7] as `0x${string}`;
  const resolved = await waitResolved([decisionHandle]);
  const delegateClient = await clientFor(delegate);
  let usability: NoxUsabilityTiming | undefined;
  const { value: decision, decryptionProof } = await retryNoxRead(
    'smoke decision public decrypt',
    () => delegateClient.publicDecrypt(decisionHandle),
    {
      resolvedAt: resolved.resolvedAt,
      onUsable: (timing) => { usability = timing; },
    },
  );
  run.markStage('smoke.decision', {
    status: 'verified',
    resolvedMs: resolved.elapsedMs,
    resolvedToUsableMs: usability?.resolvedToUsableMs ?? 0,
    decision: String(decision),
  });
  if (Number(decision) !== 1) throw new Error(`expected EXECUTE, got ${decision}`);
  await run.transaction({
    key: 'smoke.finalize',
    label: 'finalize request',
    broadcast: () => sendSimulated('smoke exact finalize proof', deployer, {
      address: VeilGuardModule,
      abi: moduleAbi,
      functionName: 'finalize',
      args: [requestId, decryptionProof],
    }),
  });
  request = await getRequest(requestId);
} else {
  if (!finalizeStage?.hash) {
    throw new Error(
      'Fresh smoke request advanced without its finalize transaction hash; '
      + 'refusing unbound recovery',
    );
  }
  await run.transaction({
    key: 'smoke.finalize',
    label: 'recover smoke finalize',
    broadcast: async () => {
      throw new Error('checkpoint recovery must never rebroadcast finalize');
    },
  });
  request = await getRequest(requestId);
}
if (Number(request[5]) !== 2) {
  throw new Error(`Fresh smoke request expected Executed(2), got ${request[5]}`);
}

// Once E2E has executed its later payment, the aggregate payee balance is no
// longer the historical Smoke value. The Smoke request binding and terminal
// state above are still revalidated, but preserve the original checkpoint
// evidence instead of comparing a downstream balance to an earlier boundary.
const downstreamExecution = run.stage('e2e.executed.safe');
const downstreamE2eAdvanced = Boolean(
  downstreamExecution?.hash
  && ['success', 'verified'].includes(String(downstreamExecution.status)),
);
if (downstreamE2eAdvanced) {
  console.log('[4] downstream E2E payment already advanced the aggregate payee balance');
} else {
  console.log('[4] payee decrypts received amount');
  const payeeBalanceHandle = await publicClient.readContract({
    address: ConfidentialUSDC,
    abi: wrapperAbi,
    functionName: 'confidentialBalanceOf',
    args: [deployer.account.address],
  }) as `0x${string}`;
  const payeeResolution = await waitResolved([payeeBalanceHandle]);
  const payeeClient = await clientFor(deployer);
  let payeeUsability: NoxUsabilityTiming | undefined;
  const { value: received } = await retryNoxRead(
    'smoke payee balance decrypt',
    () => payeeClient.decrypt(payeeBalanceHandle),
    {
      resolvedAt: payeeResolution.resolvedAt,
      onUsable: (timing) => { payeeUsability = timing; },
    },
  );
  if (BigInt(received) !== usdc(25)) throw new Error('unexpected payee balance');
  run.markStage('smoke.complete', {
    status: 'verified',
    mandateId: String(mandateId),
    requestId: String(requestId),
    payeeBalanceRaw: String(received),
    payeeResolvedToUsableMs: payeeUsability?.resolvedToUsableMs ?? 0,
  });
}

console.log(
  downstreamE2eAdvanced
    ? '\n✅ Sepolia smoke recovery complete — no Smoke transaction was rebroadcast.'
    : '\n✅ Sepolia smoke complete — checkpointed confidential loop live on-chain.',
);
console.log(`   mandate #${mandateId}; request #${requestId}: EXECUTE, 25 cUSDC`);
process.exit(0);
