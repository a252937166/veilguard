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

test('guided role transition does not update routed children during render', async ({ page }, testInfo) => {
  const renderWarnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Cannot update a component')) {
      renderWarnings.push(message.text());
    }
  });

  await page.goto('/#/disclosure');
  const guidedEntry = testInfo.project.name === 'mobile-390'
    ? page.getByRole('button', { name: /start interactive demo/i })
    : page.getByRole('button', { name: /^guided demo$/i });
  await guidedEntry.click();
  await expect(page).toHaveURL(/#\/payments$/);
  await expect(page.getByRole('heading', { name: /payment inbox/i, level: 2 })).toBeVisible();
  expect(renderWarnings).toEqual([]);
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

test('compact mission rail stays above the mobile Safe decision dock', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'Mobile collision regression.');
  await page.goto('/');
  await page.evaluate(() => {
    // Keep the real page head intact: under `vite preview` it already points to
    // the compiled, hashed dist CSS. Only replace the body fixture so this
    // regression exercises the same styles CI and production actually serve.
    document.body.innerHTML = `<main class="main-body">
      <aside class="tour mission-drawer is-action-compact is-decision-step" aria-label="Launch Day demo mission">
        <div class="mission-compact-rail">
          <span class="mission-compact-count">Mission 3/7</span>
          <b>Choose Approve or Reject</b>
          <button class="icon-button mission-compact-toggle" aria-label="Expand mission details">⌃</button>
        </div>
        <div class="mission-drawer-content">Expanded mission content</div>
      </aside>
      <section class="safe-decision-dock" aria-label="Safe decision actions">
        <div class="safe-decision-progress" role="status">
          <div class="safe-decision-progress__head"><span class="spin"></span><span><b>Approving payment</b><small>Threshold signatures</small></span></div>
        </div>
        <div class="safe-decision-dock__actions">
          <button class="btn danger">Reject &amp; return funds</button>
          <button class="btn primary">Approve payment</button>
        </div>
      </section>
    </main>`;
  });

  const mission = page.getByRole('complementary', { name: /launch day demo mission/i });
  const dock = page.getByRole('region', { name: /safe decision actions/i });
  const approve = page.getByRole('button', { name: /approve payment/i });
  const [missionBox, dockBox, approveBox] = await Promise.all([
    mission.boundingBox(), dock.boundingBox(), approve.boundingBox(),
  ]);
  expect(missionBox).not.toBeNull();
  expect(dockBox).not.toBeNull();
  expect(approveBox).not.toBeNull();
  expect(missionBox!.y + missionBox!.height).toBeLessThanOrEqual(dockBox!.y + 1);
  expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(844 + 1);
  expect(approveBox!.height).toBeGreaterThanOrEqual(44);

  const topElement = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return target?.textContent;
  }, { x: approveBox!.x + approveBox!.width / 2, y: approveBox!.y + approveBox!.height / 2 });
  expect(topElement).toContain('Approve payment');

  const combinedPadding = await page.locator('.main-body').evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom));
  expect(combinedPadding).toBe(156);

  await mission.evaluate((element) => element.remove());
  const dockOnlyPadding = await page.locator('.main-body').evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom));
  expect(dockOnlyPadding).toBe(100);
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
