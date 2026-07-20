import { expect, test } from '@playwright/test';
import { installVisualFixture, type VisualSurface } from './fixtures/visual-fixture';

const cases: Array<{
  surface: VisualSurface;
  route: string;
  ready: RegExp;
}> = [
  { surface: 'landing', route: '/', ready: /confidential treasury controls/i },
  { surface: 'payments', route: '/#/payments', ready: /payment inbox/i },
  { surface: 'request-detail', route: '/#/payments/1', ready: /request #1/i },
  { surface: 'approval-decision', route: '/#/approvals/2', ready: /approval workspace/i },
  { surface: 'disclosure-review', route: '/#/disclosure', ready: /launch day review/i },
  { surface: 'audit-review', route: '/#/audit/1', ready: /audit packet review/i },
];

test.describe('deterministic operations desk visual baselines', () => {
  for (const visualCase of cases) {
    test(`${visualCase.surface} visual contract`, async ({ page }, testInfo) => {
      // One reviewed expected file is shared by macOS development and Ubuntu CI.
      // The deterministic font/time/network harness and the bounded pixel ratio
      // keep this portable without maintaining two divergent visual truths.
      testInfo.snapshotSuffix = '';
      const { unexpectedNetwork } = await installVisualFixture(page, visualCase.surface);
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });

      await page.goto(visualCase.route, { waitUntil: 'domcontentloaded' });
      const resumeDialog = page.getByRole('dialog', { name: /continue the unfinished launch day shift/i });
      const dismissResume = resumeDialog.getByRole('button', { name: /close resume dialog/i });
      if (await dismissResume.isVisible().catch(() => false)) {
        // The visual fixture already carries the recovered run state. Dismiss
        // the startup choice without activating the guided drawer, whose
        // responsive reflow and browser scroll anchoring are outside the page
        // contracts captured below.
        await dismissResume.click({ timeout: 2_000 }).catch(() => undefined);
        await expect(resumeDialog).toBeHidden({ timeout: 2_000 }).catch(() => undefined);
      }
      const closeMission = page.getByRole('button', { name: /close mission drawer/i });
      if (await closeMission.isVisible().catch(() => false)) {
        await closeMission.click({ timeout: 2_000 }).catch(() => undefined);
      }
      await expect(page.getByText(visualCase.ready).first()).toBeVisible({ timeout: 15_000 });

      if (visualCase.surface === 'payments') {
        await expect(page.getByText('CloudNode', { exact: true }).first()).toBeVisible();
        await expect(page.getByText('ShieldOps', { exact: true }).first()).toBeVisible();
      }
      if (visualCase.surface === 'approval-decision') {
        await expect(page.getByRole('button', { name: /approve payment/i })).toBeVisible();
      }
      if (visualCase.surface === 'disclosure-review') {
        await expect(page.getByRole('button', { name: /review selected scope/i })).toBeEnabled();
        await page.getByRole('button', { name: /review selected scope/i }).click();
        await expect(page.getByRole('heading', { name: /review the irreversible snapshot scope/i })).toBeVisible();
      }
      if (visualCase.surface === 'audit-review') {
        await expect(page.getByRole('heading', { name: /packet #1/i })).toBeVisible();
        await expect(page.getByRole('heading', { name: /launch day review bundle/i })).toBeVisible();
        await page.getByRole('button', { name: /unlock disclosed values/i }).click();
        await expect(page.getByRole('button', { name: /values unlocked/i })).toBeVisible();
        await expect(page.getByText('REVIEW COMPLETE', { exact: true })).toBeVisible();
        await expect(page.getByText('Recomputed match', { exact: true })).toBeVisible();
        await expect(page.getByText(/1 reviewed/i)).toBeVisible();
        await expect(page.getByText(/1 follow-up/i)).toBeVisible();
        await expect(page.locator('.toast')).toBeHidden({ timeout: 7_000 });
      }

      await expect.poll(() => unexpectedNetwork, { timeout: 2_000 }).toEqual([]);
      expect(consoleErrors).toEqual([]);

      // Snapshot update mode records its first frame immediately, while a
      // comparison run takes a second frame after its stability probe. Give
      // responsive reflow and scroll anchoring the same bounded settling
      // window in both modes, then normalize the viewport below.
      await page.waitForTimeout(250);

      if (visualCase.surface === 'approval-decision') {
        const decisionDock = page.getByRole('region', { name: /safe decision actions/i });
        await decisionDock.scrollIntoViewIfNeeded();
        const dockBox = await decisionDock.boundingBox();
        expect(dockBox).not.toBeNull();
        expect(dockBox!.y).toBeLessThan(page.viewportSize()!.height);
      } else {
        await page.evaluate(() => {
          window.scrollTo(0, 0);
          document.documentElement.scrollTo(0, 0);
          document.body.scrollTo(0, 0);
          for (const element of document.querySelectorAll<HTMLElement>('*')) {
            if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
              element.scrollTo(0, 0);
            }
          }
        });
      }

      const buildSha = page.locator('footer .mono').filter({ hasText: /^ui / });
      await expect(page).toHaveScreenshot(`${visualCase.surface}.png`, {
        animations: 'disabled',
        caret: 'hide',
        mask: (await buildSha.count()) ? [buildSha] : [],
        maskColor: '#161e2b',
        threshold: 0.2,
        maxDiffPixelRatio: 0.003,
      });
    });
  }
});
