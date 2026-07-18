import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import { encodeFunctionData } from 'viem';
import { nox } from '@iexec-nox/nox-hardhat-plugin';
import { clientFor, waitResolved, usdc, NOX_COMPUTE_ADDRESS } from './helpers.js';

const aclViewAbi = [
  {
    type: 'function',
    name: 'isAllowed',
    stateMutability: 'view',
    inputs: [
      { name: 'handle', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isViewer',
    stateMutability: 'view',
    inputs: [
      { name: 'handle', type: 'bytes32' },
      { name: 'viewer', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/**
 * Gate 3 — audit snapshots are scoped immutable disclosure:
 *  - the auditor can decrypt every snapshot handle in the packet;
 *  - the auditor is a viewer, NOT an admin (cannot compute on the handles);
 *  - the auditor cannot decrypt the live policy state;
 *  - a later policy version is invisible to the packet holder.
 */
describe('20 audit packet isolation (gate G3)', { timeout: 1_200_000 }, () => {
  let viem: any;
  let admin: any, owner2: any, delegate: any, recipient: any, auditor: any;
  let token: any, safe: any, module: any;
  let publicClient: any;

  before(async () => {
    const conn = await nox.connect();
    viem = conn.viem;
    const wallets = await viem.getWalletClients();
    [admin, owner2, delegate, recipient, auditor] = wallets;
    publicClient = await viem.getPublicClient();

    token = await viem.deployContract('ConfidentialUSDC');
    safe = await viem.deployContract('MinimalSafe', [
      [admin.account.address, owner2.account.address],
    ]);
    module = await viem.deployContract('VeilGuardModule', [
      safe.address,
      token.address,
      admin.account.address,
    ]);
    await safe.write.enableModule([module.address]);

    const { handle, handleProof } = await nox.encryptInput(usdc(1000), 'uint256', token.address);
    await token.write.mint([safe.address, handle, handleProof]);

    const enc = async (v: bigint) => nox.encryptInput(v, 'uint256', module.address);
    const [limit, budget, floor] = await Promise.all([
      enc(usdc(40)),
      enc(usdc(100)),
      enc(usdc(500)),
    ]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    await module.write.proposeMandate([
      delegate.account.address,
      0n,
      now + 86_400n * 30n,
      [recipient.account.address],
      limit.handle,
      limit.handleProof,
      budget.handle,
      budget.handleProof,
      floor.handle,
      floor.handleProof,
    ]);
    await safe.write.execTransaction([
      module.address,
      0n,
      encodeFunctionData({ abi: module.abi, functionName: 'activateMandate', args: [1n, 0n] }),
    ]);
  });

  it('auditor decrypts packet snapshots but neither computes on them nor sees live state', async () => {
    await module.write.createAuditPacket([auditor.account.address, 1n, []]);
    const packet = await module.read.getAuditPacket([1n]);
    const snapshots: `0x${string}`[] = packet[5];
    assert.equal(snapshots.length, 3); // autoLimit, budgetLeft, reserveFloor

    await waitResolved(snapshots);
    const auditorClient = await clientFor(auditor);
    assert.equal((await auditorClient.decrypt(snapshots[0] as any)).value, usdc(40));
    assert.equal((await auditorClient.decrypt(snapshots[1] as any)).value, usdc(100));
    assert.equal((await auditorClient.decrypt(snapshots[2] as any)).value, usdc(500));

    // Viewer, not admin: decrypt-only on-chain permissions.
    for (const snap of snapshots) {
      assert.equal(
        await publicClient.readContract({
          address: NOX_COMPUTE_ADDRESS,
          abi: aclViewAbi,
          functionName: 'isViewer',
          args: [snap, auditor.account.address],
        }),
        true,
      );
      assert.equal(
        await publicClient.readContract({
          address: NOX_COMPUTE_ADDRESS,
          abi: aclViewAbi,
          functionName: 'isAllowed',
          args: [snap, auditor.account.address],
        }),
        false,
      );
    }

    // The live policy handle is NOT decryptable by the auditor.
    const m = await module.read.getMandate([1n]);
    await assert.rejects(auditorClient.decrypt(m[6] as any));
  });

  it('a later policy version stays invisible to the earlier packet holder', async () => {
    const enc = async (v: bigint) => nox.encryptInput(v, 'uint256', module.address);
    const [limit2, budget2, floor2] = await Promise.all([
      enc(usdc(70)),
      enc(usdc(300)),
      enc(usdc(400)),
    ]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    await module.write.proposeMandate([
      delegate.account.address,
      0n,
      now + 86_400n * 30n,
      [recipient.account.address],
      limit2.handle,
      limit2.handleProof,
      budget2.handle,
      budget2.handleProof,
      floor2.handle,
      floor2.handleProof,
    ]);

    const m2 = await module.read.getMandate([2n]);
    const auditorClient = await clientFor(auditor);
    // v2 draft numbers: no viewer grant for the packet-1 auditor.
    await assert.rejects(auditorClient.decrypt(m2[5] as any));

    // But Safe owners can review the draft (governance viewers).
    await waitResolved([m2[5]]);
    const owner2Client = await clientFor(owner2);
    assert.equal((await owner2Client.decrypt(m2[5] as any)).value, usdc(70));
  });
});
