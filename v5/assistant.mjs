const reservedTopics = new Set(['rooms', 'check-in', 'check-out', 'parking', 'pets', 'facilities', 'contact']);
const unverifiedRequest = /空房|有房|還有.{0,6}房|房況|房價|價格|價錢|報價|多少錢|多少元|幾塊|費用|折扣|退款|退費|付款|訂金|取消訂房|確認訂房|預訂成功|訂房成功|代.{0,2}訂房|保留房|refund|availability|price|payment/iu;
const misleadingFact = /空房|有房|房況|房價|價格|價錢|報價|費用|折扣|退款|退費|付款|訂金|訂房成功|預訂成功|保留房|免費|[$＄]|(?:NTD|TWD|NT)\s*\d|\d\s*(?:元|塊)|\b(?:free|refund|price|payment|available)\b/iu;
const humanRequest = /真人|人工|轉接|櫃台人員|客服人員|human agent/iu;
const lodgingRequest = /住宿需求|想訂房|要訂房|想預訂|要預訂|想住宿|要住宿|想住(?!宿規則)|要住(?!宿規則)|打算入住|預計入住|住\s*\d+\s*晚/u;
const injectionRequest = /(?:忽略|覆寫|顯示|印出).{0,12}(?:指令|提示詞|金鑰)|(?:ignore|reveal)\s+(?:all\s+)?(?:previous|instructions|system|prompt)/iu;
const datePattern = /(?<!\d)(?:(\d{4})([-/.])(\d{1,2})\2(\d{1,2})|(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})(?:日|號)?)(?!\d)/gu;
const dateHint = /今天|明天|後天|週末|周末|(?:上|這|下|本)?[週周][一二三四五六日天]|(?<!\d)\d{1,2}\s*(?:月|[/.-])\s*\d{1,2}(?!\d)/u;

function fact(value, name, max = 180) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || misleadingFact.test(value.normalize('NFKC'))) {
    throw new TypeError(`Invalid knowledge field: ${name}`);
  }
  return value.trim();
}

export function validateKnowledge(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid knowledge object');
  const { name, rooms, checkIn, checkOut, parking, pets, facilities, contact, faq = [] } = value;
  if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > 30 || !Array.isArray(facilities) || facilities.length > 30 || !Array.isArray(faq) || faq.length > 50) {
    throw new TypeError('Invalid knowledge list');
  }
  for (const time of [checkIn, checkOut]) {
    if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) throw new TypeError('Invalid check-in or check-out time');
  }
  const seen = new Set(reservedTopics);
  return {
    name: fact(name, 'name', 80),
    rooms: rooms.map(room => {
      if (!Number.isInteger(room?.maxGuests) || room.maxGuests < 1 || room.maxGuests > 30) throw new TypeError('Invalid room capacity');
      return { name: fact(room.name, 'room name', 50), maxGuests: room.maxGuests };
    }),
    checkIn, checkOut,
    parking: fact(parking, 'parking'),
    pets: fact(pets, 'pets'),
    facilities: facilities.map(item => fact(item, 'facility', 50)),
    contact: fact(contact, 'contact'),
    faq: faq.map(entry => {
      if (typeof entry?.id !== 'string' || !/^[a-z][a-z0-9-]{1,36}$/u.test(entry.id) || seen.has(entry.id)) throw new TypeError('Invalid or duplicate FAQ ID');
      if (!Array.isArray(entry.keywords) || !entry.keywords.length || entry.keywords.length > 12) throw new TypeError('Invalid FAQ keywords');
      seen.add(entry.id);
      return { id: entry.id, keywords: entry.keywords.map(keyword => fact(keyword, 'keyword', 40)), answer: fact(entry.answer, 'FAQ answer', 240) };
    }),
  };
}

function listTopics(knowledge) {
  return [
    { id: 'rooms', keywords: ['房型', '幾人房', '雙人房', '四人房', '家庭房', '幾個人能住'], answer: `房型：${knowledge.rooms.map(({ name, maxGuests }) => `${name}（最多 ${maxGuests} 人）`).join('、')}。` },
    { id: 'check-in', keywords: ['入住時間', '幾點入住', '幾點到', '入住規定', '入房', 'check in', 'check-in'], answer: `入住時間為 ${knowledge.checkIn} 之後。` },
    { id: 'check-out', keywords: ['退房', 'check out', 'check-out'], answer: `退房時間為 ${knowledge.checkOut} 之前。` },
    { id: 'parking', keywords: ['停車', '車位', '開車', '車要停', '車停哪'], answer: knowledge.parking },
    { id: 'pets', keywords: ['寵物', '帶狗', '帶貓', '狗狗', '狗可以帶', '狗能帶', '毛孩', '貓咪'], answer: knowledge.pets },
    { id: 'facilities', keywords: ['設施', '電梯', '網路', 'wifi', 'wi-fi', '設備'], answer: knowledge.facilities.length ? `已公布設施：${knowledge.facilities.join('、')}。` : '設施資訊請由旅宿人員確認。' },
    { id: 'contact', keywords: ['聯絡', '電話', '怎麼找你們'], answer: knowledge.contact },
    ...knowledge.faq,
  ];
}

export function createMockProvider() {
  return {
    kind: 'mock',
    async classify({ text, topics }) {
      const lower = text.toLowerCase();
      return {
        topicIds: topics.filter(({ keywords }) => keywords.some(keyword => lower.includes(keyword.toLowerCase()))).map(({ id }) => id),
        lodgingInquiry: lodgingRequest.test(text),
      };
    },
  };
}

function isDate(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(`${value}T`);
}

function validCount(value, min) {
  return Number.isInteger(value) && value >= min && value <= 30;
}

