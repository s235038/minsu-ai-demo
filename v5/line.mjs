import { createHmac, timingSafeEqual } from 'node:crypto';

const REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const WEBHOOK_TEXT_LIMIT = 5000;
const REQUEST_TIMEOUT_MS = 5000;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
}

function isMessageText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= WEBHOOK_TEXT_LIMIT;
}

export function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!(rawBody instanceof Uint8Array) || typeof channelSecret !== 'string' || !channelSecret ||
      typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) {
    return false;
  }
  const received = Buffer.from(signature, 'base64');
  if (received.toString('base64') !== signature) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest();
  return timingSafeEqual(expected, received);
}

function invalidWebhook() {
  return new TypeError('Invalid LINE webhook payload');
}

export function parseLineEvents(rawBody) {
  let payload;
  try {
    payload = JSON.parse(textDecoder.decode(rawBody));
  } catch {
    throw invalidWebhook();
  }
  if (!isRecord(payload) || !Array.isArray(payload.events) ||
      (payload.destination !== undefined && !isIdentifier(payload.destination))) {
    throw invalidWebhook();
  }

  const supportedEvents = [];
  for (const event of payload.events) {
    if (!isRecord(event) || !isIdentifier(event.type)) throw invalidWebhook();
    if (event.type !== 'message' || event.mode === 'standby') continue;
    if ((event.mode !== undefined && event.mode !== 'active') ||
        !isRecord(event.source) || !isIdentifier(event.source.type) ||
        !isRecord(event.message) || !isIdentifier(event.message.type)) {
      throw invalidWebhook();
    }
    if (event.source.type !== 'user' || event.message.type !== 'text') continue;

    const { webhookEventId: id, replyToken, deliveryContext, timestamp } = event;
    const { userId } = event.source;
    const { text } = event.message;
    if (!isIdentifier(id) || !isIdentifier(replyToken) || !isIdentifier(userId) || !isMessageText(text) ||
        (deliveryContext !== undefined &&
          (!isRecord(deliveryContext) || typeof deliveryContext.isRedelivery !== 'boolean'))) {
      throw invalidWebhook();
    }
    if (timestamp !== undefined && (!Number.isSafeInteger(timestamp) || timestamp < 0)) throw invalidWebhook();
    supportedEvents.push({ id, replyToken, userId, text, redelivered: deliveryContext?.isRedelivery ?? false,
      ...(timestamp === undefined ? {} : { timestamp }) });
  }
  return supportedEvents;
}

export class LineReplyError extends Error {
  constructor(kind) {
    super(kind === 'rejected' ? 'LINE reply rejected' : 'LINE reply delivery uncertain');
    this.name = 'LineReplyError';
    this.kind = kind;
  }
}

export function createLineReply({ accessToken, fetchImpl = fetch }) {
  if (typeof accessToken !== 'string' || !accessToken || !/^[\x21-\x7e]+$/.test(accessToken)) {
    throw new TypeError('Invalid LINE reply configuration');
  }

  return async function reply({ replyToken, text }) {
    if (!isIdentifier(replyToken) || !isMessageText(text)) throw new LineReplyError('rejected');

    let response;
    try {
      response = await fetchImpl(REPLY_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new LineReplyError('uncertain');
    }
    if (response.body) await response.body.cancel().catch(() => {});
    if (response.ok) return;
    const rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
    // Reply tokens are single-use. The caller records uncertainty rather than attempting a second send.
    throw new LineReplyError(rejected ? 'rejected' : 'uncertain');
  };
}
