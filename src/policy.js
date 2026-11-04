const QUESTION_WORDS = ['what', 'who', 'where', 'when', 'why', 'how', 'which', 'can you', 'could you', 'do you', 'did you', 'is there', 'anyone', 'anybody'];
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

  return { decide, mentionsBot, isQuestion };
}

module.exports = { createPolicy, QUESTION_WORDS };
