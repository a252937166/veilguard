import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';

const canonicalUrl = new URL('../deployments.json', import.meta.url);
const appUrl = new URL('../app/src/deployments.json', import.meta.url);

const [canonical, app] = await Promise.all([
  readFile(canonicalUrl, 'utf8').then(JSON.parse),
  readFile(appUrl, 'utf8').then(JSON.parse),
]);

if (!isDeepStrictEqual(canonical, app)) {
  console.error('[deployments] app/src/deployments.json is out of sync with deployments.json.');
  console.error('Copy the canonical deployment manifest into the app before building.');
  process.exit(1);
}

console.log('[deployments] canonical and app manifests match');
