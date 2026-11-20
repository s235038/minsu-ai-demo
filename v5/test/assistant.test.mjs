import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAssistant, validateKnowledge } from '../assistant.mjs';

const knowledge = JSON.parse(readFileSync(new URL('../knowledge.demo.json', import.meta.url), 'utf8'));

test('a model adapter can select approved facts without contributing reply prose', async () => {
  const assistant = createAssistant({
    knowledge,
    provider: {
      async classify({ topics }) {
        assert.equal(Object.hasOwn(topics[0], 'answer'), false);
        return { topicIds: ['parking', 'invented-price'], reply: '保證價格 999 元' };
      },
    },
  });
  const decision = await assistant({ text: '請介紹停車資訊' });
  assert.equal(decision.reply, knowledge.parking);
  assert.equal(decision.outcome, 'answered');
});

test('partial and range quantities remain unknown until clarified', async () => {
  const assistant = createAssistant({ knowledge });
  const initial = await assistant({ text: '2027-02-06，住 2 或 3 晚，兩位大人' });
  assert.equal(initial.reason, 'missing_nights');
  assert.equal(initial.state.adults, 2);
  assert.equal(Object.hasOwn(initial.state, 'nights'), false);
  const followup = await assistant({ text: '２', state: initial.state });
  assert.equal(followup.reason, 'missing_children');
  assert.equal(followup.state.nights, 2);
  const completed = await assistant({ text: '沒有小孩', state: followup.state });
  assert.equal(completed.reason, 'lodging_summary');
  assert.deepEqual(completed.inquiry, { date: '2027-02-06', nights: 2, adults: 2, children: 0 });
});

test('knowledge validates stable approved fields and refuses duplicate FAQ identifiers', () => {
  assert.deepEqual(validateKnowledge(knowledge), knowledge);
  assert.throws(() => validateKnowledge({ ...knowledge, checkIn: '25:00' }), TypeError);
  assert.throws(() => validateKnowledge({
    ...knowledge, faq: [...knowledge.faq, { id: 'parking', keywords: ['車'], answer: '請洽櫃台' }],
  }), TypeError);
});
