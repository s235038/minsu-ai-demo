// No real accounts, persistence, cookies or browser storage are used here.
const messages = document.querySelector('#messages');
const form = document.querySelector('#composer');
const question = document.querySelector('#question');
const send = document.querySelector('#send');
const feedback = document.querySelector('#feedback');
const sessionId = crypto.randomUUID();
let pending = false;

function bubble(text, kind) {
  const paragraph = document.createElement('p');
  paragraph.className = 'bubble ' + kind;
  paragraph.textContent = text; // Never interpret the submitted or returned text as HTML.
  messages.append(paragraph);
  paragraph.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function ask(text) {
  if (pending || !text.trim()) return;
  pending = true;
  question.disabled = true;
  send.disabled = true;
  feedback.textContent = '正在產生示範回覆…';
  bubble(text, 'traveler');
  try {
    const response = await fetch('/demo/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('demo_not_available');
    const result = await response.json();
    if (typeof result.reply !== 'string') throw new Error('invalid_demo_reply');
    bubble(result.reply, 'assistant');
    feedback.textContent = result.outcome === 'handoff'
      ? '已建立模擬人工轉交。請切到老闆工作台更新清單查看。'
      : '示範回覆完成。';
  } catch {
    bubble('示範服務暫時無法回答。可重新送出問題，或重新啟動本機程式。', 'error');
    feedback.textContent = '本次未成功，請重試。';
  } finally {
    pending = false;
    question.disabled = false;
    send.disabled = false;
    question.focus();
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const text = question.value.trim();
  if (!text || pending) return;
  question.value = '';
  void ask(text);
});
for (const button of document.querySelectorAll('[data-example]')) {
  button.addEventListener('click', () => {
    if (!pending) {
      question.value = button.dataset.example;
      question.focus();
    }
  });
}
