const { expect, test } = require('@playwright/test');
const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const key = () => randomBytes(32).toString('base64url');

test('a signed LINE test event reaches two independent operator sessions', async ({ page, browser }) => {
  const { createV5Server } = await import('../server.mjs');
  const { createStore } = await import('../store.mjs');
  const knowledge = JSON.parse(readFileSync(resolve(__dirname, '../knowledge.demo.json'), 'utf8'));
  const operatorToken = key();
  const channelSecret = key();
  const replies = [];
  const store = createStore(':memory:');
  const server = createV5Server({
    store, knowledge, operatorToken, channelSecret, privacyKey: key(),
    reply: async ({ text }) => replies.push(text),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const other = await browser.newContext();

  async function signIn(tab) {
    await tab.goto(origin + '/operator');
    await tab.getByLabel('範例操作金鑰').fill(operatorToken);
    await tab.getByRole('button', { name: '登入', exact: true }).click();
    await expect(tab.getByRole('heading', { name: '住宿諮詢', exact: true })).toBeVisible();
  }

  try {
    await signIn(page);
    const second = await other.newPage();
    await signIn(second);
    await expect(page.getByText('目前沒有諮詢。')).toBeVisible();

    // An owner can change approved house rules without touching JSON.
    // Preserve rooms, facilities and custom FAQ when another window is open.
    await page.getByLabel('入住時間').fill('16:00');
    await page.getByLabel('停車說明').fill('停車請先至入口右側空地，詳細配置請洽櫃台。');
    await page.getByRole('button', { name: '儲存常用館規' }).click();
    await expect(page.getByRole('status')).toHaveText('常用館規已儲存；新諮詢將使用更新後的內容。');
    const savedResponse = await fetch(origin + '/api/knowledge', {
      headers: { Authorization: 'Bearer ' + operatorToken },
    });
    expect(savedResponse.status).toBe(200);
    const saved = (await savedResponse.json()).knowledge;
    expect(saved.checkIn).toBe('16:00');
    expect(saved.parking).toContain('入口右側空地');
    expect(saved.rooms).toEqual(knowledge.rooms);
    expect(saved.faq).toEqual(knowledge.faq);
    await expect(page.locator('#knowledge')).toHaveValue(/入口右側空地/);

    const raw = JSON.stringify({ events: [{
      type: 'message', webhookEventId: randomUUID(), replyToken: randomUUID(),
      source: { type: 'user', userId: randomUUID() },
      message: { type: 'text', text: '2027-02-06，２ 晚，2 位大人，0 位小孩' },
    }] });
    const signature = createHmac('sha256', channelSecret).update(raw).digest('base64');
    const incoming = await fetch(origin + '/webhooks/line', {
      method: 'POST', body: raw, headers: { 'X-Line-Signature': signature },
    });
    expect(incoming.status).toBe(200);
    expect(replies[0]).toContain('需求編號');

    const parkingRaw = JSON.stringify({ events: [{
      type: 'message', webhookEventId: randomUUID(), replyToken: randomUUID(),
      source: { type: 'user', userId: randomUUID() },
      message: { type: 'text', text: '請問停車位置在哪裡？' },
    }] });
    const parkingSignature = createHmac('sha256', channelSecret).update(parkingRaw).digest('base64');
    const parkingRequest = await fetch(origin + '/webhooks/line', {
      method: 'POST', body: parkingRaw, headers: { 'X-Line-Signature': parkingSignature },
    });
    expect(parkingRequest.status).toBe(200);
    expect(replies.at(-1)).toContain('入口右側空地');

    const refresh = tab => tab.getByRole('button', { name: '更新清單與指標' }).click();
    await refresh(page);
    await expect(page.getByText('2027-02-06 入住', { exact: true })).toBeVisible();
    await expect(page.getByText('2 晚 · 2 位大人 · 0 位小孩', { exact: true })).toBeVisible();
    await page.getByLabel('處理狀態').selectOption('in_progress');
    await page.getByRole('button', { name: '更新狀態' }).click();
    await expect(page.getByRole('status')).toHaveText('處理狀態已更新。');

    await refresh(second);
    await expect(second.getByLabel('處理狀態')).toHaveValue('in_progress');
    second.once('dialog', dialog => dialog.accept());
    await second.getByRole('button', { name: '刪除詢問' }).click();
    await expect(second.getByRole('status')).toHaveText('諮詢已刪除。');
    await refresh(page);
    await expect(page.getByText('目前沒有諮詢。')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    await page.getByRole('button', { name: '登出' }).click();
    await expect(page.getByLabel('範例操作金鑰')).toBeVisible();
  } finally {
    await other.close();
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});
