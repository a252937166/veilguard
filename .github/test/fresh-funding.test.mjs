import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { formatEther, parseEther } from 'viem';
import {
  ROLE_TARGET_CONFIG,
  createFundingPlan,
  fundRoleToTarget,
  parseFundingTarget,
  requiredTopUp,
  resolveRoleTargets,
} from '../../scripts/lib/fresh-funding.mjs';

const addresses = {
  admin: `0x${'1'.repeat(40)}`,
  signerB: `0x${'2'.repeat(40)}`,
  delegate: `0x${'3'.repeat(40)}`,
  auditor: `0x${'4'.repeat(40)}`,
};

test('Fresh funding helper remains calculation-only', async () => {
  const source = await readFile(
    new URL('../../scripts/lib/fresh-funding.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /writeContract|sendTransaction|safeExec2of2|createWalletClient|getWalletClient|privateKey/,
    'the whitelisted helper must not hide a wallet or governance write',
  );
});

test('Fresh target variables and dynamic gate are documented for operators', async () => {
  const [envExample, readme] = await Promise.all([
    readFile(new URL('../../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../../README.md', import.meta.url), 'utf8'),
  ]);
  for (const config of Object.values(ROLE_TARGET_CONFIG)) {
    assert.match(envExample, new RegExp(`${config.env}=${config.defaultEth.replace('.', '\\.')}`));
    assert.match(readme, new RegExp(config.env));
  }
  assert.match(readme, /target balances/);
  assert.match(readme, /dynamic\s+total plus a separate `0\.02 ETH` deployment-gas reserve/);
  assert.match(readme, /default gate is therefore `0\.055 ETH`/);
  assert.match(readme, /cannot lower its empirical default floor/);
});

test('Fresh roles have independent empirical floors and raise-only env overrides', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(ROLE_TARGET_CONFIG).map(([role, config]) => [role, config.defaultEth]),
    ),
    {
      admin: '0.012',
      signerB: '0.010',
      delegate: '0.012',
      auditor: '0.001',
    },
  );

  const defaults = resolveRoleTargets(() => undefined);
  assert.deepEqual(defaults, {
    admin: parseEther('0.012'),
    signerB: parseEther('0.010'),
    delegate: parseEther('0.012'),
    auditor: parseEther('0.001'),
  });

  for (const [role, config] of Object.entries(ROLE_TARGET_CONFIG)) {
    const override = '0.025';
    const resolved = resolveRoleTargets((name) => (
      name === config.env ? override : undefined
    ));
    assert.equal(resolved[role], parseEther(override), `${role} override was not applied`);
    for (const [otherRole, otherConfig] of Object.entries(ROLE_TARGET_CONFIG)) {
      if (otherRole !== role) {
        assert.equal(
          resolved[otherRole],
          parseEther(otherConfig.defaultEth),
          `${role} override changed ${otherRole}`,
        );
      }
    }

    const exactFloor = resolveRoleTargets((name) => (
      name === config.env ? config.defaultEth : undefined
    ));
    assert.equal(
      exactFloor[role],
      parseEther(config.defaultEth),
      `${role} must accept its empirical floor`,
    );

    const undercut = formatEther(parseEther(config.defaultEth) - 1n);
    assert.throws(
      () => resolveRoleTargets((name) => (
        name === config.env ? undercut : undefined
      )),
      new RegExp(`${config.env} cannot undercut the empirical .* ETH floor`),
      `${role} must reject a target below its empirical floor`,
    );
  }

  for (const invalid of ['', '-0.01', '1e-3', '0.0000000000000000001', 'not-eth']) {
    assert.throws(
      () => parseFundingTarget(invalid, 'FRESH_ADMIN_TARGET_ETH'),
      /non-negative decimal ETH amount/,
    );
  }
});

test('preflight funding plan sums only each role current balance deficit', async () => {
  const targets = [
    { role: 'admin', address: addresses.admin, targetBalance: parseEther('0.012') },
    { role: 'signerB', address: addresses.signerB, targetBalance: parseEther('0.010') },
    { role: 'delegate', address: addresses.delegate, targetBalance: parseEther('0.012') },
    { role: 'auditor', address: addresses.auditor, targetBalance: parseEther('0.001') },
  ];
  const balances = new Map([
    [addresses.admin, parseEther('0.002')],
    [addresses.signerB, parseEther('0.011')],
    [addresses.delegate, 0n],
    [addresses.auditor, parseEther('0.0005')],
  ]);

  const plan = await createFundingPlan(targets, async (address) => balances.get(address));
  assert.deepEqual(
    plan.roles.map(({ role, plannedTopUp }) => [role, plannedTopUp]),
    [
      ['admin', parseEther('0.010')],
      ['signerB', 0n],
      ['delegate', parseEther('0.012')],
      ['auditor', parseEther('0.0005')],
    ],
  );
  assert.equal(plan.totalTopUp, parseEther('0.0225'));
  assert.equal(requiredTopUp(parseEther('0.012'), parseEther('0.012')), 0n);
  assert.equal(requiredTopUp(parseEther('0.013'), parseEther('0.012')), 0n);
});

test('funding uses the latest deficit and re-reads the target after transfer', async () => {
  const plan = {
    role: 'admin',
    address: addresses.admin,
    targetBalance: parseEther('0.012'),
    currentBalance: parseEther('0.002'),
    plannedTopUp: parseEther('0.010'),
  };
  let balance = parseEther('0.005');
  const sent = [];

  const result = await fundRoleToTarget(plan, {
    getBalance: async () => balance,
    sendTopUp: async (address, value) => {
      sent.push([address, value]);
      balance += value;
    },
  });

  assert.deepEqual(sent, [[addresses.admin, parseEther('0.007')]]);
  assert.equal(result.transferred, parseEther('0.007'));
  assert.equal(result.finalBalance, parseEther('0.012'));
});

test('funding fails closed on a larger post-preflight deficit or an unmet target', async () => {
  const plan = {
    role: 'delegate',
    address: addresses.delegate,
    targetBalance: parseEther('0.012'),
    currentBalance: parseEther('0.002'),
    plannedTopUp: parseEther('0.010'),
  };
  let sends = 0;

  await assert.rejects(
    fundRoleToTarget(plan, {
      getBalance: async () => parseEther('0.001'),
      sendTopUp: async () => {
        sends += 1;
      },
    }),
    /balance dropped after preflight/,
  );
  assert.equal(sends, 0, 'a deficit larger than the reserved plan must not transfer');

  await assert.rejects(
    fundRoleToTarget(plan, {
      getBalance: async () => parseEther('0.002'),
      sendTopUp: async () => {
        sends += 1;
      },
    }),
    /funding did not reach its configured target balance/,
  );
  assert.equal(sends, 1, 'the post-transfer balance must be independently verified');
});
