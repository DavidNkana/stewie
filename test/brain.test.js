const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrain, stripThinking } = require('../src/brain');

function response(content, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => (ok ? '' : 'boom')
  };
}

test('reasoning models omit temperature and use max_completion_tokens', async () => {
  let captured;
  const brain = createBrain({
    model: 'gpt-5.6-luna',
    modelBaseUrl: 'https://api.test/v1',
    modelApiKey: 'k',
    requestTimeoutMs: 5000,
    maxReplyChars: 900
  }, async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return response('answer');
  });

  const answer = await brain.generate({ message: { text: 'hi' }, history: [], settings: {}, kind: 'dm' });
  assert.equal(answer, 'answer');
  assert.equal(captured.body.temperature, undefined);
  assert.equal(captured.body.max_completion_tokens, 400);
  assert.equal(captured.url, 'https://api.test/v1/chat/completions');
});

test('standard models send temperature and max_tokens', async () => {
  let captured;
  const brain = createBrain({
    model: 'MiniMax-M3',
    modelBaseUrl: 'https://api.test/v1',
    modelApiKey: 'k',
    requestTimeoutMs: 5000,
    maxReplyChars: 900
  }, async (url, options) => {
    captured = JSON.parse(options.body);
    return response('answer');
  });
  await brain.generate({ message: { text: 'hi' }, history: [], settings: {}, kind: 'dm' });
  assert.equal(captured.temperature, 0.8);
  assert.equal(captured.max_tokens, 400);
});

test('reasoning blocks are stripped from the reply', async () => {
  const brain = createBrain({
    model: 'MiniMax-M3',
    modelBaseUrl: 'https://api.test/v1',
    modelApiKey: 'k',
    requestTimeoutMs: 5000,
    maxReplyChars: 900
  }, async () => response('<think>internal reasoning</think>\n\npong'));
  const answer = await brain.generate({ message: { text: 'ping' }, history: [], settings: {}, kind: 'dm' });
  assert.equal(answer, 'pong');
  assert.equal(stripThinking('<think>a</think>b'), 'b');
});

test('history is mapped into chat messages and the persona is applied', async () => {
  let captured;
  const brain = createBrain({
    model: 'MiniMax-M3',
    modelBaseUrl: 'https://api.test/v1',
    modelApiKey: 'k',
    requestTimeoutMs: 5000,
    maxReplyChars: 900,
    botName: 'stewie',
    persona: ''
  }, async (url, options) => {
    captured = JSON.parse(options.body);
    return response('ok');
  });
  await brain.generate({
    message: { text: 'and now?' },
    history: [{ role: 'user', text: 'earlier', name: 'David' }, { role: 'assistant', text: 'reply' }],
    settings: { persona: 'be brief' },
    chatName: 'Team',
    kind: 'group'
  });
  const roles = captured.messages.map(entry => entry.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
  assert.match(captured.messages[1].content, /^David: earlier$/);
  assert.match(captured.messages[0].content, /be brief/);
  assert.match(captured.messages[0].content, /"Team"/);
});

test('provider errors surface as exceptions', async () => {
  const brain = createBrain({
    model: 'MiniMax-M3',
    modelBaseUrl: 'https://api.test/v1',
    modelApiKey: 'k',
    requestTimeoutMs: 5000,
    maxReplyChars: 900
  }, async () => response('', false, 500));
  await assert.rejects(() => brain.generate({ message: { text: 'hi' }, history: [], settings: {}, kind: 'dm' }), /model api returned 500/);
});

test('empty model output is an error, not a silent blank reply', async () => {
  const brain = createBrain({
    model: 'MiniMax-M3',
    modelBaseUrl: 'https://api.test/v1',
    modelApiKey: 'k',
    requestTimeoutMs: 5000,
    maxReplyChars: 900
  }, async () => response('   '));
  await assert.rejects(() => brain.generate({ message: { text: 'hi' }, history: [], settings: {}, kind: 'dm' }), /no text/);
});

test('a silent answer returns null instead of an empty reply', async () => {
  const brain = createBrain({
    model: 'MiniMax-M3',
    modelBaseUrl: 'https://api.test/v1',
    modelApiKey: 'k',
    requestTimeoutMs: 5000,
    maxReplyChars: 900,
    botName: 'stewie',
    personaId: 'stewie',
    timezone: 'Africa/Lusaka'
  }, async () => response('[SILENT]'));
  const answer = await brain.generate({ message: { text: 'mm' }, history: [], settings: {}, kind: 'group' });
  assert.equal(answer, null);
});

test('the prompt carries the persona, group name and speaker count', async () => {
  let captured;
  const brain = createBrain({
    model: 'MiniMax-M3',
    modelBaseUrl: 'https://api.test/v1',
    modelApiKey: 'k',
    requestTimeoutMs: 5000,
    maxReplyChars: 900,
    botName: 'stewie',
    personaId: 'stewie',
    timezone: 'Africa/Lusaka'
  }, async (url, options) => {
    captured = JSON.parse(options.body);
    return response('ok');
  });
  await brain.generate({
    message: { text: 'hi' },
    history: [{ role: 'user', text: 'morning', name: 'David' }, { role: 'user', text: 'hey', name: 'Sarah' }],
    settings: { persona: 'hector' },
    chatName: 'Team Chat',
    kind: 'group'
  });
  const system = captured.messages[0].content;
  assert.match(system, /Hector/);
  assert.match(system, /"Team Chat"/);
  assert.match(system, /about 2 people active/);
  assert.match(system, /\[SILENT\]/);
});
