import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createStore } from '../store.mjs';

const key = () => randomBytes(32).toString('hex');

test('retention keeps active cases and removes only old completed orphan events', () => {
  const store = createStore(':memory:');
  try {
    const oldEvent = key();
    const liveEvent = key();
    const pendingEvent = key();
    const user = key();
    assert.equal(store.claimEvent(oldEvent), true);
    assert.equal(store.claimEvent(liveEvent), true);
    assert.equal(store.claimEvent(pendingEvent), true);
    const oldCase = store.commitDecision(oldEvent, user, {}, { date: '2027-02-06', nights: 2, adults: 2 });
    store.finishEvent(oldEvent, { outcome: 'handoff', reason: 'human_needed', delivery: 'sent' });
    const activeCase = store.commitDecision(liveEvent, user, {}, { date: '2027-02-07', nights: 1, adults: 1 });
    store.finishEvent(liveEvent, { outcome: 'handoff', reason: 'human_needed', delivery: 'sent' });
    store.setInquiryStatus(oldCase.id, 'resolved');
    const future = Date.now() + 31 * 86400000;
    const result = store.pruneRetention({ now: future, resolvedDays: 30, eventDays: 30 });
    assert.equal(result.inquiries, 1);
    assert.equal(result.events, 1);
    assert.equal(store.listInquiries().length, 1);
    assert.equal(store.listInquiries()[0].id, activeCase.id);
    assert.equal(store.claimEvent(liveEvent), false);
    assert.equal(store.claimEvent(pendingEvent), false);
    assert.equal(store.claimEvent(oldEvent), true);
    assert.throws(() => store.pruneRetention({ resolvedDays: 0 }), TypeError);
  } finally {
    store.close();
  }
});
