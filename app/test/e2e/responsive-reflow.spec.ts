import { expect, test, type Page } from '@playwright/test';
import { installVisualFixture, type VisualSurface } from './fixtures/visual-fixture';

const taskSurfaces: Array<{ surface: VisualSurface; route: string; ready: RegExp }> = [
  { surface: 'payments', route: '/#/payments', ready: /payment inbox/i },
  { surface: 'request-detail', route: '/#/payments/1', ready: /request #1/i },
  { surface: 'approval-decision', route: '/#/approvals/2', ready: /approval workspace/i },
  { surface: 'disclosure-review', route: '/#/disclosure', ready: /launch day review/i },
  { surface: 'audit-review', route: '/#/audit/1', ready: /audit packet review/i },
  { surface: 'request-detail', route: '/#/verify', ready: /deployed infrastructure/i },
  { surface: 'request-detail', route: '/#/funds', ready: /test funds/i },
];

const narrowWidths = [292, 320] as const;

async function dismissTransientGuidance(page: Page) {
  const resumeDialog = page.getByRole('dialog', { name: /continue the unfinished launch day shift/i });
  const dismissResume = resumeDialog.getByRole('button', { name: /close resume dialog/i });
  if (await dismissResume.isVisible().catch(() => false)) await dismissResume.click();

  const closeMission = page.getByRole('button', { name: /close mission drawer/i });
  if (await closeMission.isVisible().catch(() => false)) await closeMission.click();
}

test.describe('narrow task-surface reflow', () => {
  for (const visualCase of taskSurfaces) {
    for (const width of narrowWidths) {
      test(`${visualCase.route} stays inside a ${width} CSS-pixel viewport`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'mobile-390', 'One narrow-layout contract is enough for both projects.');
        await page.setViewportSize({ width, height: 844 });
        const { unexpectedNetwork } = await installVisualFixture(page, visualCase.surface);

        await page.goto(visualCase.route, { waitUntil: 'domcontentloaded' });
        await dismissTransientGuidance(page);
        await expect(page.getByText(visualCase.ready).first()).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(150);

        const audit = await page.evaluate(() => {
          const viewportWidth = document.documentElement.clientWidth;
          const root = document.querySelector<HTMLElement>('.main-body') ?? document.body;
          const allowedScrollContainers = '.tbl:not(.responsive-record-table):not(.audit-request-table), .workbench-tabs, .side-nav';
          const offenders = [...root.querySelectorAll<HTMLElement>('*')]
            .filter((element) => {
              const style = getComputedStyle(element);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              if (style.position === 'fixed' || element.closest(allowedScrollContainers)) return false;
              const rect = element.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) return false;
              return rect.left < -1 || rect.right > viewportWidth + 1;
            })
            .slice(0, 12)
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              className: element.className,
              left: Math.round(element.getBoundingClientRect().left),
              right: Math.round(element.getBoundingClientRect().right),
            }));
          return {
            documentOverflow: document.documentElement.scrollWidth - viewportWidth,
            offenders,
          };
        });

        expect(audit.documentOverflow).toBeLessThanOrEqual(1);
        expect(audit.offenders).toEqual([]);
        expect(unexpectedNetwork).toEqual([]);
      });
    }
  }
});

test('request evidence groups retain a deliberate inset at the reported 292 CSS pixels', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'Mobile reflow regression.');
  await page.setViewportSize({ width: 292, height: 844 });
  await installVisualFixture(page, 'request-detail');
  await page.goto('/#/payments/1', { waitUntil: 'domcontentloaded' });
  await dismissTransientGuidance(page);

  const summary = page.getByRole('region', { name: 'Request summary' });
  const timeline = page.getByRole('region', { name: 'Request timeline' });
  const transactions = page.getByRole('region', { name: 'Transactions' });
  await expect(summary).toBeVisible();

  const insetFrom = async (childSelector: string, parent = summary) => {
    const [parentBox, childBox] = await Promise.all([
      parent.boundingBox(),
      parent.locator(childSelector).first().boundingBox(),
    ]);
    expect(parentBox).not.toBeNull();
    expect(childBox).not.toBeNull();
    return childBox!.x - parentBox!.x;
  };

  expect(await insetFrom('.data-list > div')).toBeGreaterThanOrEqual(15);
  expect(await insetFrom('.signature-timeline', timeline)).toBeGreaterThanOrEqual(15);
  expect(await insetFrom('.transaction-list', transactions)).toBeGreaterThanOrEqual(15);

  const privacyLens = page.getByLabel('Privacy lens comparison');
  const [lensBox, firstPrivacyLabel] = await Promise.all([
    privacyLens.boundingBox(),
    privacyLens.locator('dt').first().boundingBox(),
  ]);
  expect(lensBox).not.toBeNull();
  expect(firstPrivacyLabel).not.toBeNull();
  expect(firstPrivacyLabel!.x - lensBox!.x).toBeGreaterThanOrEqual(15);

  const [headingBox, titleBox] = await Promise.all([
    summary.locator('.section-heading').boundingBox(),
    summary.getByRole('heading', { name: 'Request summary' }).boundingBox(),
  ]);
  expect(headingBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(titleBox!.height).toBeLessThanOrEqual(28);
});

