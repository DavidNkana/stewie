const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHandler } = require('../src/server');
const { createMemory } = require('../src/memory');
const { createPolicy } = require('../src/policy');
const { buildConfig } = require('../src/config');

const WEBHOOK_TOKEN = 'webhook-secret';
const ADMIN_TOKEN = 'admin-secret';

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-')), 'state.json');
}

function build({ reply = 'sure thing' } = {}) {
  const config = {
    ...buildConfig({
      STEWIE_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
      STEWIE_ADMIN_TOKEN: ADMIN_TOKEN,
      STEWIE_BOT_NAME: 'stewie'
    }),
    webhookToken: WEBHOOK_TOKEN,
    adminToken: ADMIN_TOKEN
  };
  const memory = createMemory({ file: tempFile() });
  const sent = [];
  const evolution = {
    sendText: async (to, text) => { sent.push({ to, text }); return { ok: true }; },
    groupInfo: async () => ({ subject: 'Test Group' }),
    fetchGroups: async () => [{ id: '120363000000000000@g.us', subject: 'Existing Group' }],
    qr: async () => ({ code: 'qr-code', pairingCode: '12345678', base64: 'data:image/png;base64,AAAA' })
  };
  const brain = { generate: async () => reply };
  const policy = createPolicy(config);
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const handler = createHandler({ config, evolution, memory, policy, brain, logger });
  return { handler, memory, sent, config, evolution };
}

function request(handler, method, url, body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler).listen(0, () => {
      const req = http.request({ port: server.address().port, method, path: url, headers }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data, headers: res.headers }); });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  });
}

function webhookPayload(text, { id = 'm1', jid = '120363000000000000@g.us', fromMe = false } = {}) {
  return JSON.stringify({
    event: 'MESSAGES_UPSERT',
    instance: 'stewie',
    data: {
      key: { remoteJid: jid, fromMe, id, participant: '27747778886@s.whatsapp.net' },
      pushName: 'David',
      messageTimestamp: Date.now(),
      message: { conversation: text }
    }
  });
}

async function settle(ms = 40) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

test('webhook rejects a wrong token', async () => {
  const { handler } = build();
  const result = await request(handler, 'POST', '/webhook/nope', webhookPayload('hi'));
  assert.equal(result.status, 401);
});

test('webhook rejects malformed json with 400', async () => {
  const { handler } = build();
  const result = await request(handler, 'POST', `/webhook/${WEBHOOK_TOKEN}`, '{not json');
  assert.equal(result.status, 400);
});

test('a mentioned group message produces one reply', async () => {
  const { handler, sent } = build();
  const result = await request(handler, 'POST', `/webhook/${WEBHOOK_TOKEN}`, webhookPayload('stewie are you there?'));
  assert.equal(result.status, 200);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '120363000000000000@g.us');
  assert.equal(sent[0].text, 'sure thing');
});

test('duplicate deliveries of the same message id reply once', async () => {
  const { handler, sent } = build();
  const payload = webhookPayload('stewie ping', { id: 'dup-1' });
  await request(handler, 'POST', `/webhook/${WEBHOOK_TOKEN}`, payload);
  await request(handler, 'POST', `/webhook/${WEBHOOK_TOKEN}`, payload);
  await settle();
  assert.equal(sent.length, 1);
});

test('our own outbound messages never trigger a reply', async () => {
  const { handler, sent } = build();
  await request(handler, 'POST', `/webhook/${WEBHOOK_TOKEN}`, webhookPayload('stewie ping', { id: 'own-1', fromMe: true }));
  await settle();
  assert.equal(sent.length, 0);
});

test('a group can be switched off explicitly', async () => {
  const { handler, sent, memory } = build();
  memory.updateSettings('120363000000000000@g.us', { enabled: false });
  await request(handler, 'POST', `/webhook/${WEBHOOK_TOKEN}`, webhookPayload('stewie ping', { id: 'off-1' }));
  await settle();
  assert.equal(sent.length, 0);
  memory.updateSettings('120363000000000000@g.us', { enabled: true });
  await request(handler, 'POST', `/webhook/${WEBHOOK_TOKEN}`, webhookPayload('stewie ping again', { id: 'off-2' }));
  await settle();
  assert.equal(sent.length, 1);
});

