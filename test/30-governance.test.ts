import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import { encodeFunctionData, zeroAddress } from 'viem';
import { nox } from '@iexec-nox/nox-hardhat-plugin';
import { clientFor, publicDecryptWithRetry, usdc } from './helpers.js';

/**
 * Governance & invariant tests for the hardening added after external review:
 *  - contract-enforced single active mandate per delegate (activeMandateOf)
 *  - auto-retire on activation; refuse replacement while a request is pending
 *  - requestSpend must target the delegate's current active mandate
 *  - Safe-only finance-admin rotation
 *  - proposeMandate input validation (zero address / window / recipients)
 *  - audit packet: terminal-state requests only, requestIds stored
 *  - EXECUTE pays out the reserved handle
 */
describe('30 governance & invariants', { timeout: 1_800_000 }, () => {
  let viem: any, wallets: any[];
  let admin: any, owner2: any, delegate: any, recipient: any, auditor: any;
  let token: any, safe: any, module: any, moduleAsDelegate: any;
  const ZERO32 = ('0x' + '00'.repeat(32)) as `0x${string}`;

  const safeCall = (fn: string, args: unknown[]) =>
    safe.write.execTransaction([module.address, 0n, encodeFunctionData({ abi: module.abi, functionName: fn, args })]);

  const enc = async (v: bigint) => nox.encryptInput(v, 'uint256', module.address);
  const proposeFor = async (del: `0x${string}`, recips: `0x${string}`[], budget = 100) => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const [l, b, f] = await Promise.all([enc(usdc(40)), enc(usdc(budget)), enc(usdc(500))]);
    await module.write.proposeMandate([del, 0n, now + 86_400n * 30n, recips,
      l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof]);
    return ((await module.read.nextMandateId()) as bigint) - 1n;
  };

  before(async () => {
    const conn = await nox.connect();
    viem = conn.viem;
    wallets = await viem.getWalletClients();
    [admin, owner2, delegate, recipient, auditor] = wallets;
    token = await viem.deployContract('ConfidentialUSDC');
    safe = await viem.deployContract('MinimalSafe', [[admin.account.address, owner2.account.address]]);
    module = await viem.deployContract('VeilGuardModule', [safe.address, token.address, admin.account.address]);
    await safe.write.enableModule([module.address]);
    const { handle, handleProof } = await nox.encryptInput(usdc(1000), 'uint256', token.address);
    await token.write.mint([safe.address, handle, handleProof]);
    moduleAsDelegate = await viem.getContractAt('VeilGuardModule', module.address, { client: { wallet: delegate } });
  });

  it('proposeMandate rejects a zero delegate', async () => {
    const [l, b, f] = await Promise.all([enc(usdc(40)), enc(usdc(100)), enc(usdc(500))]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    await assert.rejects(module.write.proposeMandate([zeroAddress, 0n, now + 86_400n, [recipient.account.address],
      l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof]));
  });

  it('proposeMandate rejects an empty recipient list', async () => {
    const [l, b, f] = await Promise.all([enc(usdc(40)), enc(usdc(100)), enc(usdc(500))]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    await assert.rejects(module.write.proposeMandate([delegate.account.address, 0n, now + 86_400n, [],
      l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof]));
  });

  it('proposeMandate rejects a validUntil in the past', async () => {
    const [l, b, f] = await Promise.all([enc(usdc(40)), enc(usdc(100)), enc(usdc(500))]);
    await assert.rejects(module.write.proposeMandate([delegate.account.address, 0n, 1n, [recipient.account.address],
      l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof]));
  });

  it('only the Safe can rotate the finance admin', async () => {
    await assert.rejects(module.write.setFinanceAdmin([owner2.account.address])); // direct → NotSafe
    await safeCall('setFinanceAdmin', [owner2.account.address]);
    assert.equal((await module.read.financeAdmin()).toLowerCase(), owner2.account.address.toLowerCase());
    await safeCall('setFinanceAdmin', [admin.account.address]); // restore
  });

  it('activation enforces a single active mandate per delegate (auto-retire)', async () => {
    const m1 = await proposeFor(delegate.account.address, [recipient.account.address]);
    await safeCall('activateMandate', [m1]);
    assert.equal(await module.read.activeMandateOf([delegate.account.address]), m1);

    const m2 = await proposeFor(delegate.account.address, [recipient.account.address]);
    await safeCall('activateMandate', [m2]);
    // old one auto-retired, new one active
    assert.equal((await module.read.getMandate([m1]))[4], 3); // Retired
    assert.equal((await module.read.getMandate([m2]))[4], 2); // Active
    assert.equal(await module.read.activeMandateOf([delegate.account.address]), m2);

    // requestSpend against the retired mandate must revert (NotActiveMandate/BadState)
    const amt = await (await clientFor(delegate)).encryptInput(usdc(10), 'uint256', module.address);
    await assert.rejects(moduleAsDelegate.write.requestSpend([m1, recipient.account.address, amt.handle, amt.handleProof, ZERO32]));
  });

  it('cannot replace an active mandate that still has a pending request', async () => {
    const active = (await module.read.activeMandateOf([delegate.account.address])) as bigint;
    const amt = await (await clientFor(delegate)).encryptInput(usdc(10), 'uint256', module.address);
    await moduleAsDelegate.write.requestSpend([active, recipient.account.address, amt.handle, amt.handleProof, ZERO32]);
    // now a pending request occupies the slot; activating a new mandate must revert
    const m3 = await proposeFor(delegate.account.address, [recipient.account.address]);
    await assert.rejects(safeCall('activateMandate', [m3]));
    // finalize to clear the slot
    const req = ((await module.read.nextRequestId()) as bigint) - 1n;
    const r = await module.read.getRequest([req]);
    const { decryptionProof } = await publicDecryptWithRetry(r[7]);
    await module.write.finalize([req, decryptionProof]);
    // now activation succeeds
    await safeCall('activateMandate', [m3]);
    assert.equal(await module.read.activeMandateOf([delegate.account.address]), m3);
  });

  it('audit packet rejects a non-terminal (still-pending) request', async () => {
    const active = (await module.read.activeMandateOf([delegate.account.address])) as bigint;
    const amt = await (await clientFor(delegate)).encryptInput(usdc(5), 'uint256', module.address);
    await moduleAsDelegate.write.requestSpend([active, recipient.account.address, amt.handle, amt.handleProof, ZERO32]);
    const pendingId = ((await module.read.nextRequestId()) as bigint) - 1n;
    await assert.rejects(module.write.createAuditPacket([auditor.account.address, active, [pendingId]]));
    // finalize, then the packet succeeds and stores the requestId
    const r = await module.read.getRequest([pendingId]);
    const { decryptionProof } = await publicDecryptWithRetry(r[7]);
    await module.write.finalize([pendingId, decryptionProof]);
    await module.write.createAuditPacket([auditor.account.address, active, [pendingId]]);
    const packetId = ((await module.read.nextPacketId()) as bigint) - 1n;
    const p = await module.read.getAuditPacket([packetId]);
    assert.deepEqual((p[5] as bigint[]).map(Number), [Number(pendingId)]); // requestIds stored
    // policy(3) + amount+reason(2) = 5 snapshot handles
    assert.equal((p[6] as string[]).length, 5);
  });
});
