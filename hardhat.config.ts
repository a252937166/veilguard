import { readFileSync } from 'node:fs';
import hardhatToolboxViemPlugin from '@nomicfoundation/hardhat-toolbox-viem';
import { defineConfig } from 'hardhat/config';
import noxPlugin from '@iexec-nox/nox-hardhat-plugin';

// Load .env manually (no dotenv dependency).
function env(name: string): string | undefined {
  // An explicitly activated Fresh environment must override the repository's
  // fallback .env. Check definition rather than truthiness so precedence is
  // deterministic even when an operator deliberately exports an empty value.
  if (process.env[name] !== undefined) {
    return process.env[name];
  }
  try {
    const line = readFileSync(new URL('./.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim();
  } catch {
    return undefined;
  }
}

const deployerKey = env('SEPOLIA_DEPLOYER_KEY');

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, noxPlugin],
  solidity: {
    version: '0.8.35',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    default: {
      type: 'edr-simulated',
      chainType: 'op',
    },
    sepolia: {
      type: 'http',
      chainType: 'l1',
      url: env('SEPOLIA_RPC_URL') ?? 'https://ethereum-sepolia-rpc.publicnode.com',
      accounts: deployerKey ? [deployerKey] : [],
    },
  },
});
