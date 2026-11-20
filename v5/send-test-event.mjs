import { createHmac, randomUUID } from 'node:crypto';

const messages = process.argv.slice(2);
const secret = process.env.V5_LINE_CHANNEL_SECRET;
const port = Number(process.env.V5_PORT ?? 8785);
if (!messages.length || !secret || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new TypeError('Set V5_LINE_CHANNEL_SECRET and pass one or more fictional messages as arguments');
}

const base = `http://127.0.0.1:${port}`;
const health = await fetch(base + '/health', { signal: AbortSignal.timeout(3000) });
if (!health.ok || (await health.json()).replyMode !== 'mock') {
  throw new Error('Only the local mock reply service can receive synthetic events');
}
const userId = randomUUID();
for (const text of messages) {
  const body = JSON.stringify({ events: [{
    type: 'message',
    mode: 'active',
    webhookEventId: randomUUID(),
    replyToken: randomUUID(),
    source: { type: 'user', userId },
    message: { type: 'text', text },
    deliveryContext: { isRedelivery: false },
  }] });
  const signature = createHmac('sha256', secret).update(body).digest('base64');
  const response = await fetch(base + '/webhooks/line', {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-Line-Signature': signature },
    signal: AbortSignal.timeout(5000),
  });
  console.log(`Webhook HTTP ${response.status}`);
  if (!response.ok) process.exitCode = 1;
}
