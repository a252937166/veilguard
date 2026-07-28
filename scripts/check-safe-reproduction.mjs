import { readFile } from 'node:fs/promises';
import {
  auditDeploymentManifest,
  auditSafeHelperSource,
  auditSafeScriptSource,
} from './lib/safe-reproduction-policy.mjs';

const targets = [
  ['deploy', new URL('./deploy-sepolia.ts', import.meta.url)],
  ['smoke', new URL('./smoke-sepolia.ts', import.meta.url)],
  ['e2e', new URL('./e2e-sepolia.ts', import.meta.url)],
  ['evidence', new URL('./final-evidence.ts', import.meta.url)],
];

const violations = [];
for (const [kind, url] of targets) {
  const source = await readFile(url, 'utf8');
  violations.push(...auditSafeScriptSource(source, kind, url.pathname.split('/').at(-1)));
}

const helperUrl = new URL('./safe-lib.ts', import.meta.url);
violations.push(
  ...auditSafeHelperSource(
    await readFile(helperUrl, 'utf8'),
    helperUrl.pathname.split('/').at(-1),
  ),
);

for (const [label, url] of [
  ['root-deployments', new URL('../deployments.json', import.meta.url)],
  ['app-deployments', new URL('../app/src/deployments.json', import.meta.url)],
]) {
  const manifest = JSON.parse(await readFile(url, 'utf8'));
  violations.push(...auditDeploymentManifest(manifest, label));
}

if (violations.length) {
  for (const violation of violations) {
    console.error(`[safe-reproduction:${violation.code}] ${violation.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('[safe-reproduction] fresh deploy, smoke, E2E and final evidence are exact 2-of-2');
}
