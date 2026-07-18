import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import { encodeFunctionData } from 'viem';
import { nox } from '@iexec-nox/nox-hardhat-plugin';
import {
  clientFor,
  publicDecryptWithRetry,
  waitResolved,
  usdc,
  D_EXECUTE,
  D_ESCALATE,
  D_BLOCKED,
  R_BUDGET,
  R_RESERVE,
  NOX_COMPUTE_ADDRESS,
} from './helpers.js';

/**
 * Full VeilGuard lifecycle on the local Nox stack. This suite doubles as the
 * design's Go/No-Go gates:
 *  - Gate 1 (Safe lends the module transient access to its real balance handle)
 *    and Gate 2 (Safe-native confidential transfer incl. the encrypted-zero
 *    path) are exercised by every requestSpend below;
 *  - the three-state outcome, escalation, cancellation and budget restore
 *    complete the core product loop.
 */
describe('10 VeilGuard flows (gates G1+G2 + lifecycle)', { timeout: 1_800_000 }, () => {
  let conn: Awaited<ReturnType<typeof nox.connect>>;
  let viem: any;
  let wallets: any[];
  let admin: any, owner2: any, delegate: any, recipient: any, auditor: any, delegate2: any;
  let token: any, safe: any, module: any;
  let moduleAsDelegate: any, moduleAsDelegate2: any;
  let requestA: bigint, requestB: bigint, requestC: bigint;

  const safeExec = async (to: `0x${string}`, data: `0x${string}`) =>
    safe.write.execTransaction([to, 0n, data]);

  const moduleCall = (fn: string, args: unknown[]) =>
    encodeFunctionData({ abi: module.abi, functionName: fn, args });

  const decryptAs = async (wallet: any, handle: string) => {
    await waitResolved([handle]);
    const client = await clientFor(wallet);
    return (await client.decrypt(handle as any)).value;
  };

  before(async () => {
    conn = await nox.connect();
    viem = conn.viem;
    wallets = await viem.getWalletClients();
    [admin, owner2, delegate, recipient, auditor, delegate2] = wallets;

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

    // Fund the Safe treasury with 1000 cUSDC (encrypted mint).
    const { handle, handleProof } = await nox.encryptInput(usdc(1000), 'uint256', token.address);
    await token.write.mint([safe.address, handle, handleProof]);

    moduleAsDelegate = await viem.getContractAt('VeilGuardModule', module.address, {
      client: { wallet: delegate },
    });
    moduleAsDelegate2 = await viem.getContractAt('VeilGuardModule', module.address, {
      client: { wallet: delegate2 },
    });
  });

  it('admin proposes an encrypted mandate; owners can review the draft numbers', async () => {
    const enc = async (v: bigint) => nox.encryptInput(v, 'uint256', module.address);
    const [limit, budget, floor] = await Promise.all([enc(usdc(40)), enc(usdc(100)), enc(usdc(500))]);

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

    const m = await module.read.getMandate([1n]);
    assert.equal(m[4], 1); // MandateState.Draft
    // Safe owner #2 (viewer on the draft) reads the proposed auto-limit.
    assert.equal(await decryptAs(owner2, m[5]), usdc(40));
  });

  it('only the Safe can activate the mandate', async () => {
    await assert.rejects(module.write.activateMandate([1n, 0n])); // admin direct → NotSafe
    await safeExec(module.address, moduleCall('activateMandate', [1n, 0n]));
    const m = await module.read.getMandate([1n]);
    assert.equal(m[4], 2); // MandateState.Active
  });

  it('flow A — within mandate: EXECUTE moves real funds to the recipient', async () => {
    const delegateClient = await clientFor(delegate);
    const { handle, handleProof } = await delegateClient.encryptInput(
      usdc(25),
      'uint256',
      module.address,
    );
    await moduleAsDelegate.write.requestSpend([
      1n,
      recipient.account.address,
      handle,
      handleProof,
      '0x' + '11'.repeat(32),
    ]);
    requestA = 1n;

    const r = await module.read.getRequest([requestA]);
    const { value: decision, decryptionProof } = await publicDecryptWithRetry(r[7]);
    assert.equal(Number(decision), D_EXECUTE);

    await module.write.finalize([requestA, decryptionProof]);
    assert.equal((await module.read.getRequest([requestA]))[5], 2); // Executed

    const recipientBalance = (await token.read.confidentialBalanceOf([
      recipient.account.address,
    ])) as `0x${string}`;
    assert.equal(await decryptAs(recipient, recipientBalance), usdc(25));

    // Admin (viewer) sees the private budget shrink to 75.
    const m = await module.read.getMandate([1n]);
    assert.equal(await decryptAs(admin, m[6]), usdc(75));
  });

  it('flow B — above the auto-limit: ESCALATE requires the Safe multisig', async () => {
    const delegateClient = await clientFor(delegate);
    const { handle, handleProof } = await delegateClient.encryptInput(
      usdc(60),
      'uint256',
      module.address,
    );
    await moduleAsDelegate.write.requestSpend([
      1n,
      recipient.account.address,
      handle,
      handleProof,
      '0x' + '22'.repeat(32),
    ]);
    requestB = 2n;

    const r = await module.read.getRequest([requestB]);
    const { value: decision, decryptionProof } = await publicDecryptWithRetry(r[7]);
    assert.equal(Number(decision), D_ESCALATE);

    await module.write.finalize([requestB, decryptionProof]);
    assert.equal((await module.read.getRequest([requestB]))[5], 3); // AwaitingSafeApproval

    // Safe owner #2 can now see the escalated amount in the VeilGuard view…
    const rAfter = await module.read.getRequest([requestB]);
    assert.equal(await decryptAs(owner2, rAfter[6]), usdc(60));

    // …and executes through the Safe (stand-in for the collected multisig).
    await safeExec(module.address, moduleCall('executeEscalated', [requestB]));
    assert.equal((await module.read.getRequest([requestB]))[5], 2); // Executed

    const recipientBalance = (await token.read.confidentialBalanceOf([
      recipient.account.address,
    ])) as `0x${string}`;
    assert.equal(await decryptAs(recipient, recipientBalance), usdc(85));
  });

  it('flow C — over budget: BLOCKED, nothing moves, budget unchanged, cooldown set', async () => {
    const delegateClient = await clientFor(delegate);
    const { handle, handleProof } = await delegateClient.encryptInput(
      usdc(500),
      'uint256',
      module.address,
    );
    await moduleAsDelegate.write.requestSpend([
      1n,
      recipient.account.address,
      handle,
      handleProof,
      '0x' + '33'.repeat(32),
    ]);
    requestC = 3n;

    const r = await module.read.getRequest([requestC]);
    const { value: decision, decryptionProof } = await publicDecryptWithRetry(r[7]);
    assert.equal(Number(decision), D_BLOCKED);

    await module.write.finalize([requestC, decryptionProof]);
    assert.equal((await module.read.getRequest([requestC]))[5], 4); // Blocked

    // Coarse reason is private: the delegate sees BUDGET, the public does not.
    const rAfter = await module.read.getRequest([requestC]);
    assert.equal(Number(await decryptAs(delegate, rAfter[8])), R_BUDGET);

    // Budget is unchanged (15 after A+B) and the recipient got nothing new.
    const m = await module.read.getMandate([1n]);
    assert.equal(await decryptAs(admin, m[6]), usdc(15));
    const recipientBalance = (await token.read.confidentialBalanceOf([
      recipient.account.address,
    ])) as `0x${string}`;
    assert.equal(await decryptAs(recipient, recipientBalance), usdc(85));

    // Cooldown: an immediate follow-up request reverts.
    const again = await delegateClient.encryptInput(usdc(1), 'uint256', module.address);
    await assert.rejects(
      moduleAsDelegate.write.requestSpend([
        1n,
        recipient.account.address,
        again.handle,
        again.handleProof,
        '0x' + '44'.repeat(32),
      ]),
    );
  });

  it('flow D — reserve floor blocks even when the budget allows', async () => {
    // Second mandate for delegate2 with a big budget: 450 would leave the
    // treasury (915) below the 500 floor -> BLOCKED with reason RESERVE.
    const enc = async (v: bigint) => nox.encryptInput(v, 'uint256', module.address);
    const [limit, budget, floor] = await Promise.all([enc(usdc(40)), enc(usdc(800)), enc(usdc(500))]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    await module.write.proposeMandate([
      delegate2.account.address,
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
    await safeExec(module.address, moduleCall('activateMandate', [2n, 0n]));

    const delegate2Client = await clientFor(delegate2);
    const { handle, handleProof } = await delegate2Client.encryptInput(
      usdc(450),
      'uint256',
      module.address,
    );
    await moduleAsDelegate2.write.requestSpend([
      2n,
      recipient.account.address,
      handle,
      handleProof,
      '0x' + '55'.repeat(32),
    ]);
    const requestD = 4n;

    const r = await module.read.getRequest([requestD]);
    const { value: decision, decryptionProof } = await publicDecryptWithRetry(r[7]);
    assert.equal(Number(decision), D_BLOCKED);
    await module.write.finalize([requestD, decryptionProof]);
    assert.equal(Number(await decryptAs(delegate2, (await module.read.getRequest([requestD]))[8])), R_RESERVE);
  });

  it('flow E — Safe cancels an escalated request: escrow refunded, budget restored', async () => {
    // Pass delegate2's cooldown from flow D.
    await conn.provider.request({ method: 'evm_increaseTime', params: ['0x259'] }); // 601s

    const delegate2Client = await clientFor(delegate2);
    const { handle, handleProof } = await delegate2Client.encryptInput(
      usdc(100),
      'uint256',
      module.address,
    );
    await moduleAsDelegate2.write.requestSpend([
      2n,
      recipient.account.address,
      handle,
      handleProof,
      '0x' + '66'.repeat(32),
    ]);
    const requestE = 5n;

    const r = await module.read.getRequest([requestE]);
    const { value: decision, decryptionProof } = await publicDecryptWithRetry(r[7]);
    assert.equal(Number(decision), D_ESCALATE); // 100 > 40 auto-limit

    await module.write.finalize([requestE, decryptionProof]);
    await safeExec(module.address, moduleCall('cancelEscalated', [requestE]));
    assert.equal((await module.read.getRequest([requestE]))[5], 5); // Cancelled

    // Budget restored to the full 800.
    const m = await module.read.getMandate([2n]);
    assert.equal(await decryptAs(admin, m[6]), usdc(800));

    // Treasury restored to 915: the Safe (holder-admin of its own balance
    // handle) grants the finance admin a viewer on it — Safe-driven disclosure.
    const treasuryHandle = (await token.read.confidentialBalanceOf([safe.address])) as `0x${string}`;
    await safeExec(
      NOX_COMPUTE_ADDRESS,
      encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'addViewer',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'handle', type: 'bytes32' },
              { name: 'viewer', type: 'address' },
            ],
            outputs: [],
          },
        ],
        functionName: 'addViewer',
        args: [treasuryHandle, admin.account.address],
      }),
    );
    assert.equal(await decryptAs(admin, treasuryHandle), usdc(915));
  });
});
