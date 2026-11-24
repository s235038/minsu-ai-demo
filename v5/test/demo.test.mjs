import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const demoScript = fileURLToPath(new URL('../demo.mjs', import.meta.url));

test('one-command localhost demo seeds a synthetic case without real LINE credentials', { timeout: 20_000 }, async t => {
  const child = spawn(process.execPath, [demoScript], {
    env: { ...process.env, V5_DEMO_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Local demo did not start')), 12_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const port = /V5_DEMO_READY PORT=(\d+)/u.exec(output)?.[1];
      const token = /本次臨時登入金鑰：([A-Za-z0-9_-]{32,256})/u.exec(output)?.[1];
      if (port && token) {
        clearTimeout(timeout);
        resolve({ port, token, output });
      }
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error('Local demo exited early (' + code + ')'));
    });
  });
  const { port, token, output } = await ready;
  assert.match(output, /模擬 LINE、模擬問答/u);
  assert.match(output, /127\.0\.0\.1/u);
  const endpoint = 'http://127.0.0.1:' + port;
  const status = await (await fetch(endpoint + '/health')).json();
  assert.equal(status.model, 'mock');
  assert.equal(status.replyMode, 'mock');
  assert.equal((await fetch(endpoint + '/api/inquiries')).status, 401);
  const response = await fetch(endpoint + '/api/inquiries', {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(response.status, 200);
  const { inquiries } = await response.json();
  assert.equal(inquiries.length, 1);
  assert.deepEqual({ date: inquiries[0].date, nights: inquiries[0].nights,
    adults: inquiries[0].adults, children: inquiries[0].children }, {
    date: '2027-02-06', nights: 2, adults: 2, children: 0,
  });

  // Guest chat is real mock API interaction, not a hard-coded front-end transcript.
  const guestPage = await fetch(endpoint + '/demo/guest');
  assert.equal(guestPage.status, 200);
  assert.match(await guestPage.text(), /旅客提問模擬器/u);
  const sessionId = randomUUID();
  const send = async text => fetch(endpoint + '/demo/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: endpoint },
    body: JSON.stringify({ sessionId, text }),
  });
  const parking = await send('車要停哪？可以帶狗狗嗎？');
  assert.equal(parking.status, 200);
  const parkingData = await parking.json();
  assert.match(parkingData.reply, /車位/u);
  assert.match(parkingData.reply, /寵物/u);
  for (const [question, expected] of [
    ['我想訂房', 'clarification'],
    ['2027-02-06', 'clarification'],
    ['2', 'clarification'],
    ['2', 'clarification'],
    ['0', 'handoff'],
  ]) {
    const response = await send(question);
    const payloadText = await response.text();
    assert.equal(response.status, 200, `Question "${question}" failed: ${payloadText}`);
    const payload = JSON.parse(payloadText);
    assert.equal(payload.outcome, expected);
    if (expected === 'handoff') assert.match(payload.reply, /需求編號/u);
  }
  const after = await fetch(endpoint + '/api/inquiries', {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(after.status, 200);
  const all = (await after.json()).inquiries;
  assert.equal(all.length, 2);
  assert.deepEqual({
    date: all[0].date, nights: all[0].nights, adults: all[0].adults, children: all[0].children,
  }, { date: '2027-02-06', nights: 2, adults: 2, children: 0 });

  const malformed = await fetch(endpoint + '/demo/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, text: '' }),
  });
  assert.equal(malformed.status, 400);
  const crossSite = await fetch(endpoint + '/demo/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid' },
    body: JSON.stringify({ sessionId, text: '入住時間？' }),
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await fetch(endpoint + '/api/inquiries')).status, 401);
});