test('approval detail facts and signature timeline share the panel gutter', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'Mobile reflow regression.');
  await page.setViewportSize({ width: 292, height: 844 });
  await installVisualFixture(page, 'approval-decision');
  await page.goto('/#/approvals/2', { waitUntil: 'domcontentloaded' });
  await dismissTransientGuidance(page);

  const detail = page.locator('.approval-workbench .workbench-detail');
  await expect(detail.getByRole('heading', { name: 'ShieldOps' })).toBeVisible();
  const [detailBox, factBox, timelineBox] = await Promise.all([
    detail.boundingBox(),
    detail.locator('.data-list > div').first().boundingBox(),
    detail.locator('.signature-timeline').boundingBox(),
  ]);
  expect(detailBox).not.toBeNull();
  expect(factBox).not.toBeNull();
  expect(timelineBox).not.toBeNull();
  expect(factBox!.x - detailBox!.x).toBeGreaterThanOrEqual(15);
  expect(timelineBox!.x - detailBox!.x).toBeGreaterThanOrEqual(15);
});

test('Funds and Verify records become readable mobile cards without horizontal discovery', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'Mobile reflow regression.');
  await page.setViewportSize({ width: 292, height: 844 });

  await installVisualFixture(page, 'request-detail');
  await page.goto('/#/funds', { waitUntil: 'domcontentloaded' });
  await dismissTransientGuidance(page);
  const faucetTable = page.locator('.responsive-record-table').first();
  await expect(faucetTable.getByRole('link', { name: /open faucet/i }).first()).toBeVisible();
  await expect.poll(() => faucetTable.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);

  await page.goto('/#/verify', { waitUntil: 'domcontentloaded' });
  await dismissTransientGuidance(page);
  const contractTable = page.locator('.contract-record-table').first();
  await expect(contractTable.getByText('VeilGuardModule')).toBeVisible();
  await expect.poll(() => contractTable.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
});

test('Auditor review dispositions are visible as mobile cards', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'Mobile reflow regression.');
  await page.setViewportSize({ width: 292, height: 844 });
  await installVisualFixture(page, 'audit-review');
  await page.goto('/#/audit/1', { waitUntil: 'domcontentloaded' });
  await dismissTransientGuidance(page);

  const unlock = page.getByRole('button', { name: /unlock disclosed values/i });
  if (await unlock.isVisible().catch(() => false)) await unlock.click();
  await page.getByRole('tab', { name: /requests/i }).click();
  const reviewTable = page.locator('.audit-request-table');
  await expect(reviewTable.getByRole('button', { name: 'Reviewed' }).first()).toBeVisible();
  await expect(reviewTable.getByRole('button', { name: 'Flag follow-up' }).first()).toBeVisible();
  await expect.poll(() => reviewTable.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
});

test('long route context wraps instead of being silently truncated', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'Mobile reflow regression.');
  await page.setViewportSize({ width: 292, height: 844 });
  await installVisualFixture(page, 'request-detail');
  await page.goto('/#/policies/1/new-version', { waitUntil: 'domcontentloaded' });
  await dismissTransientGuidance(page);

  const routeContext = page.locator('.crumb-page');
  await expect(routeContext).toHaveText('Policy #1 · New Version');
  await expect(routeContext).toHaveAttribute('title', 'Policy #1 · New Version');
  expect(await routeContext.evaluate((node) => {
    const style = getComputedStyle(node);
    return style.overflow === 'hidden' && node.scrollWidth > node.clientWidth + 1;
  })).toBe(false);
});
