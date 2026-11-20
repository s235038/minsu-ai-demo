const { expect, test } = require('@playwright/test');

const owner = page => page.getByRole('button', { name: '老闆管理區' });
const guest = page => page.getByRole('button', { name: '旅客接待' });
const latest = page => page.getByRole('log').locator('.bubble').last();

async function send(page, text) {
  await page.getByRole('textbox', { name: '旅客問題' }).fill(text);
  await page.getByRole('button', { name: '送出', exact: true }).click();
}

test('mobile demo gathers missing details and hands off an editable inquiry', async ({ page, hasTouch }) => {
  await page.goto('/minsu_ai_v3.html');
  const example = page.getByRole('button', { name: '開始示範諮詢' });
  if (hasTouch) await example.tap();
  else await example.click();
  await expect(latest(page)).toContainText('哪一天入住');
  await send(page, '2027-02-30');
  await expect(latest(page)).toContainText('請提供完整日期');
  await send(page, '2027年2月6日，1位小孩，四人房。特殊需求：需要車位');
  const summary = latest(page);
  await expect(summary).toContainText('2027-02-06');
  await expect(summary).toContainText('晚數：2');
  await expect(summary).toContainText('大人：2 人，小孩：1 人');
  await expect(summary).toContainText('四人房');
  await expect(summary).toContainText('需要車位');

  await owner(page).click();
  await expect(page.getByText('目前沒有住宿諮詢')).toBeVisible();
  await guest(page).click();
  await summary.getByRole('button', { name: '送至示範後台' }).click();
  await expect(summary).toContainText('已加入此瀏覽器');
  await summary.getByRole('button', { name: '查看後台' }).click();
  await expect(page.getByRole('heading', { name: '住宿諮詢工作台' })).toBeVisible();
  await expect(page.getByRole('log')).toBeHidden();
  const card = page.getByRole('article');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('2027-02-06 入住 · 2 晚');
  await expect(card).toContainText('需要車位');
  await expect(page.locator('#count-new')).toHaveText('1');
  await card.getByLabel('處理狀態').selectOption('review');
  await expect(page.locator('#count-new')).toHaveText('0');
  await expect(page.locator('#count-review')).toHaveText('1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.reload();
  await owner(page).click();
  await expect(card.getByLabel('處理狀態')).toHaveValue('review');
  await card.getByLabel('處理狀態').selectOption('done');
  await expect(page.locator('#count-done')).toHaveText('1');
});

test('sample records are labeled and load once, with storage failure feedback', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('Storage blocked', 'SecurityError'); },
    });
  });
  await page.goto('/minsu_ai_v3.html');
  await owner(page).click();
  const seed = page.getByRole('button', { name: '載入虛構案例' });
  await seed.click();
  await expect(page.getByText('已暫時載入，重新整理後可能遺失。')).toBeVisible();
  const cases = page.getByRole('article');
  await expect(cases).toHaveCount(2);
  await expect(cases.getByText('虛構案例', { exact: true })).toHaveCount(2);
  await seed.click();
  await expect(cases).toHaveCount(2);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '清除本機諮詢' }).click();
  await expect(page.getByText('目前沒有住宿諮詢')).toBeVisible();
});

test('asks for explicit data and does not truncate out-of-range quantities', async ({ page }) => {
  await page.goto('/minsu_ai_v3.html');
  await send(page, '想訂房，2027-02-06 住123晚');
  await expect(latest(page)).toContainText('預計住幾晚');
  await send(page, '住兩晚');
  await expect(latest(page)).toContainText('幾位大人');
  await send(page, '兩位大人');
  await expect(latest(page)).toContainText('大人：2 人');
});
