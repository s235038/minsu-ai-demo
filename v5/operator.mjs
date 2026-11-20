const access = document.querySelector('#access');
const login = document.querySelector('#login');
const keyField = document.querySelector('#operator-key');
const signIn = document.querySelector('#sign-in');
const workspace = document.querySelector('#workspace');
const controls = document.querySelector('#workspace-controls');
const feedback = document.querySelector('#feedback');
const inquiryList = document.querySelector('#inquiries');
const emptyList = document.querySelector('#no-inquiries');
const knowledgeField = document.querySelector('#knowledge');
const metricsList = document.querySelector('#metrics');
const statusLabels = { new: '待確認', in_progress: '處理中', resolved: '已處理' };
const taipeiTime = new Intl.DateTimeFormat('zh-TW', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Taipei',
});

let session;
let busy = false;
let inquiries = [];

function announce(message, error = false) {
  feedback.textContent = message;
  feedback.dataset.error = String(error);
}

function signOut(message, error = false) {
  session?.controller.abort();
  session = undefined;
  busy = false;
  signIn.disabled = false;
  controls.disabled = false;
  workspace.hidden = true;
  access.hidden = false;
  keyField.value = '';
  keyField.focus();
  knowledgeField.value = '';
  inquiries = [];
  inquiryList.replaceChildren();
  metricsList.replaceChildren();
  document.querySelector('#failure-reasons').replaceChildren();
  document.querySelector('#failure-details').hidden = true;
  announce(message, error);
}

