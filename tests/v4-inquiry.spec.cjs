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

test('manual summary identifies the first invalid field and lets the guest correct it', async ({ page }) => {
  await page.goto('/minsu_ai_v3.html');
  await page.getByText('訂房需求整理').click();
  const date = page.getByLabel('入住日期');
  const nights = page.getByLabel('晚數');
  const generate = page.getByRole('button', { name: '產生需求摘要' });
  const feedback = page.locator('#request-feedback');

  await nights.fill('31');
  await generate.click();
  await expect(date).toBeFocused();
  await expect(date).toHaveAttribute('aria-invalid', 'true');
  await expect(date).toHaveAccessibleDescription('請填寫有效的入住日期。');
  await expect(page.getByRole('button', { name: '送至示範後台' })).toHaveCount(0);

  await date.fill('2027-02-06');
  await expect(feedback).toBeEmpty();
  await expect(date).not.toHaveAttribute('aria-invalid', 'true');
  await generate.click();
  await expect(nights).toBeFocused();
  await expect(nights).toHaveAccessibleDescription('晚數須為 1 至 30 的整數。');

  await nights.fill('2');
  await generate.click();
  await expect(feedback).toBeEmpty();
  await expect(latest(page)).toContainText('晚數：2');
  await expect(page.getByRole('log')).toBeFocused();
});

test('accepts bare numbers only while a quantity is requested', async ({ page }) => {
  await page.goto('/minsu_ai_v3.html');
  await send(page, '2');
  await expect(latest(page)).toContainText('目前沒有足夠資料');

  await send(page, '想訂房，會帶小孩');
  await send(page, '2');
  await expect(latest(page)).toContainText('哪一天入住');
  await send(page, '2027-02-06');
  await expect(latest(page)).toContainText('預計住幾晚');
  await send(page, '123');
  await expect(latest(page)).toContainText('預計住幾晚');
  await send(page, '２');
  await expect(latest(page)).toContainText('幾位大人');
  await send(page, '2');
  await expect(latest(page)).toContainText('幾位小孩');
  await send(page, '0');
  await expect(latest(page)).toContainText('晚數：2');
  await expect(latest(page)).toContainText('大人：2 人，小孩：0 人');

  await send(page, '2');
  await expect(latest(page)).toContainText('目前沒有足夠資料');
});

test('asks for one date and rejects signed, fractional or conflicting quantities', async ({ page }) => {
  await page.goto('/minsu_ai_v3.html');
  await send(page, '2027-02-06 或 2027-02-07，住 2.5 晚，2 位大人或 3 位大人，家庭房');
  await expect(latest(page)).toContainText('請提供完整日期');
  await send(page, '2027-02-30');
  await expect(latest(page)).toContainText('請提供完整日期');
  await send(page, '２０２７年２月６日');
  await expect(latest(page)).toContainText('預計住幾晚');
  await send(page, '住 −2 晚');
  await expect(latest(page)).toContainText('預計住幾晚');
  await send(page, '住兩晚');
  await expect(latest(page)).toContainText('幾位大人');
  await send(page, '三十一位大人');
  await expect(latest(page)).toContainText('幾位大人');
  await send(page, '十一位大人');
  await expect(latest(page)).toContainText('晚數：2');
  await expect(latest(page)).toContainText('大人：11 人');
  await expect(latest(page)).toContainText('家庭房');
});

test('keeps repeated handoffs in one queue entry on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/minsu_ai_v3.html');
  await page.getByText('訂房需求整理').click();
  await page.getByLabel('入住日期').fill('2027-02-06');
  const generate = page.getByRole('button', { name: '產生需求摘要' });
  await generate.click();
  await latest(page).getByRole('button', { name: '送至示範後台' }).click();
  await page.getByLabel('晚數').fill('01');
  await generate.click();
  await latest(page).getByRole('button', { name: '送至示範後台' }).click();
  await expect(latest(page)).toContainText('相同需求已在待處理清單中');
  await latest(page).getByRole('button', { name: '查看後台' }).click();
  const cases = page.getByRole('article');
  await expect(cases).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

  await cases.getByLabel('處理狀態').selectOption('done');
  await guest(page).click();
  await generate.click();
  await latest(page).getByRole('button', { name: '送至示範後台' }).click();
  await owner(page).click();
  await expect(cases).toHaveCount(2);
  await expect(page.locator('#count-new')).toHaveText('1');
  await expect(page.locator('#count-done')).toHaveText('1');
});

test('renders HTML-like visitor input as text in the summary and operator queue', async ({ page }) => {
  await page.goto('/minsu_ai_v3.html');
  const markup = '<b data-demo-marker="html">試用</b>';
  await send(page, markup);
  await expect(latest(page)).toContainText('目前沒有足夠資料');
  await send(page, '2027-02-06 住兩晚 2位大人。特殊需求：' + markup);
  await expect(latest(page)).toContainText(markup);
  await latest(page).getByRole('button', { name: '送至示範後台' }).click();
  await latest(page).getByRole('button', { name: '查看後台' }).click();
  await expect(page.getByRole('article')).toContainText(markup);
  await expect(page.locator('[data-demo-marker]')).toHaveCount(0);
});
