const TEAM = 'TEAM';
const CLIENT = 'CLIENT';

/**
 * Mode routing.
 *
 * Mode is decided only from trusted provider metadata: the verified event's
 * group flag and the exact configured internal group id. Nothing a person
 * writes can change it, and a private message is always CLIENT mode.
 */
function parseInternalGroupIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function resolveMode({ isGroup = false, chatId = '', internalGroupIds = [] } = {}) {
  const ids = parseInternalGroupIds(internalGroupIds);

  if (!isGroup) {
    return { mode: CLIENT, reason: 'private_message', internalGroupIds: ids };
  }
  if (!ids.length) {
    return {
      mode: CLIENT,
      reason: 'no_internal_group_configured',
      warning: 'No internal team group id is configured, so every conversation is in CLIENT mode. Configure STEWIE_INTERNAL_GROUP_IDS.',
      internalGroupIds: ids
    };
  }
  if (ids.includes(String(chatId))) {
    return { mode: TEAM, reason: 'configured_internal_group', internalGroupIds: ids };
  }
  return { mode: CLIENT, reason: 'not_internal_group', internalGroupIds: ids };
}

module.exports = { TEAM, CLIENT, resolveMode, parseInternalGroupIds };
