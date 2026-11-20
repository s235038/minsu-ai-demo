import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const outcomes = ['answered', 'clarification', 'handoff', 'failed'];
const deliveries = ['sent', 'rejected', 'uncertain', 'not_sent'];
const statuses = ['new', 'in_progress', 'resolved'];
const conversationTtl = 24 * 60 * 60 * 1000;
const machineKey = /^[a-f0-9]{64}$/u;
const reasonCode = /^[a-z][a-z0-9_]{0,63}$/u;

function validDate(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().startsWith(value + 'T');
}

function safeSummary(input) {
  const summary = {};
  if (!input || typeof input !== 'object') return summary;
  if (Object.hasOwn(input, 'date') && validDate(input.date)) summary.date = input.date;
  for (const field of ['nights', 'adults', 'children']) {
    const minimum = field === 'children' ? 0 : 1;
    if (Object.hasOwn(input, field) && Number.isInteger(input[field])
        && input[field] >= minimum && input[field] <= 30) {
      summary[field] = input[field];
    }
  }
  return summary;
}

function requireKey(value) {
  if (typeof value !== 'string' || !machineKey.test(value)) {
    throw new TypeError('Expected an opaque 256-bit key');
  }
}

function inquiryRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    summary: JSON.parse(row.summary),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function groupedCounts(rows, keys) {
  const counts = Object.fromEntries(keys.map(key => [key, 0]));
  for (const { label, count } of rows) counts[label] = count;
  return counts;
}

