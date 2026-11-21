import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createStore } from '../store.mjs';

const key = () => randomBytes(32).toString('hex');

test('retention survives SQLite restart without deleting active cases or pending events', () => {
  const directory = mkdtempSync(join(tmpdir(), 'v5-retention-'));
  const filename = join(directory, 'pilot.sqlite');
  const oldEvent = key();
  const activeEvent = key();
  const pendingEvent = key();
  const user = key();
  let resolvedId;
  let activeId;
  try {
    const first = createStore(filename);
    try {
      for (const id of [oldEvent, activeEvent, pendingEvent]) {
        assert.equal(first.claimEvent(id), true);
      }
      resolvedId = first.commitDecision(oldEvent, user, {}, { adults: 2 }).id;
      activeId = first.commitDecision(activeEvent, user, {}, { adults: 1 }).id;
      first.finishEvent(oldEvent, { outcome: 'handoff', reason: 'human_needed', delivery: 'sent' });
      first.finishEvent(activeEvent, { outcome: 'handoff', reason: 'human_needed', delivery: 'sent' });
      first.setInquiryStatus(resolvedId, 'resolved');
    } finally {
      first.close();
    }

    const second = createStore(filename);
    try {
      assert.equal(second.listInquiries().length, 2);
      const now = Date.now() + 31 * 86400000;
      const result = second.pruneRetention({ now, resolvedDays: 30, eventDays: 30 });
      assert.equal(result.inquiries, 1);
      assert.equal(result.events, 1);
      assert.deepEqual(second.listInquiries().map(row => row.id), [activeId]);
      assert.equal(second.claimEvent(activeEvent), false);
      assert.equal(second.claimEvent(pendingEvent), false);
    } finally {
      second.close();
    }

    const third = createStore(filename);
    try {
      assert.deepEqual(third.listInquiries().map(row => row.id), [activeId]);
      assert.equal(third.claimEvent(activeEvent), false);
      assert.equal(third.claimEvent(pendingEvent), false);
      // Once an event is intentionally pruned, its old deduplication key is gone.
      // A replay outside the retention window must be controlled upstream.
      assert.equal(third.claimEvent(oldEvent), true);
    } finally {
      third.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
