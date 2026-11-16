const fs = require('node:fs');
const path = require('node:path');

/**
 * Known client facts.
 *
 * Only the fields the brief allows are stored, only against the verified chat
 * they were said in, and only for as long as the retention window allows.
 * A client number is never treated as consent or as buying intent.
 */
const ALLOWED_FIELDS = [
  'name',
  'business',
  'projectPurpose',
  'platforms',
  'requiredFeatures',
  'budget',
  'desiredTiming',
  'currentStage',
  'consentForNextStep'
];

function createLeadStore(options = {}) {
  const file = options.file || 'data/leads.json';
  const retentionDays = options.retentionDays ?? 90;
  const now = options.now || (() => Date.now());
  let records = load();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('lead read failed:', error.message);
      return {};
    }
  }

  function save() {
    const dir = path.dirname(path.resolve(file));
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(records, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  function prune() {
    const limit = now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const [chatId, record] of Object.entries(records)) {
      if ((record.updatedAt || 0) < limit) delete records[chatId];
    }
  }

  return {
    record(chatId, facts) {
      if (!chatId) throw new Error('facts need a verified chat');
      const clean = {};
      for (const field of ALLOWED_FIELDS) {
        if (facts[field] !== undefined && facts[field] !== null && facts[field] !== '') {
          clean[field] = typeof facts[field] === 'string'
            ? facts[field].slice(0, 500)
            : facts[field];
        }
      }
      const existing = records[chatId] || { chatId, createdAt: now(), facts: {} };
      existing.facts = { ...existing.facts, ...clean };
      existing.updatedAt = now();
      records[chatId] = existing;
      prune();
      save();
      return existing;
    },
    get(chatId) {
      prune();
      return records[chatId] || null;
    },
    all() {
      prune();
      return Object.values(records);
    },
    remove(chatId) {
      const existed = Boolean(records[chatId]);
      delete records[chatId];
      if (existed) save();
      return existed;
    }
  };
}

module.exports = { createLeadStore, ALLOWED_FIELDS };
