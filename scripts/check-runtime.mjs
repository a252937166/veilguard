import { execFileSync } from 'node:child_process';

const REQUIRED_NODE_MAJOR = 22;
const major = Number(process.versions.node.split('.')[0]);
const problems = [];

if (major !== REQUIRED_NODE_MAJOR) {
  problems.push(`Node ${REQUIRED_NODE_MAJOR}.x is required; current runtime is ${process.version}`);
}

if (process.platform === 'darwin') {
  let hardware = '';
  let translated = false;
  try {
    hardware = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim();
  } catch {
    // Version validation still provides useful protection if uname is unavailable.
  }
  try {
    // Under Rosetta, `uname -m` may report x86_64 to the translated process.
    translated = execFileSync('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], {
      encoding: 'utf8',
    }).trim() === '1';
  } catch {
    // The key is absent on older Intel Macs; the hardware/arch check still applies.
  }
  if (translated || (hardware === 'arm64' && process.arch !== 'arm64')) {
    problems.push(`Apple Silicon requires an arm64 Node process; current process.arch is ${process.arch} (Rosetta)`);
  }
}

if (problems.length) {
  console.error('[runtime] Unsupported local Node runtime:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('Run `nvm use`, then reinstall native dependencies with `npm ci` and `npm --prefix app ci`.');
  process.exit(1);
}

console.log(`[runtime] Node ${process.version} ${process.arch} OK`);
