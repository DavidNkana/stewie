const { extractText } = require('../parse');

/**
 * Searches recent chat history so the bot can answer "what did we say about X".
 */
async function searchHistory({ evolution, chatId, query, limit = 40, chats }) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  const targets = chatId ? [chatId] : (chats || []).slice(0, 5);
  const results = [];

  for (const target of targets) {
    let payload;
    try {
      payload = await evolution.findMessages(target, limit);
    } catch {
      continue;
    }
    const records = Array.isArray(payload) ? payload : payload?.messages?.records || [];
    for (const record of records) {
      const text = extractText(record.message);
      if (!text || !text.toLowerCase().includes(needle)) continue;
      results.push({
        chatId: target,
        from: record.pushName || record.key?.participant || 'unknown',
        when: record.messageTimestamp ? new Date(record.messageTimestamp * 1000).toISOString() : null,
        text: text.slice(0, 500)
      });
    }
    if (results.length >= 20) break;
  }

  return results.slice(0, 20);
}

module.exports = { searchHistory };
