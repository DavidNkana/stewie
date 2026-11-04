const { slugify } = require('./store');

const SYSTEM = [
  'You write compact role-play system prompts for a chat bot.',
  'Describe a character as an original character description: voice, vocabulary, mannerisms, typical message length, attitude, and what to avoid.',
  'Never reproduce copyrighted dialogue, catchphrases lifted from scripts, or any actual lines from the film.',
  'Never say the character is an AI or a bot, and never write "you are an AI".',
  'Write plain prose, no headings, no bullet points, no markdown, under 130 words.',
  'Output only the description.'
].join(' ');

function buildUserPrompt({ character, notes }) {
  return [
    `Character: ${character}`,
    notes ? `Extra instructions from the operator: ${notes}` : '',
    '',
    'Write the system prompt for this character as they would talk in a WhatsApp group.'
  ].filter(Boolean).join('\n');
}

/**
 * Compiles a character into a reusable persona prompt using the model.
 * Returns { id, name, prompt } ready to be persisted by the persona store.
 */
async function compilePersona({ character, notes, complete }) {
  const name = String(character || '').trim();
  if (!name) throw new Error('character is required');
  const prompt = (await complete({
    system: SYSTEM,
    user: buildUserPrompt({ character: name, notes })
  })).trim();
  if (!prompt) throw new Error('character compiler returned no text');
  return { id: slugify(name), name, prompt };
}

module.exports = { compilePersona, buildUserPrompt, SYSTEM };
