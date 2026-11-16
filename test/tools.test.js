const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateExpression, looksLikeMath } = require('../src/tools/calculate');
const { isPrivateAddress, htmlToText, extractTitle } = require('../src/tools/fetch-url');
const { parseWhen } = require('../src/tools/reminders');
const { extractUrls, isPdf } = require('../src/tools/prefetch');

test('arithmetic is evaluated exactly', () => {
  assert.equal(evaluateExpression('187 * 34 + 12'), 6370);
  assert.equal(evaluateExpression('(2 + 3) * 4'), 20);
  assert.equal(evaluateExpression('100 / 8'), 12.5);
  assert.equal(evaluateExpression('2 ^ 10'), 1024);
  assert.equal(evaluateExpression('-5 + 8'), 3);
  assert.equal(evaluateExpression('round(3.14159, 2)'), 3.14);
  assert.equal(evaluateExpression('sqrt(144)'), 12);
  assert.equal(evaluateExpression('max(3, 9, 4)'), 9);
});

test('expressions that are not maths are rejected', () => {
  assert.throws(() => evaluateExpression('process.exit(1)'), /unknown name/);
  assert.throws(() => evaluateExpression('1 +'), /unexpected end/);
  assert.throws(() => evaluateExpression('rm -rf /'), /unknown name|unexpected character/);
  assert.throws(() => evaluateExpression('1/0'), /finite/);
});

test('math detection ignores plain sentences and dates', () => {
  assert.equal(looksLikeMath('what is 12 * 3'), true);
  assert.equal(looksLikeMath('meeting on 2026-11-16 at 9'), false);
  assert.equal(looksLikeMath('hello there'), false);
});

test('private addresses are refused', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.1.2.3'), true);
  assert.equal(isPrivateAddress('192.168.1.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('172.16.0.1'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('93.184.216.34'), false);
});

test('html is reduced to readable text', () => {
  const html = '<html><head><title>Hello</title><script>bad()</script></head><body><h1>Title</h1><p>Body &amp; more</p></body></html>';
  const text = htmlToText(html);
  assert.match(text, /Title/);
  assert.match(text, /Body & more/);
  assert.doesNotMatch(text, /bad\(\)/);
  assert.equal(extractTitle(html), 'Hello');
});

test('urls are extracted and pdfs spotted', () => {
  const urls = extractUrls('see https://example.com/a and https://example.com/b, plus https://example.com/a');
  assert.deepEqual(urls, ['https://example.com/a', 'https://example.com/b']);
  assert.equal(isPdf('https://x.com/file.PDF?a=1', null), true);
  assert.equal(isPdf('https://x.com/page', 'application/pdf'), true);
  assert.equal(isPdf('https://x.com/page', 'text/html'), false);
});

test('reminder times understand plain speech', () => {
  const now = new Date('2026-11-16T10:00:00Z');
  assert.equal(parseWhen('in 2 hours', now).toISOString(), '2026-11-16T12:00:00.000Z');
  assert.equal(parseWhen('in 30 minutes', now).toISOString(), '2026-11-16T10:30:00.000Z');
  assert.equal(parseWhen('tomorrow at 9am', now).toISOString(), '2026-11-17T09:00:00.000Z');
  assert.equal(parseWhen('2026-12-01T08:00:00Z', now).toISOString(), '2026-12-01T08:00:00.000Z');
  assert.throws(() => parseWhen('whenever', now), /could not understand/);
});