test('direct chats reply without needing a group to be enabled', async () => {
  const { handler, sent } = build();
  await request(handler, 'POST', `/webhook/${WEBHOOK_TOKEN}`, webhookPayload('hello there', { id: 'dm-1', jid: '27747778886@s.whatsapp.net' }));
  await settle();
  assert.equal(sent.length, 1);
});

test('admin routes require the bearer token', async () => {
  const { handler } = build();
  assert.equal((await request(handler, 'GET', '/admin/groups')).status, 401);
  const ok = await request(handler, 'GET', '/admin/groups', '', { authorization: `Bearer ${ADMIN_TOKEN}` });
  assert.equal(ok.status, 200);
});

test('admin can enable a group and list chats', async () => {
  const { handler } = build();
  const update = await request(
    handler,
    'POST',
    '/admin/groups/120363000000000000@g.us',
    JSON.stringify({ enabled: true, mode: 'always' }),
    { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }
  );
  assert.equal(update.status, 200);
  assert.match(update.body, /"enabled":true/);
  const list = await request(handler, 'GET', '/admin/groups', '', { authorization: `Bearer ${ADMIN_TOKEN}` });
  assert.match(list.body, /120363000000000000@g\.us/);
});

test('admin rejects invalid mode and probability', async () => {
  const { handler } = build();
  const badMode = await request(handler, 'POST', '/admin/groups/x', JSON.stringify({ mode: 'chaos' }), { authorization: `Bearer ${ADMIN_TOKEN}` });
  assert.equal(badMode.status, 400);
  const badProbability = await request(handler, 'POST', '/admin/groups/x', JSON.stringify({ probability: 4 }), { authorization: `Bearer ${ADMIN_TOKEN}` });
  assert.equal(badProbability.status, 400);
});

test('qr endpoint requires the admin token and can return a png', async () => {
  const { handler } = build();
  assert.equal((await request(handler, 'GET', '/qr/' + ADMIN_TOKEN)).status, 200);
  assert.equal((await request(handler, 'GET', '/qr.png/' + ADMIN_TOKEN)).status, 200);
  assert.equal((await request(handler, 'GET', '/qr.png/wrong')).status, 401);
});

test('health endpoint reports readiness', async () => {
  const { handler } = build();
  const result = await request(handler, 'GET', '/health');
  assert.equal(result.status, 200);
  assert.match(result.body, /"ok":true/);
});

test('a failed send pauses further sends instead of stalling the queue', async () => {
  const { handler, sent } = build();
  const failing = build({ reply: 'x' });
  failing.evolution.sendText = async () => { throw new Error('not connected'); };
  const payload = webhookPayload('stewie ping', { id: 'backoff-1' });
  await request(failing.handler, 'POST', `/webhook/${WEBHOOK_TOKEN}`, payload);
  await settle(60);
  assert.equal(failing.sent.length, 0);
  await request(failing.handler, 'POST', `/webhook/${WEBHOOK_TOKEN}`, webhookPayload('stewie again', { id: 'backoff-2' }));
  await settle(60);
  assert.equal(failing.sent.length, 0);
});

test('an unresolvable group name is looked up once, not on every message', async () => {
  let lookups = 0;
  const app = build();
  app.evolution.groupInfo = async () => { lookups++; throw new Error('group not found'); };
  await request(app.handler, 'POST', `/webhook/${WEBHOOK_TOKEN}`, webhookPayload('stewie hi', { id: 'cache-1' }));
  await settle();
  await request(app.handler, 'POST', `/webhook/${WEBHOOK_TOKEN}`, webhookPayload('stewie hi again', { id: 'cache-2' }));
  await settle();
  assert.equal(lookups, 1);
});