async function api(current, path, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${current.key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal: current.controller.signal,
  });
  if (!response.ok) {
    const error = new Error('Action failed');
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function run(action) {
  const current = session;
  if (!current || busy) return;
  busy = true;
  signIn.disabled = true;
  controls.disabled = true;
  announce('處理中…');
  try {
    const message = await action(current);
    if (session === current) announce(message);
  } catch (error) {
    if (session !== current) return;
    if (error.status === 401 || error.status === 403) {
      signOut('無法使用這組操作金鑰，請重新輸入。', true);
    } else if (error.status === 400 || error.status === 422) {
      announce('資料格式有誤，請檢查內容後再試。', true);
    } else if (error.status === 404) {
      announce('這筆資料已不存在，請更新清單。', true);
    } else {
      announce('工作台暫時無法完成操作，請稍後再試。', true);
    }
  } finally {
    if (session === current) {
      busy = false;
      controls.disabled = false;
      signIn.disabled = false;
    }
  }
}

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function button(text, className) {
  const control = element('button', text, className);
  control.type = 'button';
  return control;
}

function renderInquiries(records) {
  inquiries = records;
  emptyList.hidden = inquiries.length > 0;
  inquiryList.replaceChildren();
  for (const inquiry of inquiries) {
    const entry = element('li', undefined, 'inquiry');
    entry.append(element('h3', inquiry.date ? `${inquiry.date} 入住` : '入住日期待確認'));
    const details = [];
    if (inquiry.nights !== undefined && inquiry.nights !== null) details.push(`${inquiry.nights} 晚`);
    if (inquiry.adults !== undefined && inquiry.adults !== null) details.push(`${inquiry.adults} 位大人`);
    if (inquiry.children !== undefined && inquiry.children !== null) details.push(`${inquiry.children} 位小孩`);
    entry.append(element('p', details.join(' · ') || '住宿細節待確認'));
    entry.append(element('p', `需求編號：${inquiry.id}`));
    const createdAt = new Date(inquiry.createdAt);
    if (inquiry.createdAt && Number.isFinite(createdAt.getTime())) {
      entry.append(element('p', `建立於 ${taipeiTime.format(createdAt)}`));
    }

    const select = element('select');
    select.setAttribute('aria-label', '處理狀態');
    for (const [value, label] of Object.entries(statusLabels)) {
      const option = element('option', label);
      option.value = value;
      select.append(option);
    }
    select.value = inquiry.status;

    const update = button('更新狀態');
    const remove = button('刪除詢問', 'danger');
    const path = `/api/inquiries/${encodeURIComponent(inquiry.id)}`;
    update.addEventListener('click', () => {
      const status = select.value;
      void run(async current => {
        const result = await api(current, path, { method: 'PATCH', body: { status } });
        if (session === current) {
          renderInquiries(inquiries.map(item => item.id === inquiry.id ? result.inquiry : item));
        }
        await refreshMetrics(current);
        return '處理狀態已更新。';
      });
    });
    remove.addEventListener('click', () => {
      if (!window.confirm('確定刪除這筆諮詢？')) return;
      void run(async current => {
        await api(current, path, { method: 'DELETE' });
        if (session === current) renderInquiries(inquiries.filter(item => item.id !== inquiry.id));
        await refreshMetrics(current);
        return '諮詢已刪除。';
      });
    });
    const actions = element('div', undefined, 'actions');
    actions.append(select, update, remove);
    entry.append(actions);
    inquiryList.append(entry);
  }
}

function pair(label, value, className) {
  const group = element('div', undefined, className);
  group.append(element('dt', label), element('dd', String(value ?? 0)));
  return group;
}

function renderMetrics({ mode, metrics }) {
  document.querySelector('#mode').textContent = mode === 'line' ? 'LINE 回覆 · 模擬問答' : '模擬傳送 · 模擬問答';
  const outcomes = metrics.outcomes;
  const deliveries = metrics.deliveries;
  const counts = [
    ['收到事件', metrics.received],
    ['待完成事件', metrics.inFlight],
    ['知識庫答覆', outcomes.answered],
    ['追問澄清', outcomes.clarification],
    ['轉交人工', outcomes.handoff],
    ['處理失敗', outcomes.failed],
    ['回覆已傳送', deliveries.sent],
    ['回覆遭拒', deliveries.rejected],
    ['傳送結果未明', deliveries.uncertain],
    ['未傳送', deliveries.not_sent],
    ['待確認諮詢', metrics.inquiries.new],
    ['處理中諮詢', metrics.inquiries.in_progress],
    ['已處理諮詢', metrics.inquiries.resolved],
  ];
  metricsList.replaceChildren(...counts.map(([label, value]) => pair(label, value, 'metric')));
  const failureCounts = [
    ['處理未完成', metrics.inFlight],
    ['服務處理失敗', outcomes.failed],
    ['分類失敗後轉人工', metrics.reasons.provider_error ?? 0],
    ['傳送遭拒', deliveries.rejected],
    ['傳送結果未明', deliveries.uncertain],
  ].filter(([, count]) => count > 0);
  document.querySelector('#failure-reasons').replaceChildren(...failureCounts.map(([label, value]) => pair(label, value)));
  document.querySelector('#failure-details').hidden = failureCounts.length === 0;
}

async function refreshMetrics(current) {
  const result = await api(current, '/api/metrics');
  if (session === current) renderMetrics(result);
}

login.addEventListener('submit', event => {
  event.preventDefault();
  const key = keyField.value.trim();
  keyField.value = '';
  if (!key || busy) return;
  session?.controller.abort();
  session = { key, controller: new AbortController() };
  void run(async current => {
    const [intake, knowledge, metrics] = await Promise.all([
      api(current, '/api/inquiries'),
      api(current, '/api/knowledge'),
      api(current, '/api/metrics'),
    ]);
    if (session === current) {
      renderInquiries(intake.inquiries);
      renderMetrics(metrics);
      knowledgeField.value = JSON.stringify(knowledge.knowledge, null, 2);
      access.hidden = true;
      workspace.hidden = false;
      document.querySelector('#inquiry-title').focus();
    }
    return '已登入工作台。';
  });
});

document.querySelector('#sign-out').addEventListener('click', () => signOut('已登出。'));
document.querySelector('#refresh').addEventListener('click', () => {
  void run(async current => {
    const [intake, metrics] = await Promise.all([api(current, '/api/inquiries'), api(current, '/api/metrics')]);
    if (session === current) {
      renderInquiries(intake.inquiries);
      renderMetrics(metrics);
    }
    return '清單與指標已更新。';
  });
});

document.querySelector('#reload-knowledge').addEventListener('click', () => {
  void run(async current => {
    const result = await api(current, '/api/knowledge');
    if (session === current) knowledgeField.value = JSON.stringify(result.knowledge, null, 2);
    return '知識庫已重新載入。';
  });
});

document.querySelector('#knowledge-form').addEventListener('submit', event => {
  event.preventDefault();
  let knowledge;
  try {
    knowledge = JSON.parse(knowledgeField.value);
  } catch {
    announce('JSON 格式有誤，請檢查後再儲存。', true);
    return;
  }
  void run(async current => {
    const result = await api(current, '/api/knowledge', { method: 'PUT', body: { knowledge } });
    if (session === current) knowledgeField.value = JSON.stringify(result.knowledge, null, 2);
    return '知識庫已儲存。';
  });
});
