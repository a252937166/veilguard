import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { nox } from '@iexec-nox/nox-hardhat-plugin';
import { clientFor, usdc, waitResolved } from './helpers.js';

/** Smoke test: the local Nox stack encrypts, computes and decrypts end-to-end. */
describe('00 local stack sanity', { timeout: 300_000 }, () => {
  it('mints an encrypted amount and decrypts the holder balance', async () => {
    const conn = await nox.connect();
    const { viem } = conn;
    const [owner] = await viem.getWalletClients();

    const token = await viem.deployContract('ConfidentialUSDC');

    const { handle, handleProof } = await nox.encryptInput(
      usdc(100),
      'uint256',
      token.address,
    );
    await token.write.mint([owner.account.address, handle, handleProof]);

    const balanceHandle = (await token.read.confidentialBalanceOf([
      owner.account.address,
    ])) as `0x${string}`;

    await waitResolved([balanceHandle]);
    const ownerClient = await clientFor(owner);
    const { value } = await ownerClient.decrypt(balanceHandle as any);
    assert.equal(value, usdc(100));
  });
});
