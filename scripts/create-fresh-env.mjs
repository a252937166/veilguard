#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parseEnv(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1).trim()];
      }),
  );
}

const sourcePath = resolve(option('--source') ?? '.env');
const outputPath = option('--output');
const checkpointOption = option('--checkpoint');

if (!outputPath || !checkpointOption) {
  throw new Error(
    'Usage: create-fresh-env.mjs --source <env> --output <private-env> '
    + '--checkpoint <private-checkpoint>',
  );
}

const destination = resolve(outputPath);
const checkpoint = resolve(checkpointOption);
if (destination === checkpoint) {
  throw new Error('Fresh environment and checkpoint paths must differ');
}
if (existsSync(destination)) {
  throw new Error(`refusing to overwrite Fresh environment: ${destination}`);
}
if (existsSync(checkpoint)) {
  throw new Error(`refusing to reuse Fresh checkpoint: ${checkpoint}`);
}

const source = parseEnv(sourcePath);
const deployerKey = source.SEPOLIA_DEPLOYER_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey ?? '')) {
  throw new Error('source environment has no valid SEPOLIA_DEPLOYER_KEY');
}

const privateKeys = {
  admin: generatePrivateKey(),
  signerB: generatePrivateKey(),
  delegate: generatePrivateKey(),
  auditor: generatePrivateKey(),
};
const accounts = {
  deployer: privateKeyToAccount(deployerKey),
  admin: privateKeyToAccount(privateKeys.admin),
  signerB: privateKeyToAccount(privateKeys.signerB),
  delegate: privateKeyToAccount(privateKeys.delegate),
  auditor: privateKeyToAccount(privateKeys.auditor),
};
const addresses = Object.values(accounts).map(({ address }) => address.toLowerCase());
if (new Set(addresses).size !== addresses.length) {
  throw new Error('generated Fresh identities are not distinct');
}
const lines = [
  '# Generated disposable Fresh Sepolia identities. Never commit this file.',
  `SEPOLIA_DEPLOYER_KEY=${deployerKey}`,
  `SEPOLIA_DEPLOYER_ADDR=${accounts.deployer.address}`,
  `DEMO_ADMIN_KEY=${privateKeys.admin}`,
  `DEMO_ADMIN_ADDR=${accounts.admin.address}`,
  `DEMO_SIGNER_B_KEY=${privateKeys.signerB}`,
  `DEMO_SIGNER_B_ADDR=${accounts.signerB.address}`,
  `DEMO_DELEGATE_KEY=${privateKeys.delegate}`,
  `DEMO_DELEGATE_ADDR=${accounts.delegate.address}`,
  `DEMO_AUDITOR_KEY=${privateKeys.auditor}`,
  `DEMO_AUDITOR_ADDR=${accounts.auditor.address}`,
  'FRESH_ADMIN_TARGET_ETH=0.012',
  'FRESH_SIGNER_B_TARGET_ETH=0.010',
  'FRESH_DELEGATE_TARGET_ETH=0.012',
  'FRESH_AUDITOR_TARGET_ETH=0.001',
  `FRESH_RUN_CHECKPOINT_PATH=${checkpoint}`,
];
if (source.SEPOLIA_RPC_URL) {
  lines.push(`SEPOLIA_RPC_URL=${source.SEPOLIA_RPC_URL}`);
}

mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
mkdirSync(dirname(checkpoint), { recursive: true, mode: 0o700 });
writeFileSync(destination, `${lines.join('\n')}\n`, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});
chmodSync(destination, 0o600);

console.log(`Fresh environment created: ${destination}`);
console.log(`Fresh checkpoint reserved: ${checkpoint}`);
console.log('Generated four distinct disposable role identities.');
