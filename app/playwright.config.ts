import { defineConfig, devices } from '@playwright/test';

const isLiveRelease = process.env.VEILGUARD_LIVE_E2E === '1';
const requestedPort = process.env.VEILGUARD_E2E_PORT ?? '4173';
const e2ePort = /^\d{2,5}$/.test(requestedPort) ? requestedPort : '4173';
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: './test/e2e',
  testMatch: isLiveRelease ? '**/live-release-gate.spec.ts' : '**/*.spec.ts',
  testIgnore: isLiveRelease ? [] : ['**/live-release-gate.spec.ts'],
  timeout: isLiveRelease ? 720_000 : 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: isLiveRelease ? 0 : process.env.CI ? 1 : 0,
  workers: isLiveRelease ? 1 : process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: isLiveRelease
      ? process.env.VEILGUARD_LIVE_BASE_URL ?? 'https://veilguard.axiqo.xyz'
      : e2eBaseUrl,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    trace: isLiveRelease ? 'on' : 'retain-on-failure',
  },
  ...(isLiveRelease
    ? {}
    : {
        webServer: {
          // Visual fixtures replace one source module at the dev-server edge;
          // they never enter production source or the built bundle. The CI
          // app-build job still validates the production build independently.
          command: `npm run dev -- --host 127.0.0.1 --port ${e2ePort}`,
          url: e2eBaseUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      }),
  projects: isLiveRelease
    ? [
        {
          name: 'live-sepolia',
          use: {
            ...devices['Desktop Chrome'],
            viewport: { width: 1366, height: 768 },
          },
        },
      ]
    : [
        { name: 'desktop-1366', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } } },
        { name: 'mobile-390', use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } } },
      ],
});
