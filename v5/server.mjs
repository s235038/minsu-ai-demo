import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createAssistant, validateKnowledge } from './assistant.mjs';
import { parseLineEvents, verifyLineSignature } from './line.mjs';

const statuses = new Set(['new', 'in_progress', 'resolved']);
// LINE may redeliver events; allow a 24-hour replay window and five minutes of clock skew.
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const assets = new Map([
  ['/operator', ['operator.html', 'text/html']],
  ['/operator.css', ['operator.css', 'text/css']],
  ['/operator.mjs', ['operator.mjs', 'text/javascript']],
]);
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

async function readBody(request) {
  const limit = 64 * 1024;
  if (Number(request.headers['content-length']) > limit) throw new HttpError(413, 'body_too_large');
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function readJson(request) {
  const body = await readBody(request);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

const digest = token => createHash('sha256').update(token).digest();
const publicInquiry = ({ summary, ...metadata }) => ({ ...metadata, ...summary });

export function createV5Server({
  store, channelSecret, operatorToken, privacyKey, reply, provider, knowledge, mode = 'mock',
}) {
  const keyPattern = /^[A-Za-z0-9_-]{32,256}$/;
  if (!channelSecret || typeof reply !== 'function' ||
      !keyPattern.test(operatorToken ?? '') || !keyPattern.test(privacyKey ?? '') ||
      new Set([channelSecret, operatorToken, privacyKey]).size !== 3) {
    throw new TypeError('Use separate secrets and generate operator and privacy keys of at least 32 characters');
  }

  const operatorHash = digest(operatorToken);
  const baseKnowledge = validateKnowledge(knowledge);
  const assetBodies = new Map(Array.from(assets, ([path, [file, type]]) => [
    path, { type, body: readFileSync(new URL(file, import.meta.url)) },
  ]));
  const queues = new Map();
  const getKnowledge = () => store.getKnowledge() ?? baseKnowledge;
  const mask = (scope, identifier) =>
    createHmac('sha256', privacyKey).update(scope + '\0' + identifier).digest('hex');

  function isOperator(request) {
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(request.headers.authorization ?? '');
    return Boolean(match && timingSafeEqual(operatorHash, digest(match[1])));
  }

  async function processEvent(event, key) {
    const id = mask('line-event', event.id);
    if (!store.claimEvent(id)) return;

    let decision;
    let inquiry;
    let configuredKnowledge;
    try {
      configuredKnowledge = getKnowledge();
      const assist = createAssistant({ knowledge: configuredKnowledge, provider });
      decision = await assist({ text: event.text, state: store.getState(key) ?? {} });
      inquiry = store.commitDecision(id, key, decision.state, decision.inquiry);
    } catch {
      store.finishEvent(id, { outcome: 'failed', reason: 'processing_error', delivery: 'not_sent' });
      throw new Error('event_processing_failed');
    }

    let delivery = 'sent';
    try {
      const text = inquiry
        ? `${decision.reply}\n需求編號：${inquiry.id}\n${configuredKnowledge.contact}`
        : decision.reply;
      await reply({ replyToken: event.replyToken, text });
    } catch (error) {
      delivery = error?.kind === 'rejected' ? 'rejected' : 'uncertain';
    }
    store.finishEvent(id, { outcome: decision.outcome, reason: decision.reason, delivery });
  }

  function enqueue(event) {
    const key = mask('line-user', event.userId);
    const task = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => processEvent(event, key));
    queues.set(key, task);
    return task.finally(() => {
      if (queues.get(key) === task) queues.delete(key);
    });
  }

  async function handleWebhook(request, response) {
    const rawBody = await readBody(request);
    if (!verifyLineSignature(rawBody, request.headers['x-line-signature'], channelSecret)) {
      throw new HttpError(401, 'invalid_line_signature');
    }
    let events;
    try {
      events = parseLineEvents(rawBody);
    } catch {
      throw new HttpError(400, 'invalid_line_events');
    }
    const now = Date.now();
    if (events.some(event =>
      (event.timestamp === undefined && mode !== 'mock') ||
      (event.timestamp !== undefined &&
        (event.timestamp < now - MAX_EVENT_AGE_MS || event.timestamp > now + MAX_FUTURE_SKEW_MS)))) {
      throw new HttpError(400, 'stale_line_event');
    }
    const results = await Promise.allSettled(events.map(enqueue));
    if (results.some(result => result.status === 'rejected')) {
      throw new HttpError(503, 'event_processing_failed');
    }
    sendJson(response, 200, { received: events.length });
  }

  async function handleOperator(request, response, path) {
    if (!isOperator(request)) throw new HttpError(401, 'operator_auth_required');
    const { method } = request;

    if (method === 'GET' && path === '/api/inquiries') {
      return sendJson(response, 200, { inquiries: store.listInquiries().map(publicInquiry) });
    }
    if (method === 'GET' && path === '/api/metrics') {
      return sendJson(response, 200, { mode, metrics: store.metrics() });
    }
    if (path === '/api/knowledge') {
      if (method === 'GET') return sendJson(response, 200, { knowledge: getKnowledge() });
      if (method === 'PUT') {
        const body = await readJson(request);
        let updated;
        try {
          updated = validateKnowledge(body?.knowledge);
        } catch {
          throw new HttpError(400, 'invalid_knowledge');
        }
        store.saveKnowledge(updated);
        return sendJson(response, 200, { knowledge: updated });
      }
    }

    const record = /^\/api\/inquiries\/([a-f0-9-]{36})$/.exec(path);
    if (record && method === 'PATCH') {
      const body = await readJson(request);
      if (!statuses.has(body?.status)) throw new HttpError(400, 'invalid_status');
      const inquiry = store.setInquiryStatus(record[1], body.status);
      if (!inquiry) throw new HttpError(404, 'inquiry_not_found');
      return sendJson(response, 200, { inquiry: publicInquiry(inquiry) });
    }
    if (record && method === 'DELETE') {
      if (!store.deleteInquiry(record[1])) throw new HttpError(404, 'inquiry_not_found');
      response.writeHead(204, headers);
      return response.end();
    }
    throw new HttpError(404, 'not_found');
  }

  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/health') {
        return sendJson(response, 200, { status: 'ok', replyMode: mode, model: 'mock' });
      }
      const asset = assetBodies.get(path);
      if (request.method === 'GET' && asset) {
        response.writeHead(200, { ...headers, 'Content-Type': asset.type + '; charset=utf-8' });
        return response.end(asset.body);
      }
      if (request.method === 'POST' && path === '/webhooks/line') return await handleWebhook(request, response);
      if (path.startsWith('/api/')) return await handleOperator(request, response, path);
      throw new HttpError(404, 'not_found');
    } catch (error) {
      request.resume();
      if (response.headersSent || response.destroyed) return response.end();
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, { error: status === 500 ? 'internal_error' : error.message });
    }
  });
}
