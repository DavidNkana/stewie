const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUpsert, extractText, isGroup, isDirect } = require('../src/parse');

function upsert(data) {
  return { event: 'MESSAGES_UPSERT', instance: 'stewie', data };
}

test('parses a group text message', () => {
  const [message] = parseUpsert(upsert({
    key: { remoteJid: '120363000000000000@g.us', fromMe: false, id: '3EB01', participant: '27747778886@s.whatsapp.net' },
    pushName: 'David',
    messageTimestamp: 1762345678901,
    message: { conversation: 'hello group' }
  }));
  assert.equal(message.chatId, '120363000000000000@g.us');
  assert.equal(message.isGroup, true);
  assert.equal(message.senderId, '27747778886@s.whatsapp.net');
  assert.equal(message.senderName, 'David');
  assert.equal(message.text, 'hello group');
  assert.equal(message.messageId, '3EB01');
});

test('parses a direct chat message', () => {
  const [message] = parseUpsert(upsert({
    key: { remoteJid: '27747778886@s.whatsapp.net', fromMe: false, id: 'm1' },
    message: { extendedTextMessage: { text: 'hi there' } }
  }));
  assert.equal(message.isGroup, false);
  assert.equal(message.text, 'hi there');
});

test('ignores our own outbound messages and non-text payloads', () => {
  assert.deepEqual(parseUpsert(upsert({
    key: { remoteJid: '120363000000000000@g.us', fromMe: true, id: 'own' },
    message: { conversation: 'bot reply' }
  })), []);
  assert.deepEqual(parseUpsert(upsert({
    key: { remoteJid: '120363000000000000@g.us', fromMe: false, id: 'img' },
    message: { imageMessage: {} }
  })), []);
  assert.deepEqual(parseUpsert(upsert({
    key: { remoteJid: '120363000000000000@g.us', fromMe: false, id: 'react' },
    message: { reactionMessage: { text: '👍' } }
  })), []);
});

test('ignores other events and malformed payloads', () => {
  assert.deepEqual(parseUpsert({ event: 'CONNECTION_UPDATE', data: { key: {} } }), []);
  assert.deepEqual(parseUpsert(null), []);
  assert.deepEqual(parseUpsert({ event: 'MESSAGES_UPSERT', data: null }), []);
  assert.deepEqual(parseUpsert(upsert(null)), []);
  assert.deepEqual(parseUpsert(upsert({ key: null })), []);
  assert.deepEqual(parseUpsert(upsert({ key: { remoteJid: 'broadcast@newsletter' } })), []);
});

test('accepts an array of messages in one payload', () => {
  const messages = parseUpsert({ event: 'MESSAGES_UPSERT', data: [
    { key: { remoteJid: '1@s.whatsapp.net', fromMe: false, id: 'a' }, message: { conversation: 'one' } },
    { key: { remoteJid: '2@s.whatsapp.net', fromMe: false, id: 'b' }, message: { conversation: 'two' } }
  ] });
  assert.equal(messages.length, 2);
});

test('extractText understands caption and reaction shapes', () => {
  assert.equal(extractText({ imageMessage: { caption: 'look' } }), 'look');
  assert.equal(extractText({ reactionMessage: { text: 'x' } }), '');
  assert.equal(extractText(null), '');
});

test('jid helpers classify groups, dms and unknown ids', () => {
  assert.equal(isGroup('120363@g.us'), true);
  assert.equal(isGroup('277@s.whatsapp.net'), false);
  assert.equal(isDirect('277@s.whatsapp.net'), true);
  assert.equal(isDirect('120363@g.us'), false);
});

test('accepts the dotted event name Evolution actually sends', () => {
  const [message] = parseUpsert({
    event: 'messages.upsert',
    instance: 'stewie',
    data: {
      key: { remoteJid: '120363000000000000@g.us', fromMe: false, id: '3EB02', participant: '27747778886@s.whatsapp.net' },
      pushName: 'David Nkana',
      message: { conversation: 'stewie whats up?' },
      messageTimestamp: 1793790334
    }
  });
  assert.equal(message.text, 'stewie whats up?');
  assert.equal(message.isGroup, true);
});

test('still accepts the upper-case event name', () => {
  const [message] = parseUpsert(upsert({
    key: { remoteJid: '27747778886@s.whatsapp.net', fromMe: false, id: 'x' },
    message: { conversation: 'hello' }
  }));
  assert.equal(message.text, 'hello');
});

test('normalizes event names consistently', () => {
  assert.equal(require('../src/parse').normalizeEvent('messages.upsert'), 'MESSAGES_UPSERT');
  assert.equal(require('../src/parse').normalizeEvent('MESSAGES_UPSERT'), 'MESSAGES_UPSERT');
  assert.equal(require('../src/parse').normalizeEvent('connection.update'), 'CONNECTION_UPDATE');
});

test('ignores other Evolution events', () => {
  assert.deepEqual(parseUpsert({ event: 'connection.update', data: { key: { remoteJid: '1@s.whatsapp.net' } } }), []);
  assert.deepEqual(parseUpsert({ event: 'send.message', data: { key: { remoteJid: '1@s.whatsapp.net' } } }), []);
});
