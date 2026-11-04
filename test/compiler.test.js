const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compilePersona, buildUserPrompt } = require('../personality/compiler');
const { slugify } = require('../personality/store');

test('the compiler asks the model for an original description', async () => {
  let captured;
  const compiled = await compilePersona({
    character: 'The Godfather',
    notes: 'restrained, offers advice',
    complete: async args => {
      captured = args;
      return 'You are calm and deliberate.';
    }
  });
  assert.equal(compiled.id, 'the-godfather');
  assert.equal(compiled.name, 'The Godfather');
  assert.equal(compiled.prompt, 'You are calm and deliberate.');
  assert.match(captured.system, /Never reproduce copyrighted dialogue/);
  assert.match(captured.user, /The Godfather/);
  assert.match(captured.user, /restrained, offers advice/);
});

test('the compiler refuses an empty character', async () => {
  await assert.rejects(() => compilePersona({ character: '  ', complete: async () => 'x' }), /character is required/);
});

test('slugs are filesystem safe', () => {
  assert.equal(slugify('Sherlock Holmes!'), 'sherlock-holmes');
  assert.equal(slugify('  Darth Vader  '), 'darth-vader');
  assert.equal(slugify('A/B Testing'), 'a-b-testing');
});

test('the user prompt includes the character and operator notes', () => {
  const prompt = buildUserPrompt({ character: 'Wolverine', notes: 'gruff, short' });
  assert.match(prompt, /Wolverine/);
  assert.match(prompt, /gruff, short/);
});

test('custom personas persist to disk with restrictive permissions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-persona-'));
  const file = path.join(dir, 'custom.json');
  process.env.STEWIE_PERSONA_FILE = file;
  const store = require('../personality/store');
  const saved = store.saveCustom({ id: 'Test Character', name: 'Test Character', prompt: 'be testy' });
  assert.equal(saved.id, 'test-character');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.getCustom('test-character').prompt, 'be testy');
  delete process.env.STEWIE_PERSONA_FILE;
});
