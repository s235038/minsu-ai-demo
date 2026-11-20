const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { expect, test } = require('@playwright/test');

test('exports a branded HTML demo with edited answers and no guest activity', async ({ page, browser }) => {
  await page.goto('/minsu_ai_v3.html');
  const question = page.getByRole('textbox', { name: '旅客問題' });
  await question.fill('匯出時不應包含這段測試聊天');
  await question.press('Enter');
  await page.getByText('訂房需求整理').click();
  await page.getByLabel('入住日期').fill('2028-09-17');
  await page.getByLabel('特殊需求').fill('匯出時不應包含這段測試需求');
  await page.getByRole('button', { name: '產生需求摘要' }).click();

  await page.getByText('老闆管理區').click();
  await page.getByText('編輯 FAQ 答案').click();
  const name = '虛構海風旅宿';
  const answer = '虛構車位示範 </script><img src=x onerror="window.exportInjected=true">';
  await page.getByLabel('展示旅宿名稱').fill(name);
  await page.getByLabel('停車', { exact: true }).fill(answer);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下載客製展示 HTML' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('minsu-trial.html');
  const html = readFileSync(await download.path(), 'utf8');
  expect(html).not.toContain('匯出時不應包含');
  expect(html).not.toContain('2028-09-17');

  const guest = await browser.newPage();
  try {
    await guest.route('http://127.0.0.1:8713/minsu-trial.html', route =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
    );
    await guest.addInitScript(() => {
      localStorage.setItem('minsu-v3-faq', JSON.stringify(
        Array.from({ length: 36 }, () => ({ q: '停車', a: '另一份展示的本機答案' }))
      ));
    });
    await guest.goto('http://127.0.0.1:8713/minsu-trial.html');
    await expect(guest).toHaveTitle('虛構海風旅宿｜智慧接待展示');
    await expect(guest.getByRole('banner')).toContainText(name);
    const guestQuestion = guest.getByRole('textbox', { name: '旅客問題' });
    await guestQuestion.fill('停車和早餐');
    await guestQuestion.press('Enter');
    const reply = guest.getByRole('log').locator('.bubble').last();
    await expect(reply).toContainText(answer);
    await expect(reply).toContainText('【早餐】');
    expect(await guest.evaluate(() => window.exportInjected)).toBeUndefined();
    await guest.getByText('老闆管理區').click();
    await guest.getByText('編輯 FAQ 答案').click();
    await expect(guest.locator('#editor textarea')).toHaveCount(36);
    await guest.getByRole('button', { name: '恢復示範資料' }).click();
    await expect(guest.getByLabel('停車', { exact: true })).toHaveValue(answer);
  } finally {
    await guest.close();
  }
});

test('asks the operator to fill a blank answer before download', async ({ page }) => {
  await page.goto('/minsu_ai_v3.html');
  await page.getByText('老闆管理區').click();
  await page.getByText('編輯 FAQ 答案').click();
  const parking = page.getByLabel('停車', { exact: true });
  await parking.fill('   ');
  await page.getByRole('button', { name: '下載客製展示 HTML' }).click();
  await expect(page.getByRole('status')).toContainText('請填寫「停車」');
  await expect(parking).toBeFocused();
});

test('reopens the actual downloaded HTML offline', async ({ page, context }, testInfo) => {
  await page.goto('/minsu_ai_v3.html');
  await page.getByRole('button', { name: '老闆管理區' }).click();
  await page.getByRole('textbox', { name: '展示旅宿名稱' }).fill('虛構離線旅宿');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下載客製展示 HTML' }).click(),
  ]);
  const file = testInfo.outputPath('minsu-trial.html');
  await download.saveAs(file);

  await context.setOffline(true);
  const reopened = await context.newPage();
  await reopened.goto(pathToFileURL(file).href);
  await expect(reopened).toHaveTitle('虛構離線旅宿｜智慧接待展示');
  const question = reopened.getByRole('textbox', { name: '旅客問題' });
  await question.fill('停車和早餐');
  await question.press('Enter');
  const reply = reopened.getByRole('log').locator('.bubble').last();
  await expect(reply).toContainText('【停車】');
  await expect(reply).toContainText('【早餐】');
  expect(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
