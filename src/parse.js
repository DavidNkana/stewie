/**
 * Normalizes Evolution API (Baileys) webhook payloads into a stable shape.
 *
 * Reference payload (MESSAGES_UPSERT):
 * {
 *   event: 'MESSAGES_UPSERT',
 *   instance: 'stewie',
 *   data: {
 *     key: { remoteJid: '120363...@g.us', fromMe: false, id: '3EB0...', participant: '277...@s.whatsapp.net' },
 *     pushName: 'David',
 *     messageTimestamp: 1762345678901,
 *     message: { conversation: 'hello' }
 *   }
 * }
 */

const GROUP_SUFFIX = '@g.us';
const USER_SUFFIX = '@s.whatsapp.net';
const LID_SUFFIX = '@lid';

function isGroup(jid) {
  return typeof jid === 'string' && jid.endsWith(GROUP_SUFFIX);
}

function isDirect(jid) {
  return typeof jid === 'string' && (jid.endsWith(USER_SUFFIX) || jid.endsWith(LID_SUFFIX));
}

/** Pull plain text out of the many Baileys message shapes. */
function extractText(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.conversation === 'string') return message.conversation;
  const extended = message.extendedTextMessage;
  if (extended && typeof extended.text === 'string') return extended.text;
  const image = message.imageMessage || message.videoMessage || message.documentMessage;
  if (image && typeof image.caption === 'string') return image.caption;
  if (message.buttonsResponseMessage?.selectedButtonId) return message.buttonsResponseMessage.selectedButtonId;
  if (message.listResponseMessage?.singleSelectReply?.selectedRowId) return message.listResponseMessage.singleSelectReply.selectedRowId;
  if (message.reactionMessage?.text) return '';
  return '';
}

/**
 * Evolution sends the raw event name in the payload (for example
 * "messages.upsert" or "connection.update") while the webhook subscription
 * filter uses the upper-cased form ("MESSAGES_UPSERT"). Normalise both sides
 * so an event is never silently dropped because of naming.
 */
function normalizeEvent(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '_').toUpperCase();
}

/**
 * Returns an array of normalized inbound messages.
 * Non-text messages, status updates and our own outbound messages are dropped.
 */
function parseUpsert(payload) {
  const results = [];
  if (!payload || typeof payload !== 'object') return results;
  if (normalizeEvent(payload.event) !== 'MESSAGES_UPSERT') return results;

  const data = payload.data;
  if (!data || typeof data !== 'object') return results;

  // Evolution may deliver a single message object or an array of them.
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const key = item.key;
    if (!key || typeof key !== 'object') continue;

    const chatId = typeof key.remoteJid === 'string' ? key.remoteJid : '';
    if (!chatId) continue;
    if (!isGroup(chatId) && !isDirect(chatId)) continue;

    // fromMe covers both the bot's own replies and the human owner typing.
    if (key.fromMe === true) continue;

    const text = extractText(item.message);
    if (!text || !text.trim()) continue;

    const senderId = typeof key.participant === 'string' && key.participant ? key.participant : chatId;
    const timestamp = Number(item.messageTimestamp) || Date.now();

    results.push({
      messageId: typeof key.id === 'string' ? key.id : '',
      chatId,
      isGroup: isGroup(chatId),
      senderId,
      senderName: typeof item.pushName === 'string' ? item.pushName : '',
      text: text.trim(),
      timestamp
    });
  }
  return results;
}

module.exports = { parseUpsert, extractText, isGroup, isDirect, normalizeEvent, GROUP_SUFFIX, USER_SUFFIX };
