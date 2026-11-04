const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemory } = require('../src/memory');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-')), 'state.json');
}

test('records history and caps it at the configured size', () => {
  const memory = createMemory({ file: tempFile(), historySize: 3 });
  memory.record('chat', { role: 'user', text: 'one', ts: Date.now() });
  memory.record('chat', { role: 'assistant', text: 'two', ts: Date.now() });
  memory.record('chat', { role: 'user', text: 'three', ts: Date.now() });
  memory.record('chat', { role: 'user', text: 'four', ts: Date.now() });
  const history = memory.history('chat');
  assert.equal(history.length, 3);
  assert.equal(history[0].text, 'two');
});

test('processed message ids are remembered', () => {
  const memory = createMemory({ file: tempFile() });
  assert.equal(memory.isProcessed('abc'), false);
  memory.markProcessed('abc');
  assert.equal(memory.isProcessed('abc'), true);
});

test('reply counters track per-chat and global windows', () => {
  let clock = 1_000_000;
  const memory = createMemory({ file: tempFile(), now: () => clock });
  memory.noteReply('a');
  clock += 1000;
  memory.noteReply('a');
  memory.noteReply('b');
  assert.equal(memory.repliesSince('a', 0), 2);
  assert.equal(memory.totalRepliesSince(0), 3);
});

test('settings merge with defaults and persist updates', () => {
  const file = tempFile();
  const memory = createMemory({ file });
  assert.equal(memory.settings('group-1').enabled, true);
  memory.updateSettings('group-1', { enabled: true, mode: 'always' });
  const reloaded = createMemory({ file });
  assert.equal(reloaded.settings('group-1').enabled, true);
  assert.equal(reloaded.settings('group-1').mode, 'always');
});

test('retention prunes stale records on load', () => {
  const file = tempFile();
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(file, JSON.stringify({
    chats: { old: { id: 'old', kind: 'group', messages: [{ role: 'user', text: 'x', ts: old }], replies: [old] } },
    processed: { stale: old }
  }));
  const memory = createMemory({ file, retentionDays: 1 });
  assert.equal(memory.history('old').length, 0);
  assert.equal(memory.isProcessed('stale'), false);
});

test('state file is written with restrictive permissions', () => {
  const file = tempFile();
  const memory = createMemory({ file });
  memory.record('chat', { role: 'user', text: 'secret', ts: Date.now() });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('history retention uses ingestion time, not the sender clock', () => {
  const memory = createMemory({ file: tempFile(), retentionDays: 1 });
  const stale = Date.now() - 400 * 24 * 60 * 60 * 1000;
  memory.record('chat', { role: 'user', text: 'old clock', ts: stale });
  const history = memory.history('chat');
  assert.equal(history.length, 1);
  assert.ok(history[0].ts > stale);
  assert.equal(history[0].sourceTs, stale);
});

test('changing the persona clears our own prior replies but keeps the chat context', () => {
  const memory = createMemory({ file: tempFile() });
  memory.record('chat', { role: 'user', text: 'hi', ts: Date.now() });
  memory.record('chat', { role: 'assistant', text: 'old voice reply', ts: Date.now() });
  memory.record('chat', { role: 'user', text: 'more', ts: Date.now() });
  memory.updateSettings('chat', { persona: 'stewie-griffin' });
  const history = memory.history('chat');
  assert.equal(history.length, 2);
  assert.ok(history.every(entry => entry.role === 'user'));
});
