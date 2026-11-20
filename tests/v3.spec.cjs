const { expect, test } = require('@playwright/test');

const input = page => page.getByRole('textbox', { name: '旅客問題' });
const messages = page => page.getByRole('log').locator('.bubble');
const submit = page => page.getByRole('button', { name: '送出', exact: true });

async function openDemo(page) {
  await page.goto('/minsu_ai_v3.html');
}

async function openEditor(page) {
  await page.getByRole('button', { name: '老闆管理區' }).click();
  await page.getByText('編輯 FAQ 答案').click();
  return page.getByLabel('寵物', { exact: true });
}

test('submit, blank input, quick replies and long messages', async ({ page }) => {
  await openDemo(page);
  await input(page).fill('   ');
  await submit(page).click();
  await expect(messages(page)).toHaveCount(1);

  await input(page).fill('帶狗可以嗎？有停車嗎？晚上入住可以嗎？');
  await submit(page).click();
  await expect(messages(page).last()).toContainText('【寵物】');
  await expect(messages(page).last()).toContainText('【停車】');
  await expect(messages(page).last()).toContainText('【入住時間】');
  await expect(input(page)).toHaveValue('');
  await input(page).fill('x'.repeat(500));
  await input(page).press('Enter');
  await expect(messages(page).last()).toContainText('目前沒有足夠資料');
  await page.getByRole('button', { name: '早餐', exact: true }).click();
  await expect(messages(page).last()).toContainText('【早餐】');
});

test('Enter during composition leaves the draft available', async ({ page }) => {
  await openDemo(page);
  await input(page).fill('停車');
  await input(page).dispatchEvent('compositionstart');
  await input(page).press('Enter');
  await expect(messages(page)).toHaveCount(1);
  await expect(input(page)).toHaveValue('停車');
  await input(page).dispatchEvent('compositionend');
  await input(page).press('Enter');
  await expect(messages(page).last()).toContainText('【停車】');
});

test('all 36 answers are editable, persist after reload and reset', async ({ page }) => {
  await openDemo(page);
  let petAnswer = await openEditor(page);
  const fields = page.locator('#editor textarea');
  await expect(fields).toHaveCount(36);
  expect(await fields.evaluateAll(nodes => nodes.every(node => node.value.trim()))).toBe(true);
  await petAnswer.fill(' ');
  await page.getByRole('button', { name: '儲存問答' }).click();
  await expect(page.getByRole('status')).toContainText('請填寫「寵物」');
  await petAnswer.fill('虛構測試：寵物請先確認。');
  await page.getByRole('button', { name: '儲存問答' }).click();
  await expect(page.getByRole('status')).toContainText('已儲存於此瀏覽器');

  await page.reload();
  petAnswer = await openEditor(page);
  await expect(petAnswer).toHaveValue('虛構測試：寵物請先確認。');
  await page.getByRole('button', { name: '旅客接待' }).click();
  await input(page).fill('帶狗嗎？');
  await submit(page).click();
  await expect(messages(page).last()).toContainText('虛構測試');
  await page.getByRole('button', { name: '老闆管理區' }).click();
  await page.getByRole('button', { name: '恢復示範資料' }).click();
  await expect(petAnswer).toHaveValue('攜帶寵物與清潔費請向業者確認');
  await page.reload();
  await expect(await openEditor(page)).toHaveValue('攜帶寵物與清潔費請向業者確認');
});

test('malformed saved FAQ records fall back to defaults', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('minsu-v3-faq', JSON.stringify(Array(36).fill(null)));
  });
  await openDemo(page);
  await input(page).fill('有停車嗎？');
  await submit(page).click();
  await expect(messages(page).last()).toContainText('【停車】');
});

test('blocked storage still allows edits in the current tab', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('Storage blocked', 'SecurityError'); },
    });
  });
  await openDemo(page);
  await (await openEditor(page)).fill('虛構測試答案');
  await page.getByRole('button', { name: '儲存問答' }).click();
  await expect(page.getByRole('status')).toContainText('無法永久儲存');
  await page.getByRole('button', { name: '旅客接待' }).click();
  await input(page).fill('帶狗嗎？');
  await submit(page).click();
  await expect(messages(page).last()).toContainText('虛構測試答案');
  await page.getByRole('button', { name: '老闆管理區' }).click();
  await page.getByRole('button', { name: '恢復示範資料' }).click();
  await expect(page.getByRole('status')).toContainText('已恢復示範資料');
});

test('summary validates fields, fits the viewport and stays local', async ({ page }) => {
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await openDemo(page);
  await page.getByText('訂房需求整理').click();
  const generate = page.getByRole('button', { name: '產生需求摘要' });
  await generate.click();
  await expect(messages(page).last()).toContainText('請先填寫有效日期');
  await page.getByLabel('入住日期').fill('2027-02-01');
  await page.getByLabel('小孩').fill('');
  await generate.click();
  await expect(messages(page).last()).toContainText('請先填寫有效日期');
  await page.getByLabel('小孩').fill('0');
  await page.getByRole('textbox', { name: '房型', exact: true }).fill('四人房');
  await page.getByLabel('特殊需求').fill('虛構測試：需要車位');
  await generate.click();
  await expect(messages(page).last()).toContainText('尚未訂房');
  await expect(messages(page).last()).toContainText('日期：2027-02-01');
  await expect(messages(page).last()).toContainText('小孩：0 人');
  await expect(messages(page).last()).toContainText('房型：四人房');
  await expect(messages(page).last()).toContainText('虛構測試：需要車位');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth)
  );
  expect(requests.every(url => url.startsWith('http://127.0.0.1:8713/'))).toBe(true);
});
