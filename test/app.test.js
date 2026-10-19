const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, createModelAdapter, createSender, createStore, fetchWithTimeout, isValidSignature, validateConfig } = require('../src/app');

function request(app, method, url, body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const server = require('node:http').createServer(app.handler).listen(0, () => {
      const port = server.address().port;
      const req = require('node:http').request({ port, method, path: url, headers }, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data }); }); });
      req.on('error', reject); if (body) req.write(body); req.end();
    });
  });
}

function tempState() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-')), 'state.json'); }
function liveConfig() { return { mockMode: false, verifyToken: 'v', appSecret: 's', accessToken: 'a', phoneNumberId: 'right', openaiKey: 'k', stateFile: tempState() }; }

test('webhook verification accepts correct token', async () => {
  const app = createApp({ config: { verifyToken: 'secret', stateFile: tempState(), mockMode: true } });
  const result = await request(app, 'GET', '/webhook?hub.mode=subscribe&hub.verify_token=secret&hub.challenge=abc');
  assert.equal(result.status, 200); assert.equal(result.body, 'abc');
});

test('signature validation uses HMAC and rejects tampering', () => {
  const body = '{"x":1}'; const digest = crypto.createHmac('sha256', 'key').update(body).digest('hex');
  assert.equal(isValidSignature(body, `sha256=${digest}`, 'key'), true);
  assert.equal(isValidSignature('{"x":2}', `sha256=${digest}`, 'key'), false);
  assert.equal(isValidSignature(body, undefined, ''), false);
});

test('live webhook auth fails closed and GET requires subscribe, token, and challenge', async () => {
  assert.throws(() => validateConfig({ mockMode: false }), /live configuration missing/);
  const configured = createApp({ config: liveConfig() });
  assert.equal((await request(configured, 'GET', '/webhook?hub.verify_token=x&hub.challenge=c')).status, 403);
  assert.equal((await request(configured, 'GET', '/webhook?hub.mode=subscribe&hub.verify_token=v')).status, 403);
  assert.equal((await request(configured, 'POST', '/webhook', '{}', { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })).status, 401);
});

test('POST acknowledges quickly and deduplicates message IDs', async () => {
  const sent = []; let calls = 0;
  const app = createApp({ config: { appSecret: 'key', stateFile: tempState(), mockMode: true }, model: async () => { calls++; return 'reply'; }, send: async (to, text) => sent.push({ to, text }) });
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'm1', from: '1555', type: 'text', text: { body: 'hello' } }] } }] }] });
  const sig = `sha256=${crypto.createHmac('sha256', 'key').update(payload).digest('hex')}`;
  assert.equal((await request(app, 'POST', '/webhook', payload, { 'content-type': 'application/json', 'x-hub-signature-256': sig })).status, 200);
  assert.equal((await request(app, 'POST', '/webhook', payload, { 'content-type': 'application/json', 'x-hub-signature-256': sig })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1); assert.deepEqual(sent, [{ to: '1555', text: 'reply' }]);
});

test('POST ignores messages for a different WhatsApp phone number', async () => {
  let calls = 0;
  const app = createApp({ config: { ...liveConfig(), appSecret: 'key' }, model: async () => { calls++; return 'reply'; }, send: async () => {} });
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'wrong' }, messages: [{ id: 'wrong-1', from: '1555', type: 'text', text: { body: 'hello' } }] } }] }] });
  const sig = `sha256=${crypto.createHmac('sha256', 'key').update(payload).digest('hex')}`;
  assert.equal((await request(app, 'POST', '/webhook', payload, { 'x-hub-signature-256': sig })).status, 400);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 0);
});

test('live webhook rejects messages with missing phone metadata', async () => {
  const app = createApp({ config: liveConfig(), model: async () => 'reply', send: async () => {} });
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'missing-meta', from: '1555', type: 'text', text: { body: 'hello' } }] } }] }] });
  const sig = `sha256=${crypto.createHmac('sha256', 's').update(payload).digest('hex')}`;
  assert.equal((await request(app, 'POST', '/webhook', payload, { 'x-hub-signature-256': sig })).status, 400);
});

test('authenticated malformed webhook returns 400 instead of crashing', async () => {
  const app = createApp({ config: liveConfig() });
  for (const value of [{ entry: [null] }, null]) {
    const payload = JSON.stringify(value);
    const sig = `sha256=${crypto.createHmac('sha256', 's').update(payload).digest('hex')}`;
    assert.equal((await request(app, 'POST', '/webhook', payload, { 'x-hub-signature-256': sig })).status, 400);
  }
});

