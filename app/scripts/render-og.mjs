import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, '..');
const source = resolve(appDir, 'brand/og-card.html');
const output = resolve(appDir, 'public/og/veilguard-operations-desk-v1.png');

await mkdir(dirname(output), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
  await page.goto(new URL(`file://${source}`).href, { waitUntil: 'load' });
  await page.screenshot({ path: output, type: 'png', animations: 'disabled' });
  process.stdout.write(`${output}\n`);
} finally {
  await browser.close();
}