const prompts = {
  date: '請提供一個完整入住日期，例如 2027-02-06。',
  nights: '預計住幾晚？請回覆 1 到 30 之間的整數。',
  adults: '請問有幾位大人？請回覆 1 到 30 之間的整數。',
  children: '請問有幾位小孩？沒有的話請回覆 0。',
};

function summaryOf(state = {}) {
  const output = {};
  if (isDate(state?.date)) output.date = state.date;
  for (const field of ['nights', 'adults', 'children']) {
    if (validCount(state?.[field], field === 'children' ? 0 : 1)) output[field] = state[field];
  }
  return output;
}

const chineseNumbers = '零一二三四五六七八九';

function parseCount(value) {
  const compact = value.trim().replaceAll('兩', '二');
  if (/^\d{1,2}$/u.test(compact)) return Number(compact);
  if (compact.length === 1 && chineseNumbers.includes(compact)) return chineseNumbers.indexOf(compact);
  const tens = compact.match(/^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/u);
  if (!tens) return undefined;
  return (tens[1] ? chineseNumbers.indexOf(tens[1]) : 1) * 10 + (tens[2] ? chineseNumbers.indexOf(tens[2]) : 0);
}

function captureFields(text, pending) {
  const dates = [...text.matchAll(datePattern)];
  const values = {};
  if (dates.length || dateHint.test(text)) {
    const date = dates[0];
    const next = date ? text.slice((date.index ?? 0) + date[0].length) : '';
    const ambiguous = /^(?:\s|、)*(?:或(?:者)?|到|至|[-~～—])\s*\d/u.test(next);
    if (dates.length === 1 && !ambiguous) {
      const string = [date[1] ?? date[5], (date[3] ?? date[6]).padStart(2, '0'), (date[4] ?? date[7]).padStart(2, '0')].join('-');
      values.date = isDate(string) ? string : undefined;
    } else {
      values.date = undefined;
    }
  }

  const quantityText = text.replace(datePattern, ' ');
  const number = '[+−-]?\\s*[\\d零一二兩三四五六七八九十]+(?:[.,][\\d零一二兩三四五六七八九十]+)?';
  const alternatives = `(?:\\s*(?:或(?:者)?|到|至|[-~–—、/])\\s*${number})*`;
  for (const [field, suffix] of [
    ['nights', '晚(?!上)|夜'],
    ['adults', '(?:位|個|名)?\\s*(?:大人|成人)'],
    ['children', '(?:位|個|名)?\\s*(?:小孩|兒童|孩子)'],
  ]) {
    const matches = [...quantityText.matchAll(new RegExp(`(${number}${alternatives})\\s*(?:${suffix})`, 'gu'))];
    if (matches.length) {
      const distinct = new Set(matches.map(match => parseCount(match[1])));
      values[field] = distinct.size === 1 ? [...distinct][0] : undefined;
    }
  }
  if (/沒有(?:帶)?(?:小孩|兒童|孩子)|無(?:小孩|兒童|孩子)/u.test(text) && !Object.hasOwn(values, 'children')) values.children = 0;
  if (pending && pending !== 'date' && /^[-+−\d零一二兩三四五六七八九十.]+$/u.test(text)) values[pending] = parseCount(text);
  return values;
}

const handoffMessage = '已交由旅宿人員確認。空房、價格及訂單狀態以人工回覆為準。';

export function createAssistant({ knowledge, provider = createMockProvider() }) {
  const topics = listTopics(validateKnowledge(knowledge));
  const classificationTopics = topics.map(({ id, keywords }) => ({ id, keywords }));
  if (typeof provider.classify !== 'function') throw new TypeError('The assistant provider must implement classify');

  return async ({ text, state } = {}) => {
    const current = state?.active === true ? summaryOf(state) : {};
    const handoff = (reason, fields = current, facts = []) => ({
      reply: [...facts, handoffMessage].join('\n'),
      state: {}, outcome: 'handoff', reason, inquiry: summaryOf(fields),
    });
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) {
      return { reply: '請輸入簡短的旅宿問題。', state: state?.active === true ? { active: true, ...current } : {}, outcome: 'clarification', reason: 'invalid_input' };
    }
    const normalized = text.normalize('NFKC').trim();
    const fields = summaryOf({ ...current, ...captureFields(normalized, state?.active === true ? Object.keys(prompts).find(field => current[field] === undefined) : undefined) });
    if (humanRequest.test(normalized)) return handoff('human_requested', fields);
    if (unverifiedRequest.test(normalized)) return handoff('requires_confirmation', fields);
    if (injectionRequest.test(normalized)) return handoff('unsupported_request', current);

    let selection;
    try {
      selection = await provider.classify({ text: normalized, topics: classificationTopics });
    } catch {
      return handoff('provider_error', fields);
    }
    const ids = Array.isArray(selection?.topicIds) ? selection.topicIds.slice(0, 20) : [];
    const facts = topics.filter(topic => ids.includes(topic.id)).slice(0, 4).map(topic => topic.answer);
    const startsInquiry = selection?.lodgingInquiry === true || lodgingRequest.test(normalized) || Object.keys(fields).length > 0;
    if (state?.active === true || startsInquiry) {
      const missing = Object.keys(prompts).find(field => fields[field] === undefined);
      if (!missing) return handoff('lodging_summary', fields, facts);
      return { reply: [...facts, prompts[missing]].join('\n'), state: { active: true, ...fields }, outcome: 'clarification', reason: `missing_${missing}` };
    }
    if (facts.length) return { reply: facts.join('\n'), state: {}, outcome: 'answered', reason: 'knowledge_match' };
    return handoff('unknown_question');
  };
}
