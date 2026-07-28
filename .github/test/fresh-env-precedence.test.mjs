import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Hardhat uses an activated Fresh environment before the repository .env', async (t) => {
  const previousRpc = process.env.SEPOLIA_RPC_URL;
  const previousDeployer = process.env.SEPOLIA_DEPLOYER_KEY;
  t.after(() => {
    if (previousRpc === undefined) delete process.env.SEPOLIA_RPC_URL;
    else process.env.SEPOLIA_RPC_URL = previousRpc;
    if (previousDeployer === undefined) delete process.env.SEPOLIA_DEPLOYER_KEY;
    else process.env.SEPOLIA_DEPLOYER_KEY = previousDeployer;
  });

  const rpc = 'https://fresh-env-precedence.invalid';
  const deployerKey = `0x${'7'.repeat(64)}`;
  process.env.SEPOLIA_RPC_URL = rpc;
  process.env.SEPOLIA_DEPLOYER_KEY = deployerKey;

  const configUrl = new URL('../../hardhat.config.ts', import.meta.url);
  configUrl.searchParams.set('fresh-env-precedence', String(Date.now()));
  const { default: config } = await import(configUrl.href);

  assert.equal(config.networks.sepolia.url, rpc);
  assert.deepEqual(config.networks.sepolia.accounts, [deployerKey]);
});

test('Fresh helper instructions activate generated values without printing secrets', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const activation = readme.match(
    /set -a\s*\n\. \/absolute\/private\/path\/fresh\.env\s*\nset \+a/,
  );
  assert.ok(activation, 'README must export every generated Fresh value');
  const activationIndex = readme.indexOf(activation[0]);
  const deployIndex = readme.indexOf(
    'npx hardhat run scripts/deploy-sepolia.ts --network sepolia',
    activationIndex,
  );
  assert.ok(deployIndex > activationIndex, 'Fresh environment must be active before deployment');
  assert.match(readme, /Hardhat itself use exported process variables before the\s+repository `\.env`/);
  assert.doesNotMatch(
    readme.slice(activationIndex, deployIndex),
    /cat |echo \$|printenv|env \|/,
    'activation instructions must not print generated secrets',
  );
});
