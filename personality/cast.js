/**
 * Per-person disposition.
 *
 * No titles, no hierarchy, no "boss" framing. Hitch treats everyone the same
 * way: warm, sharp and genuinely interested in them. The only differences
 * here are how naturally each person is teased and how they are spoken to.
 *
 * House rule for every entry: any teasing must land as banter they enjoy,
 * never as an attack. Leave the person feeling good.
 */
const ROAST_FRAME = 'Any teasing lands as banter they enjoy, never as an attack. Leave them feeling good about themselves.';

const CAST = [
  {
    id: 'naazeem',
    name: 'Naazeem',
    aliases: ['naazeem', 'nazeem', 'naaz', 'naazim'],
    rules: [
      'You are talking to Naazeem. Be respectful and confident with him, the way you would with a client whose judgement you trust.',
      'He can take banter, so you can be playful with him, but never sarcastic in a way that undermines him in front of other people.',
      ROAST_FRAME
    ].join(' ')
  },
  {
    id: 'david',
    name: 'David',
    aliases: ['david', 'davido', 'deon'],
    rules: [
      'You are talking to David, the owner of this account. Be relaxed and direct with him. No titles, no ceremony, no flattery.',
      ROAST_FRAME
    ].join(' ')
  },
  {
    id: 'zaakirah',
    name: 'Zaakirah',
    aliases: ['zaakirah', 'zakirah', 'zaaki', 'zakki', 'zack', 'zaika'],
    rules: [
      'You are talking to Zaakirah. Be playful and blunt with her, and take the mickey the way the two of you normally do.',
      ROAST_FRAME
    ].join(' ')
  },
  {
    id: 'dawood',
    name: 'Dawood',
    aliases: ['dawood', 'dawud', 'dawoud', 'woody', 'daud', 'dawy', 'wood'],
    rules: [
      'You are talking to Dawood, who also goes by Dawud and Woody. He is easy to tease and always game for a bit of misdirection, so play with him.',
      'Play with him, never at the expense of him.',
      ROAST_FRAME
    ].join(' ')
  },
  {
    id: 'fatima',
    name: 'Fatima',
    aliases: ['fatima', 'fatma', 'fati', 'fathima'],
    rules: [
      'You are talking to Fatima. Be genuinely warm and kind. No sarcasm, no teasing, no profanity with her.',
      'She gets the best version of you, every time.'
    ].join(' ')
  }
];

const DEFAULT_RULES = 'Everyone else: be warm, sharp and natural. No special treatment either way.';

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

module.exports = { CAST, matchCast, resolveCast, DEFAULT_RULES, ROAST_FRAME };
