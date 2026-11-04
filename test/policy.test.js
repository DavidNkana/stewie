const test = require('node:test');
const assert = require('node:assert/strict');
const { createPolicy } = require('../src/policy');

const config = {
  botName: 'stewie',
  aliases: ['luna'],
  groupMode: 'mention',
  dmMode: 'always',
  cooldownSeconds: 20,
  maxRepliesPerChatPerHour: 3,
  maxRepliesPerHour: 10,
  responseProbability: 1
};

const groupMessage = { isGroup: true, text: 'stewie what do you think?' };

test('group mode mention only replies when the bot is named', () => {
  const policy = createPolicy(config, { now: () => 1000, random: () => 0 });
  assert.equal(policy.decide({ message: groupMessage, settings: { enabled: true } }).reply, true);
  assert.equal(policy.decide({ message: { isGroup: true, text: 'chicken tonight?' }, settings: { enabled: true } }).reason, 'not_mentioned');
});

test('aliases count as mentions', () => {
  const policy = createPolicy(config, { now: () => 1000, random: () => 0 });
  assert.equal(policy.decide({ message: { isGroup: true, text: 'luna thoughts' }, settings: { enabled: true } }).reply, true);
});

test('disabled groups never reply', () => {
  const policy = createPolicy(config, { now: () => 1000, random: () => 0 });
  const decision = policy.decide({ message: groupMessage, settings: { enabled: false } });
  assert.equal(decision.reply, false);
  assert.equal(decision.reason, 'disabled');
});

test('question mode replies to questions and mentions', () => {
  const policy = createPolicy(config, { now: () => 1000, random: () => 0 });
  const settings = { enabled: true, mode: 'question' };
  assert.equal(policy.decide({ message: { isGroup: true, text: 'anyone seen the doc?' }, settings }).reply, true);
  assert.equal(policy.decide({ message: { isGroup: true, text: 'just chatting' }, settings }).reason, 'not_a_question');
});

test('direct chats use the dm mode', () => {
  const policy = createPolicy(config, { now: () => 1000, random: () => 0 });
  assert.equal(policy.decide({ message: { isGroup: false, text: 'hey' }, settings: {} }).reply, true);
});

test('cooldown blocks a second reply inside the window', () => {
  const policy = createPolicy(config, { now: () => 1000, random: () => 0 });
  const decision = policy.decide({ message: groupMessage, settings: { enabled: true }, lastReplyAt: 1000 - 5000 });
  assert.equal(decision.reply, false);
  assert.equal(decision.reason, 'cooldown');
});

test('per-chat and global hourly caps are enforced', () => {
  const policy = createPolicy(config, { now: () => 1000, random: () => 0 });
  const capped = policy.decide({ message: groupMessage, settings: { enabled: true }, chatReplyCount: 3 });
  assert.equal(capped.reason, 'chat_hourly_cap');
  const global = policy.decide({ message: groupMessage, settings: { enabled: true }, globalReplyCount: 10 });
  assert.equal(global.reason, 'global_hourly_cap');
});

test('probability gate suppresses organic replies', () => {
  const policy = createPolicy(config, { now: () => 1000, random: () => 0.99 });
  const decision = policy.decide({ message: { isGroup: true, text: 'chicken tonight?' }, settings: { enabled: true, mode: 'question', probability: 0.5 } });
  assert.equal(decision.reply, false);
  assert.equal(decision.reason, 'probability');
});

test('never mode blocks everything', () => {
  const policy = createPolicy(config, { now: () => 1000, random: () => 0 });
  const decision = policy.decide({ message: { isGroup: false, text: 'hello' }, settings: { mode: 'never' } });
  assert.equal(decision.reason, 'mode_never');
});

test('probability never suppresses an explicit mention', () => {
  const policy = createPolicy(config, { now: () => 1000, random: () => 0.999 });
  const mentioned = policy.decide({ message: { isGroup: true, text: 'stewie help' }, settings: { enabled: true, probability: 0.1 } });
  assert.equal(mentioned.reply, true);
  const organic = policy.decide({ message: { isGroup: true, text: 'chicken?' }, settings: { enabled: true, probability: 0.1, mode: 'question' } });
  assert.equal(organic.reply, false);
  assert.equal(organic.reason, 'probability');
});

test('group chat questions are detected without a question mark', () => {
  const policy = createPolicy(config, { now: () => 1000, random: () => 0 });
  const settings = { enabled: true, mode: 'question' };
  for (const text of ['anyone got the numbers', 'help me with this', 'can someone look at the build', 'quick one, is the site up']) {
    assert.equal(policy.decide({ message: { isGroup: true, text }, settings }).reply, true, text);
  }
  assert.equal(policy.decide({ message: { isGroup: true, text: 'ok thanks' }, settings }).reason, 'not_a_question');
});
