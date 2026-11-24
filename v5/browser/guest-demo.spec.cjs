const { expect, test } = require('@playwright/test');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const key = () => randomBytes(32).toString('base64url');

test('guest chat collects a synthetic inquiry and the owner sees it on mobile or desktop', async ({ page, browser }) => {
  const { createV5Server } = await import('../server.mjs');
  const { createMockProvider } = await import('../assistant.mjs');
  const { createStore } = await import('../store.mjs');
  const knowledge = JSON.parse(readFileSync(resolve(__dirname, '../knowledge.demo.json'), 'utf8'));
  const store = createStore(':memory:');
  const operatorToken = key();
  const server = createV5Server({
    store, knowledge, channelSecret: key(), operatorToken, privacyKey: key(),
    mode: 'mock', demoGuestEnabled: true, provider: createMockProvider(),
    reply: async () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const ownerContext = await browser.newContext();

  try {
    await page.goto(origin + '/demo/guest');
    await expect(page.getByRole('heading', { name: '旅客提問模擬器' })).toBeVisible();
    await expect(page.getByText('僅供本機測試')).toBeVisible();
    await page.getByRole('button', { name: '停車＋寵物' }).click();
    await expect(page.getByLabel('輸入虛構旅客的問題')).toHaveValue(/車要停哪/);

    const send = async text => {
      await page.getByLabel('輸入虛構旅客的問題').fill(text);
      await page.getByRole('button', { name: '送出' }).click();
      await expect(page.locator('.bubble.assistant').last()).not.toContainText('正在產生');
      await expect(page.getByRole('status')).toContainText(/示範回覆完成|已建立模擬人工轉交/);
    };
    await send('我想訂房');
    await send('2027-02-06');
    await send('2');
    await send('2');
    await send('0');
    await expect(page.locator('.bubble.assistant').last()).toContainText('需求編號');
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    expect(noOverflow).toBe(true);

    const owner = await ownerContext.newPage();
    await owner.goto(origin + '/operator');
    await owner.getByLabel('範例操作金鑰').fill(operatorToken);
    await owner.getByRole('button', { name: '登入', exact: true }).click();
    await expect(owner.getByText('2027-02-06 入住', { exact: true })).toBeVisible();
    await expect(owner.getByText('2 晚 · 2 位大人 · 0 位小孩', { exact: true })).toBeVisible();
  } finally {
    await ownerContext.close();
    await new Promise(resolveClose => server.close(resolveClose));
    store.close();
  }
});
