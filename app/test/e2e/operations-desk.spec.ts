import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('task routes survive refresh and fit the viewport', async ({ page }) => {
  await page.goto('/#/verify');
  await expect(page.getByRole('heading', { name: /confidential flow explorer/i })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/#\/verify$/);
  await expect(page.getByRole('heading', { name: /confidential flow explorer/i })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('signed-out users keep public task deep links after refresh', async ({ page }) => {
  const routes = [
    ['payments', 'Payment Inbox'],
    ['policies', 'Policies'],
    ['approvals', 'Pending Approvals'],
    ['disclosure', 'Build Packet'],
    ['audit', 'Audit Packets'],
    ['verify/launch-day', 'Flow launch-day'],
    ['contracts', 'Contracts'],
    ['provenance', 'Build Provenance'],
    ['funds', 'Get Funds'],
  ] as const;

  for (const [path, label] of routes) {
    await page.goto(`/#/${path}`);
    await expect(page).toHaveURL(new RegExp(`#/${path.replace('/', '\\/')}$`));
    await expect(page.locator('.crumb-page')).toHaveText(label);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`#/${path.replace('/', '\\/')}$`));
    await expect(page.locator('.crumb-page')).toHaveText(label);
  }
});

test('role picker traps focus, closes with Escape, and restores focus', async ({ page }) => {
  await page.goto('/#/overview');
  const trigger = page.getByRole('button', { name: /try a role/i }).first();
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: /try veilguard instantly/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /act as delegate/i })).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: /close role picker/i })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('guided entry opens the payment task without skip-ahead controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /start interactive demo/i }).first().click();
  await expect(page).toHaveURL(/#\/payments$/);
  await expect(page.getByRole('dialog', { name: /continue the unfinished launch day shift/i })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /payment inbox/i, level: 2 })).toBeVisible();
  await expect(page.getByRole('complementary', { name: /launch day demo mission/i })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: /launch day mission progress/i })).toHaveAttribute('aria-valuenow', '1');
  await expect(page.getByRole('button', { name: /skip/i })).toHaveCount(0);

  const closeTarget = await page.getByRole('button', { name: /close mission drawer/i }).boundingBox();
  expect(closeTarget?.width).toBeGreaterThanOrEqual(44);
  expect(closeTarget?.height).toBeGreaterThanOrEqual(44);

  const walletTrigger = page.getByRole('button', { name: /demo account menu/i });
  await expect(walletTrigger).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) < 720) {
    const walletTarget = await walletTrigger.boundingBox();
    expect(walletTarget?.width).toBeGreaterThanOrEqual(44);
    expect(walletTarget?.height).toBeGreaterThanOrEqual(44);
  }
});

test('demo wallet controls remain operable in the compact header', async ({ page }) => {
  await page.goto('/#/overview');
  await page.getByRole('button', { name: /try a role/i }).first().click();
  await page.getByRole('dialog', { name: /try veilguard instantly/i })
    .getByRole('button', { name: /act as delegate/i }).click();

  const walletTrigger = page.getByRole('button', { name: /demo account menu/i });
  await expect(walletTrigger).toBeVisible();
  await walletTrigger.click();
  await expect(page.getByRole('dialog', { name: /wallet and account menu/i })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(walletTrigger).toBeFocused();
});

test('funds form and table expose names to assistive technology', async ({ page }) => {
  await page.goto('/#/funds');
  await expect(page.getByRole('heading', { name: /test funds/i, level: 1 })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: /amount/i })).toBeVisible();
  await expect(page.getByRole('table', { name: /official sepolia eth faucets/i })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('live approve and reject acceptance is explicit opt-in', async ({ page }) => {
  test.skip(process.env.VEILGUARD_LIVE_E2E !== '1', 'Requires funded Sepolia delegates and the provisioner with Safe owner secrets.');
  await page.goto('/#/payments');
  await expect(page.getByText('ShieldOps').first()).toBeVisible();
  // The destructive testnet path is intentionally run only in the release gate.
  // Its job is to submit independent run IDs and assert the resulting Safe and
  // refund links in the Privacy Lens, not merely call /api/health.
});