export function createStore(filename) {
  // Restrict new files to the service account. An operator controls existing file permissions.
  if (filename !== ':memory:') closeSync(openSync(filename, 'a', 0o600));
  const db = new DatabaseSync(filename);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;

      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        decided INTEGER NOT NULL DEFAULT 0 CHECK (decided IN (0, 1)),
        outcome TEXT CHECK (outcome IN ('answered', 'clarification', 'handoff', 'failed')),
        reason TEXT,
        delivery TEXT CHECK (delivery IN ('sent', 'rejected', 'uncertain', 'not_sent'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS conversations_expiry ON conversations(expires_at);
      CREATE TABLE IF NOT EXISTS inquiries (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS inquiries_created ON inquiries(created_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        document TEXT NOT NULL
      ) STRICT;
      COMMIT;
    `);
    // Legacy databases have no event creation timestamp; do not guess their age.
    if (!db.prepare('PRAGMA table_info(events)').all().some(row => row.name === 'created_at')) {
      db.exec('ALTER TABLE events ADD COLUMN created_at INTEGER');
    }

    const claim = db.prepare('INSERT INTO events (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING');
    const decide = db.prepare('UPDATE events SET decided = 1 WHERE id = ? AND decided = 0 AND outcome IS NULL');
    const finish = db.prepare('UPDATE events SET outcome = ?, reason = ?, delivery = ? WHERE id = ? AND outcome IS NULL');
    const readState = db.prepare('SELECT state FROM conversations WHERE id = ? AND expires_at > ?');
    const writeState = db.prepare(`
      INSERT INTO conversations (id, state, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at
    `);
    const expireStates = db.prepare('DELETE FROM conversations WHERE expires_at <= ?');
    const eraseState = db.prepare('DELETE FROM conversations WHERE id = ?');
    const insertInquiry = db.prepare(`
      INSERT INTO inquiries (id, event_id, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `);
    const readInquiryByEvent = db.prepare('SELECT * FROM inquiries WHERE event_id = ?');
    const readInquiries = db.prepare('SELECT * FROM inquiries ORDER BY created_at DESC, rowid DESC LIMIT 100');
    const changeStatus = db.prepare('UPDATE inquiries SET status = ?, updated_at = ? WHERE id = ? RETURNING *');
    const eraseInquiry = db.prepare('DELETE FROM inquiries WHERE id = ?');
    const purgeResolved = db.prepare("DELETE FROM inquiries WHERE status = 'resolved' AND updated_at < ?");
    const purgeEvents = db.prepare('DELETE FROM events WHERE created_at IS NOT NULL AND created_at < ? AND outcome IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inquiries WHERE inquiries.event_id = events.id)');
    const purgeStates = db.prepare('DELETE FROM conversations WHERE expires_at <= ?');
    const readKnowledge = db.prepare('SELECT document FROM knowledge WHERE singleton = 1');
    const writeKnowledge = db.prepare(`
      INSERT INTO knowledge (singleton, document) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET document = excluded.document
    `);
    const eventCount = db.prepare('SELECT count(*) AS received, count(*) - count(outcome) AS inFlight FROM events');
    const outcomeCounts = db.prepare('SELECT outcome AS label, count(*) AS count FROM events WHERE outcome IS NOT NULL GROUP BY outcome');
    const deliveryCounts = db.prepare('SELECT delivery AS label, count(*) AS count FROM events WHERE delivery IS NOT NULL GROUP BY delivery');
    const reasonCounts = db.prepare('SELECT reason AS label, count(*) AS count FROM events WHERE reason IS NOT NULL GROUP BY reason');
    const inquiryCounts = db.prepare('SELECT status AS label, count(*) AS count FROM inquiries GROUP BY status');

    function saveState(key, input) {
      requireKey(key);
      const state = safeSummary(input);
      if (input && Object.hasOwn(input, 'active') && input.active === true) state.active = true;
      const now = Date.now();
      expireStates.run(now);
      if (Object.keys(state).length) writeState.run(key, JSON.stringify(state), now + conversationTtl);
      else eraseState.run(key);
    }

    function createInquiry(eventId, input) {
      requireKey(eventId);
      const now = Date.now();
      insertInquiry.run(randomUUID(), eventId, JSON.stringify(safeSummary(input)), now, now);
      return inquiryRecord(readInquiryByEvent.get(eventId));
    }

    return {
      claimEvent(id) {
        requireKey(id);
        return claim.run(id, Date.now()).changes === 1;
      },
      commitDecision(id, key, state, inquiry) {
        requireKey(id);
        db.exec('BEGIN IMMEDIATE');
        try {
          if (decide.run(id).changes !== 1) throw new RangeError('Event cannot accept a decision');
          saveState(key, state);
          const record = inquiry == null ? null : createInquiry(id, inquiry);
          db.exec('COMMIT');
          return record;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      finishEvent(id, { outcome, reason, delivery }) {
        requireKey(id);
        if (!outcomes.includes(outcome) || !deliveries.includes(delivery)
            || typeof reason !== 'string' || !reasonCode.test(reason)) {
          throw new TypeError('Invalid event result');
        }
        return finish.run(outcome, reason, delivery, id).changes === 1;
      },
      getState(key) {
        requireKey(key);
        const row = readState.get(key, Date.now());
        return row ? JSON.parse(row.state) : null;
      },
      saveState,
      createInquiry,
      listInquiries() {
        return readInquiries.all().map(inquiryRecord);
      },
      setInquiryStatus(id, status) {
        if (!statuses.includes(status)) throw new TypeError('Invalid inquiry status');
        return inquiryRecord(changeStatus.get(status, Date.now(), id));
      },
      deleteInquiry(id) {
        return eraseInquiry.run(id).changes === 1;
      },
      pruneRetention({ now = Date.now(), resolvedDays = 30, eventDays = 30 } = {}) {
        if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(resolvedDays)
            || resolvedDays < 1 || resolvedDays > 3650 || !Number.isSafeInteger(eventDays)
            || eventDays < 1 || eventDays > 3650) throw new TypeError('Invalid retention settings');
        const resolvedCutoff = now - resolvedDays * 86400000;
        const eventCutoff = now - eventDays * 86400000;
        db.exec('BEGIN IMMEDIATE');
        try {
          const conversations = purgeStates.run(now).changes;
          const inquiries = purgeResolved.run(resolvedCutoff).changes;
          const events = purgeEvents.run(eventCutoff).changes;
          db.exec('COMMIT');
          return { conversations, inquiries, events };
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      getKnowledge() {
        const row = readKnowledge.get();
        return row ? JSON.parse(row.document) : null;
      },
      saveKnowledge(knowledge) {
        writeKnowledge.run(JSON.stringify(knowledge));
      },
      metrics() {
        return {
          ...eventCount.get(),
          outcomes: groupedCounts(outcomeCounts.all(), outcomes),
          deliveries: groupedCounts(deliveryCounts.all(), deliveries),
          reasons: groupedCounts(reasonCounts.all(), []),
          inquiries: groupedCounts(inquiryCounts.all(), statuses),
        };
      },
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
