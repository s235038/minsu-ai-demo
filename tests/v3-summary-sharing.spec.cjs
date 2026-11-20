const { expect, test } = require('@playwright/test');

const summary = page => page.getByRole('log').locator('.bubble').last();
const manualCopy = page => summary(page).getByRole('textbox', { name: '可手動複製的需求摘要' });
const dateLine = '日期：2027-02-01';
const needsLine = '特殊需求：虛構測試：需要車位';

async function generateSummary(page) {
  await page.goto('/minsu_ai_v3.html');
  await page.getByText('訂房需求整理').click();
  await page.getByLabel('入住日期').fill('2027-02-01');
  await page.getByLabel('特殊需求').fill('虛構測試：需要車位');
  await page.getByRole('button', { name: '產生需求摘要' }).click();
}

test('shares the generated summary as plain text', async ({ page, hasTouch }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      value: async data => { window.sharedSummary = data; },
    });
  });
  await generateSummary(page);
  const button = summary(page).getByRole('button', { name: '分享摘要' });
  if (hasTouch) await button.tap();
  else await button.click();

  const shared = await page.evaluate(() => window.sharedSummary);
  expect(Object.keys(shared)).toEqual(['text']);
  expect(shared.text).toContain('尚未訂房');
  expect(shared.text).toContain(dateLine);
  expect(shared.text).toContain(needsLine);
  expect(shared.text).not.toContain('分享摘要');
});

test('copies the summary when native sharing is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { value: undefined });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async text => { window.copiedSummary = text; } },
    });
  });
  await generateSummary(page);
  await summary(page).getByRole('button', { name: '複製摘要' }).click();
  await expect(summary(page).getByRole('status')).toContainText('已複製');
  expect(await page.evaluate(() => window.copiedSummary)).toContain(needsLine);
});

test('makes text selectable when clipboard access is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { value: undefined });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => { throw new DOMException('Blocked', 'NotAllowedError'); } },
    });
  });
  await generateSummary(page);
  await summary(page).getByRole('button', { name: '複製摘要' }).click();
  const field = manualCopy(page);
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute('readonly', '');
  await expect(field).toHaveValue(new RegExp(dateLine));
});

test('leaves the summary available when sharing is cancelled', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      value: async () => { throw new DOMException('Cancelled', 'AbortError'); },
    });
  });
  await generateSummary(page);
  const button = summary(page).getByRole('button', { name: '分享摘要' });
  await button.click();
  await expect(button).toBeEnabled();
  await expect(manualCopy(page)).toBeHidden();
});
