const stewie = require('./stewie');
const hector = require('./hector');

const PERSONAS = { [stewie.id]: stewie, [hector.id]: hector };

/**
 * Resolves a persona reference into prompt text.
 * Accepts a registered id ("stewie", "hector"), free text, or null.
 * Free text wins so a chat can be given a one-off voice.
 */
function resolvePersona(value, fallbackId = 'stewie') {
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    const known = PERSONAS[trimmed.toLowerCase()];
    if (known) return { id: known.id, name: known.name, text: known.prompt, source: 'registry' };
    return { id: null, name: null, text: trimmed, source: 'custom' };
  }
  const fallback = PERSONAS[fallbackId] || PERSONAS.stewie;
  return { id: fallback.id, name: fallback.name, text: fallback.prompt, source: 'default' };
}

function listPersonas() {
  return Object.values(PERSONAS).map(persona => ({
    id: persona.id,
    name: persona.name,
    prompt: persona.prompt
  }));
}

module.exports = { PERSONAS, resolvePersona, listPersonas };
