import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMockProvider } from './assistant.mjs';
import { createLineReply } from './line.mjs';
import { createV5Server } from './server.mjs';
import { createStore } from './store.mjs';

const mode = process.env.V5_LINE_REPLY_MODE ?? 'mock';
if (!['mock', 'line'].includes(mode)) throw new TypeError('V5_LINE_REPLY_MODE must be mock or line');

const port = Number(process.env.V5_PORT ?? 8785);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid V5_PORT');

const store = createStore(process.env.V5_DB_PATH ?? fileURLToPath(new URL('v5-demo.sqlite', import.meta.url)));
const demoKnowledge = new URL('knowledge.demo.json', import.meta.url);
const knowledge = JSON.parse(readFileSync(process.env.V5_KNOWLEDGE_PATH ?? demoKnowledge, 'utf8'));
const reply = mode === 'line'
  ? createLineReply({ accessToken: process.env.V5_LINE_ACCESS_TOKEN })
  : async ({ text }) => {
      if (process.env.V5_PRINT_MOCK_REPLIES === '1') console.log('LINE 模擬回覆\n' + text);
    };

const server = createV5Server({
  store, knowledge, reply, mode, provider: createMockProvider(),
  channelSecret: process.env.V5_LINE_CHANNEL_SECRET,
  operatorToken: process.env.V5_OPERATOR_TOKEN,
  privacyKey: process.env.V5_PRIVACY_KEY,
});

server.listen(port, '127.0.0.1', () => {
  console.log(`V5 ${mode} LINE delivery, mock classifier, operator http://127.0.0.1:${port}/operator`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => store.close()));
}
