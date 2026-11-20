import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createV5Server } from './server.mjs';
import { createStore } from './store.mjs';

const key = () => randomBytes(32).toString('base64url');
const channelSecret = key();
const operatorToken = key();
const store = createStore(':memory:');
const replies = [];
const knowledge = JSON.parse(readFileSync(new URL('knowledge.demo.json', import.meta.url), 'utf8'));
const server = createV5Server({
  store, knowledge, channelSecret, operatorToken, privacyKey: key(),
  reply: async ({ text }) => replies.push(text),
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;

const sessions = [
  { name: '多題口語', turns: [['車要停哪，有狗可以帶去嗎？', [/車位/,/寵物/]]], faqOnly: true },
  { name: '入住退房', turns: [['幾點入住？何時退房？', [/15:00/,/11:00/]]], faqOnly: true },
  { name: '未收錄轉交', turns: [['附近浮潛能代辦嗎？', [/人工回覆/,/需求編號/]]], handoff: true },
  { name: '無報價承諾', turns: [['能保證房價 500 元嗎？', [/人工回覆/,/需求編號/]]], handoff: true },
  { name: '多輪入住需求', turns: [
      ['想住下週日', [/完整入住日期/]],
      ['2027-02-06，２晚，2位大人', [/幾位小孩/]],
      ['0', [/人工回覆/,/需求編號/]],
    ], handoff: true, completesInquiry: true },
];
const results = [];
try {
  for (const session of sessions) {
    const userId = randomUUID();
    let matched = 0;
    for (const [text, expectations] of session.turns) {
      const raw = JSON.stringify({ events: [{
        type: 'message', webhookEventId: randomUUID(), replyToken: randomUUID(),
        source: { type: 'user', userId }, message: { type: 'text', text },
      }] });
      const signature = createHmac('sha256', channelSecret).update(raw).digest('base64');
      const before = replies.length;
      const response = await fetch(origin + '/webhooks/line', {
        method: 'POST', body: raw, headers: { 'X-Line-Signature': signature },
      });
      const reply = replies.at(-1);
      if (response.ok && replies.length === before + 1 &&
          expectations.every(pattern => pattern.test(reply)) && !/500 元|訂房成功|保證空房/.test(reply)) matched += 1;
    }
    results.push({ ...session, matched, lastReply: replies.at(-1) });
  }
  const records = await fetch(origin + '/api/inquiries', { headers: { Authorization: `Bearer ${operatorToken}` } });
  const { inquiries } = await records.json();
  const matched = results.reduce((total, result) => total + result.matched, 0);
  const turnCount = results.reduce((total, result) => total + result.turns.length, 0);
  const handoffs = results.filter(result => result.handoff);
  const queued = result => inquiries.find(inquiry => result.lastReply?.includes(inquiry.id));
  const successfulHandoffs = handoffs.filter(queued).length;
  const completionCandidates = results.filter(result => result.completesInquiry);
  const completions = completionCandidates.filter(result => {
    const inquiry = queued(result);
    return inquiry?.date === '2027-02-06' && inquiry.nights === 2 && inquiry.adults === 2 && inquiry.children === 0;
  }).length;
  const handledFaq = results.filter(result => result.faqOnly && result.matched === result.turns.length).length;
  const failures = results.filter(result => result.matched !== result.turns.length).map(result => result.name);
  console.log(JSON.stringify({
    sample: 'synthetic fixtures, no customer results',
    replyChecks: { matched, total: turnCount },
    operatorHandoffs: { queued: successfulHandoffs, expected: handoffs.length },
    completeInquiries: { completed: completions, expected: completionCandidates.length },
    failedScenarios: failures,
    routingReasons: store.metrics().reasons,
    savingsEstimate: {
      manualSecondsPerFaq: 90, reviewSecondsPerFaq: 30,
      matchingFaqs: handledFaq, hypotheticalSeconds: handledFaq * (90 - 30),
    },
  }, null, 2));
  if (failures.length || successfulHandoffs !== handoffs.length || completions !== completionCandidates.length) {
    process.exitCode = 1;
  }
} finally {
  await new Promise(resolve => server.close(resolve));
  store.close();
}
