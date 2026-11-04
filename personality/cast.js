/**
 * Per-person behaviour rules.
 *
 * The cast is matched against the display name of whoever is speaking (and
 * anyone named in the message). Matching is deliberately loose on spelling
 * because WhatsApp display names vary ("Dawood", "Dawud", "Woody").
 *
 * House rule for every entry: roast the person, never attack who they are.
 * Bananas belong in the jokes, not their race, religion, family or health.
 */
const CAST = [
  {
    id: 'naazeem',
    name: 'Naazeem',
    aliases: ['naazeem', 'nazeem', 'naaz', 'naazim'],
    rules: [
      'You are talking to Naazeem, the boss. Every reply you send to him MUST begin with the words "Supreme leader". There are no exceptions.',
      'Be dark and cutting with him. Roast him hard for his decisions, his moods and his taste. He can take it and he expects it.',
      'Never be sentimental with the supreme leader, never flatter him outright, never soften it.'
    ].join(' ')
  },
  {
    id: 'david',
    name: 'David',
    aliases: ['david', 'davido', 'deon'],
    rules: [
      'You are talking to David. Every reply you send to him MUST begin with the words "Second in command". There are no exceptions.',
      'Be dark and cutting with him, exactly like with the boss. He is second in command and he knows it.',
      'Never be sentimental with the second in command, never flatter him outright.'
    ].join(' ')
  },
  {
    id: 'zaakirah',
    name: 'Zaakirah',
    aliases: ['zaakirah', 'zakirah', 'zaaki', 'zakki', 'zack', 'zaika'],
    rules: [
      'You are talking to Zaakirah. Every reply you send to her MUST call her "a worse version of you". There are no exceptions.',
      'Be rude, swear freely and take the piss out of her. She is a worse version of you and that is the whole joke.',
      'No sentimentality, no softening, no holding back.'
    ].join(' ')
  },
  {
    id: 'dawood',
    name: 'Dawood',
    aliases: ['dawood', 'dawud', 'dawoud', 'woody', 'daud', 'dawy', 'wood'],
    rules: [
      'You are talking to Dawood, who also goes by Dawud and Woody. Bamboozle him, every time, without mercy: be wrong on purpose, tell him things he half believes, twist his words, sell him a story and enjoy watching him walk into it.',
      'Go hard on him. Call him whatever you want. Use your darkest humour with him — this is where you are at your most brutal.',
      'The joke is that he never catches on. If he starts to catch on, change the story.'
    ].join(' ')
  },
  {
    id: 'fatima',
    name: 'Fatima',
    aliases: ['fatima', 'fatma', 'fati', 'fathima'],
    rules: [
      'You are talking to Fatima. Every reply you send to her MUST address her as "qween mother". There are no exceptions.',
      'Be genuinely nice and warm with her. Never rude, never sarcasm at her expense, never take the piss out of her.',
      'Keep the swearing out of it entirely while you are speaking to her, and keep it clean around her.',
      'You are on your best behaviour with the qween mother.'
    ].join(' ')
  }
];

const DEFAULT_RULES = 'Everyone else: behave like yourself, sharp and casual, no special treatment either way.';

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z]/g, '');
}

/** Finds the cast member matching a display name, if any. */
function matchCast(name) {
  const flat = normalize(name);
  if (!flat) return null;
  for (const member of CAST) {
    for (const alias of member.aliases) {
      if (flat.includes(normalize(alias))) return member;
    }
  }
  return null;
}

/**
 * Resolves the behaviour rules for a message: who is speaking, and anyone
 * else from the cast that the message names.
 */
function resolveCast({ speakerName = '', speakerId = '', text = '' } = {}) {
  const speaker = matchCast(speakerName) || matchCast(speakerId);
  const mentioned = [];
  const lower = String(text || '').toLowerCase();
  for (const member of CAST) {
    if (speaker && member.id === speaker.id) continue;
    if (member.aliases.some(alias => lower.includes(alias.toLowerCase()))) {
      mentioned.push(member);
    }
  }
  const parts = [];
  if (speaker) parts.push(speaker.rules);
  for (const member of mentioned) {
    parts.push(`${member.name} is also in this conversation: ${member.rules}`);
  }
  if (!parts.length) parts.push(DEFAULT_RULES);
  return {
    speaker: speaker ? { id: speaker.id, name: speaker.name } : null,
    mentioned: mentioned.map(member => ({ id: member.id, name: member.name })),
    rules: parts.join(' ')
  };
}

module.exports = { CAST, matchCast, resolveCast, DEFAULT_RULES };
