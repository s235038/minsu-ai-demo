const { readFileSync } = require('node:fs');
const { Script } = require('node:vm');
const assert = require('node:assert/strict');

const html = readFileSync('minsu_ai_v3.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/);
assert(script, 'JavaScript block missing');
new Script(script[1]);
assert(html.includes('不接受實際訂房'));
assert(!/fetch\s*\(|XMLHttpRequest|api[_-]?key/i.test(script[1]), 'Unexpected network/API reference');
console.log('PASS: script syntax, demo notice, no API references');
