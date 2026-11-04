const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePersona, listPersonas } = require('../personality');

test('registered ids resolve to their prompt', () => {
  const persona = resolvePersona('hector');
  assert.equal(persona.id, 'hector');
  assert.equal(persona.source, 'registry');
  assert.match(persona.text, /Hector/);
});

test('free text is treated as a text persona', () => {
  const persona = resolvePersona('be a grumpy accountant');
  assert.equal(persona.source, 'text');
  assert.equal(persona.text, 'be a grumpy accountant');
});

test('no value falls back to the default persona', () => {
  const persona = resolvePersona(null);
  assert.equal(persona.id, 'stewie');
  assert.equal(persona.source, 'default');
});

test('persona ids are case insensitive', () => {
  assert.equal(resolvePersona('Stewie').id, 'stewie');
});

test('the registry exposes the built in personas', () => {
  const ids = listPersonas().map(persona => persona.id);
  for (const builtin of ['hector', 'jack-sparrow', 'stewie']) {
    assert.ok(ids.includes(builtin), `missing builtin persona ${builtin}`);
  }
});
