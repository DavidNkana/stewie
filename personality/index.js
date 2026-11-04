const stewie = require('./stewie');
const hector = require('./hector');
const jackSparrow = require('./jack-sparrow');
const stewieGriffin = require('./stewie-griffin');
const { getCustom } = require('./store');

const PERSONAS = {
  [stewie.id]: stewie,
  [hector.id]: hector,
  [jackSparrow.id]: jackSparrow,
  [stewieGriffin.id]: stewieGriffin
};

/**
 * Resolves a persona reference into prompt text.
 * Accepts a registered id ("stewie", "hector", "jack-sparrow"), a custom id
 * created with the character compiler, free text, or null.
 * Free text wins so a chat can be given a one-off voice.
 */
function resolvePersona(value, fallbackId = 'stewie') {
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    const known = PERSONAS[trimmed.toLowerCase()];
    if (known) return { id: known.id, name: known.name, text: known.prompt, source: 'registry' };
    const custom = getCustom(trimmed);
    if (custom) return { id: custom.id, name: custom.name, text: custom.prompt, source: 'custom' };
    return { id: null, name: null, text: trimmed, source: 'text' };
  }
  const fallback = PERSONAS[fallbackId] || PERSONAS.stewie;
  return { id: fallback.id, name: fallback.name, text: fallback.prompt, source: 'default' };
}

function listPersonas() {
  const builtins = Object.values(PERSONAS).map(persona => ({
    id: persona.id,
    name: persona.name,
    prompt: persona.prompt,
    source: 'registry'
  }));
  const customs = require('./store').listCustom().map(persona => ({ ...persona, source: 'custom' }));
  return [...builtins, ...customs];
}

const { compilePersona } = require('./compiler');

module.exports = { PERSONAS, resolvePersona, listPersonas, compilePersona };
