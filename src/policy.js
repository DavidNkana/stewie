const QUESTION_WORDS = ['what', 'who', 'where', 'when', 'why', 'how', 'which', 'can you', 'could you', 'do you', 'did you', 'is there', 'anyone', 'anybody'];
// Signals that a group message is open to input, so the assistant can add
// value instead of waiting to be called by name.
const INPUT_MARKERS = /\b(thoughts|any idea|any ideas|anyone know|does anyone|who has|who knows|can we|should we|how do we|what do you think|what's the plan|whats the plan|need(s)? (help|a hand|someone)|help me|remind me|deadline|invoice|quote|proposal|budget|price|pricing|client|customer|project|deploy|deployment|website|domain|task|meeting|launch|bug|fix|support|payment|contract|app (build|idea|development))\b/i;

// Phrases that show a message is aimed at the assistant, even without its name.
const ADDRESSED_PATTERNS = [
  /^(hey |ok |yo |hmm |right )?(hitch|stewie|alex)\b/i,
  /^(can|could|would|will|you)\b/i,
  /^please\b/i,
  /^help me\b/i,
  /^what do you (think|reckon|suggest)\b/i,
  /^any (idea|thoughts|suggestions)\b/i,
  /^(thoughts|ideas|suggestions|advice)\b/i,
  /^(check|look at|read|open|view|download|remind|calculate|work out|figure out)\b/i,
  /^(give|send|post|reply|follow up|draft|set up|arrange)\b/i,
  /^what('s| is) the\b/i,
  /^how (do|should|much|many)\b/i,
  /^(do|can you) (you|we)\b/i
];

// Group chat rarely uses question marks, so these markers count anywhere.
const QUESTION_MARKERS = /\b(anyone|anybody|anyone\s+else|can someone|could someone|can somebody|help|quick one|any idea|thoughts|opinions|what do you think|anyone know)\b/i;

/**
 * Decides whether the bot should answer a given message.
 * Every rejection has a stable reason code so behaviour is auditable.
 */
function createPolicy(config, options = {}) {
  const random = options.random || Math.random;
  const now = options.now || (() => Date.now());

  function mentionsBot(text) {
    const haystack = String(text || '').toLowerCase();
    const names = [config.botName, ...(config.aliases || [])].filter(Boolean).map(name => name.toLowerCase());
    if (!names.length) return false;
    return names.some(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
    });
  }

  function isAddressed(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    return ADDRESSED_PATTERNS.some(pattern => pattern.test(value));
  }

  function isQuestion(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    if (trimmed.endsWith('?')) return true;
    const lower = trimmed.toLowerCase();
    if (QUESTION_WORDS.some(word => lower.startsWith(word))) return true;
    return QUESTION_MARKERS.test(trimmed);
  }

  function decide(input) {
    const { message, settings, lastReplyAt = 0, chatReplyCount = 0, globalReplyCount = 0 } = input;
    const mode = settings.mode || (message.isGroup ? config.groupMode : config.dmMode);

    if (settings.enabled === false) return { reply: false, reason: 'disabled' };
    if (mode === 'never') return { reply: false, reason: 'mode_never' };

    const mentioned = mentionsBot(message.text);
    const question = isQuestion(message.text);

    if (mode === 'mention' && !mentioned) return { reply: false, reason: 'not_mentioned' };
    if (mode === 'question' && !mentioned && !question) return { reply: false, reason: 'not_a_question' };
    if (mode === 'addressed' && !mentioned && !question && !isAddressed(message.text)) {
      return { reply: false, reason: 'not_addressed' };
    }
    if (mode === 'active' && !mentioned && !question && !isAddressed(message.text) && !INPUT_MARKERS.test(message.text)) {
      return { reply: false, reason: 'not_addressed' };
    }

    const cooldownMs = Math.max(0, config.cooldownSeconds) * 1000;
    if (cooldownMs && lastReplyAt && now() - lastReplyAt < cooldownMs) {
      return { reply: false, reason: 'cooldown' };
    }

    const hourAgo = now() - 60 * 60 * 1000;
    if (config.maxRepliesPerChatPerHour && chatReplyCount >= config.maxRepliesPerChatPerHour) {
      return { reply: false, reason: 'chat_hourly_cap' };
    }
    if (config.maxRepliesPerHour && globalReplyCount >= config.maxRepliesPerHour) {
      return { reply: false, reason: 'global_hourly_cap' };
    }

    // Probability gates organic replies only. An explicit mention always answers.
    const probability = settings.probability ?? config.responseProbability;
    if (!mentioned && probability < 1 && random() > probability) return { reply: false, reason: 'probability' };

    return { reply: true, reason: mentioned ? 'mentioned' : question ? 'question' : 'mode_always' };
  }

  return { decide, mentionsBot, isQuestion, isAddressed, INPUT_MARKERS };
}

module.exports = { createPolicy, QUESTION_WORDS };
