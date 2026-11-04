const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Caches the account's group list.
 *
 * Evolution needs ~20s to enumerate 96 groups, which is far too slow for an
 * admin call and would trip the request timeout. The list rarely changes, so
 * it is cached in memory and mirrored to disk for fast startup.
 */
function createGroupDirectory(options) {
  const { evolution, logger, ttlMs = DEFAULT_TTL_MS, cacheFile = 'data/groups-cache.json' } = options;
  let cache = { groups: [], fetchedAt: 0 };

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (parsed && Array.isArray(parsed.groups)) {
        cache = { groups: parsed.groups, fetchedAt: Number(parsed.fetchedAt) || 0 };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('group_cache_read_failed', { error: error.message });
    }
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(path.resolve(cacheFile)), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache), { mode: 0o600 });
    } catch (error) {
      logger.warn('group_cache_write_failed', { error: error.message });
    }
  }

  async function refresh() {
    try {
      const groups = await evolution.fetchGroups();
      const list = Array.isArray(groups) ? groups : Array.isArray(groups?.groups) ? groups.groups : [];
      const mapped = list
        .map(group => ({ id: group?.id || group?.jid, name: group?.subject || group?.name || null }))
        .filter(group => group.id);
      if (mapped.length) {
        cache = { groups: mapped, fetchedAt: Date.now() };
        persist();
        logger.info('group_directory_refreshed', { count: mapped.length });
      }
      return mapped;
    } catch (error) {
      logger.warn('group_directory_refresh_failed', { error: error.message });
      return cache.groups;
    }
  }

  async function list({ force = false } = {}) {
    const fresh = Date.now() - cache.fetchedAt < ttlMs;
    if (!force && cache.groups.length && fresh) return cache.groups;
    if (!cache.groups.length) return refresh();
    // Serve the stale list immediately, refresh in the background.
    refresh();
    return cache.groups;
  }

  load();

  return {
    list,
    refresh,
    prime: () => refresh(),
    get size() {
      return cache.groups.length;
    }
  };
}

module.exports = { createGroupDirectory, DEFAULT_TTL_MS };
