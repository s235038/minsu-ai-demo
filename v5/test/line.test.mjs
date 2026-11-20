import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createLineReply, LineReplyError, parseLineEvents, verifyLineSignature } from '../line.mjs';

function webhook(events) {
  return Buffer.from(JSON.stringify({ destination: 'test-bot', events }));
}

function textEvent(overrides = {}) {
  return {
    type: 'message',
    mode: 'active',
    webhookEventId: 'event-1',
    replyToken: 'synthetic-reply-token',
    source: { type: 'user', userId: 'synthetic-user' },
    message: { type: 'text', text: '停車與入住時間？' },
    deliveryContext: { isRedelivery: true },
    ...overrides,
  };
}

test('validates the canonical signature against the exact UTF-8 bytes sent by LINE', () => {
  const secret = 'synthetic-secret';
  const raw = webhook([textEvent()]);
  const signature = createHmac('sha256', secret).update(raw).digest('base64');
  assert.equal(verifyLineSignature(raw, signature, secret), true);
  assert.equal(verifyLineSignature(Buffer.concat([raw, Buffer.from('\n')]), signature, secret), false);
  assert.equal(verifyLineSignature(raw, signature, 'different-secret'), false);
  assert.equal(verifyLineSignature(raw, `${signature}\n`, secret), false);
  assert.equal(verifyLineSignature(raw, 'not-a-signature', secret), false);
  assert.equal(verifyLineSignature(raw, undefined, secret), false);
  assert.equal(verifyLineSignature(raw.toString(), signature, secret), false);
});

test('accepts bot verification and extracts only active one-to-one text events', () => {
  assert.deepEqual(parseLineEvents(webhook([])), []);
  assert.deepEqual(parseLineEvents(webhook([
    { type: 'follow' },
    textEvent({ source: { type: 'group', groupId: 'synthetic-group' } }),
    textEvent({ message: { type: 'image' } }),
    textEvent({ mode: 'standby', replyToken: undefined }),
    textEvent(),
  ])), [{
    id: 'event-1',
    replyToken: 'synthetic-reply-token',
    userId: 'synthetic-user',
    text: '停車與入住時間？',
    redelivered: true,
  }]);
});

test('rejects malformed JSON, envelope and supported events without echoing webhook contents', () => {
  const invalid = [
    Buffer.from([0xff]),
    Buffer.from('{'),
    Buffer.from('{"events":"synthetic-private-content"}'),
    webhook([null]),
    webhook([textEvent({ webhookEventId: undefined })]),
    webhook([textEvent({ source: { type: 'user' } })]),
    webhook([textEvent({ deliveryContext: { isRedelivery: 'false' } })]),
    webhook([textEvent({ message: { type: 'text', text: 'a'.repeat(5001) } })]),
  ];
  for (const raw of invalid) {
    assert.throws(() => parseLineEvents(raw), { name: 'TypeError', message: 'Invalid LINE webhook payload' });
  }
});

test('posts one plaintext reply to the fixed endpoint with a timeout and no redirect', async () => {
  const requests = [];
  const send = createLineReply({
    accessToken: 'synthetic-access-token',
    fetchImpl: async (url, request) => {
      requests.push({ url, request });
      return new Response('{}');
    },
  });
  await send({ replyToken: 'synthetic-reply-token', text: '停車場在入口旁。' });
  assert.equal(requests.length, 1);
  const [{ url, request }] = requests;
  assert.equal(url, 'https://api.line.me/v2/bot/message/reply');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer synthetic-access-token');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(request.redirect, 'error');
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.body), {
    replyToken: 'synthetic-reply-token',
    messages: [{ type: 'text', text: '停車場在入口旁。' }],
  });
});

test('classifies API failures without retrying or exposing response content', async () => {
  const cases = [
    { status: 400, kind: 'rejected' },
    { status: 429, kind: 'rejected' },
    { status: 408, kind: 'uncertain' },
    { status: 503, kind: 'uncertain' },
    { kind: 'uncertain' },
  ];
  for (const { status, kind } of cases) {
    let calls = 0;
    const send = createLineReply({
      accessToken: 'synthetic-access-token',
      fetchImpl: async () => {
        calls += 1;
        if (!status) throw new Error('synthetic-private-content');
        return new Response('synthetic-private-content', { status });
      },
    });
    await assert.rejects(send({ replyToken: 'synthetic-reply-token', text: '虛構回覆' }), error => {
      assert.ok(error instanceof LineReplyError);
      assert.equal(error.kind, kind);
      assert.doesNotMatch(String(error), /synthetic/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('rejects an invalid reply locally before contacting LINE', async () => {
  let calls = 0;
  const send = createLineReply({
    accessToken: 'synthetic-access-token',
    fetchImpl: async () => { calls += 1; },
  });
  await assert.rejects(send({ replyToken: '', text: '回覆' }), { kind: 'rejected' });
  await assert.rejects(send({ replyToken: 'synthetic-reply-token', text: '' }), { kind: 'rejected' });
  assert.equal(calls, 0);
});