test('same sender is serialized and failed work can be retried', async () => {
  const order = []; let fail = true;
  const app = createApp({ config: { stateFile: tempState(), mockMode: true, retryAttempts: 1 }, logger: () => {}, model: async (_u, _h, text) => { order.push(`model:${text}`); await new Promise(resolve => setTimeout(resolve, 5)); return text; }, send: async (_to, text) => { order.push(`send:${text}`); if (text === 'first' && fail) { fail = false; throw new Error('temporary'); } } });
  await assert.rejects(app.processMessage({ id: 'retry-1', from: 'same', text: 'first' }));
  await app.processMessage({ id: 'retry-1', from: 'same', text: 'first' });
  await app.processMessage({ id: 'second', from: 'same', text: 'second' });
  assert.deepEqual(order, ['model:first', 'send:first', 'model:first', 'send:first', 'model:second', 'send:second']);
});

test('duplicate IDs share an in-flight retry and do not duplicate history', async () => {
  let sends = 0;
  const app = createApp({ config: { stateFile: tempState(), mockMode: true, retryDelayMs: 1 }, logger: () => {}, model: async () => 'reply', send: async () => { sends++; if (sends === 1) throw new Error('temporary'); } });
  const message = { id: 'same-flight', from: '1', text: 'hello' };
  const [first, second] = await Promise.all([app.processMessage(message), app.processMessage(message)]);
  assert.equal(first, true); assert.equal(second, true); assert.equal(sends, 2);
  assert.equal(app.store.history('1').length, 2);
});

test('retention prunes old records on load and save', () => {
  const file = tempState();
  const old = Date.now() - 3 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(file, JSON.stringify({ processed: { old: old }, optedOut: { oldUser: old }, conversations: { oldUser: [{ role: 'user', content: 'old', timestamp: old }] } }));
  const store = createStore(file, 1);
  assert.equal(store.seen('old'), false); assert.equal(store.isOptedOut('oldUser'), false); assert.deepEqual(store.history('oldUser'), []);
});

test('structured events omit message contents and full phone numbers', async () => {
  const events = [];
  const app = createApp({ config: { stateFile: tempState(), mockMode: true }, logger: event => events.push(event), model: async () => 'reply', send: async () => {} });
  await app.processMessage({ id: 'event-1', from: '15551234567', text: 'secret message' });
  assert.ok(events.some(event => event.event === 'reply_success'));
  assert.ok(events.every(event => !JSON.stringify(event).includes('secret message')));
  assert.ok(events.every(event => !JSON.stringify(event).includes('15551234567')));
});

test('request timeout remains active while response body parses', async () => {
  let signal;
  const response = { ok: true, json: async () => { await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(signal.aborted, true); return {}; } };
  await fetchWithTimeout(async (_url, options) => { signal = options.signal; return response; }, 'http://model', {}, 10).then(result => result.json());
});

test('model adapter calls compatible chat completions endpoint', async () => {
  let captured;
  const model = await createModelAdapter({ openaiKey: 'k', openaiBaseUrl: 'http://model/v1', model: 'test-model', mockMode: false }, async (url, options) => { captured = { url, options }; return { ok: true, json: async () => ({ choices: [{ message: { content: ' hello ' } }] }) }; });
  assert.equal(await model('u', [{ role: 'user', content: 'old' }], 'new'), 'hello');
  assert.equal(captured.url, 'http://model/v1/chat/completions'); assert.equal(JSON.parse(captured.options.body).model, 'test-model');
  assert.ok(captured.options.signal instanceof AbortSignal);
});

test('sender uses mock mode without network', async () => {
  const sender = createSender({ mockMode: true }, () => { throw new Error('network called'); });
  assert.deepEqual(await sender('1', 'hi'), { mock: true });
});

test('default model adapter processes a mock webhook message', async () => {
  const sent = [];
  const app = createApp({
    config: { stateFile: tempState(), mockMode: true },
    send: async (to, text) => sent.push({ to, text })
  });
  await app.processMessage({ id: 'm2', from: '1666', text: 'hello' });
  assert.deepEqual(sent, [{ to: '1666', text: 'Luna (mock): I received your message: hello' }]);
});
