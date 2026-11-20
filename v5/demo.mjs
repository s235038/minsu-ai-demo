// Localhost-only synthetic tour. Never use this entry point for real guests.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createMockProvider } from './assistant.mjs';
import { createV5Server } from './server.mjs';
import { createStore } from './store.mjs';

const portText = process.env.V5_DEMO_PORT ?? '8785';
if (!/^(?:0|[1-9][0-9]{0,4})$/.test(portText) || Number(portText) > 65535) {
  throw new TypeError('V5_DEMO_PORT must be 0 or a valid local port');
}
const key = () => randomBytes(32).toString('base64url');
const channelSecret = key();
const operatorToken = key();
const privacyKey = key();
const knowledge = JSON.parse(readFileSync(new URL('knowledge.demo.json', import.meta.url), 'utf8'));
const store = createStore(':memory:');
const server = createV5Server({
  store, knowledge, channelSecret, operatorToken, privacyKey, mode: 'mock',
  provider: createMockProvider(),
  reply: async () => {}, // No real LINE account, network calls or message costs.
});

const close = () => server.close(() => store.close());
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, close);

try {
  server.listen(Number(portText), '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const endpoint = 'http://127.0.0.1:' + port;
  const guest = 'synthetic-local-demo-visitor';
  const turns = ['我想訂房', '2027-02-06', '2', '2', '0'];

  for (const text of turns) {
    const raw = JSON.stringify({
      events: [{
        type: 'message', mode: 'active', webhookEventId: randomUUID(), replyToken: randomUUID(),
        source: { type: 'user', userId: guest }, message: { type: 'text', text },
        deliveryContext: { isRedelivery: false },
      }],
    });
    const signature = createHmac('sha256', channelSecret).update(raw).digest('base64');
    const response = await fetch(endpoint + '/webhooks/line', {
      method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': signature },
    });
    if (!response.ok) throw new Error('Synthetic demo event failed');
  }

  console.log('\n=== V5 本機安全試用（Windows / macOS / Linux）===');
  console.log('這是模擬 LINE、模擬問答，不是正式 AI 或 LINE 串接。');
  console.log('僅在這部電腦的 127.0.0.1 開啟；未使用真實個資。');
  console.log('已產生一筆虛構的住宿諮詢。');
  console.log('工作台：' + endpoint + '/operator');
  console.log('本次臨時登入金鑰：' + operatorToken);
  console.log('瀏覽器登入後可查看、更新及刪除示範案件。關閉終端機即結束試用且資料消失。');
  console.log('請不要把本機網址或登入金鑰傳給客戶。');
  console.log('V5_DEMO_READY PORT=' + port);
} catch {
  console.error('V5 示範無法啟動。請檢查本機埠號、Node 版本與程式檔案。');
  close();
  process.exitCode = 1;
}
