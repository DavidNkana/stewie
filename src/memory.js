const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: null,
  persona: null,
  probability: null,
  name: null
};

/**
 * Rolling per-chat memory plus reply accounting.
 * State lives in a single JSON file (0600) and is pruned by retention.
 */
function createMemory(options = {}) {
  const file = options.file || 'data/state.json';
  const retentionDays = options.retentionDays ?? 7;
  const historySize = options.historySize ?? 20;
  const now = options.now || (() => Date.now());

  const state = readState();

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        chats: parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
        processed: parsed.processed && typeof parsed.processed === 'object' ? parsed.processed : {}
      };
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('state read failed:', error.message);
      return { chats: {}, processed: {} };
    }
  }

  function cutoff() {
    return now() - Math.max(0, retentionDays) * 24 * 60 * 60 * 1000;
  }

  function prune() {
    const limit = cutoff();
    for (const [id, chat] of Object.entries(state.chats)) {
      chat.messages = (chat.messages || []).filter(entry => Number(entry.ts) >= limit);
      chat.replies = (chat.replies || []).filter(ts => Number(ts) >= limit);
      // Never drop a chat the operator configured explicitly, even if it has no traffic.
      if (!chat.messages.length && !(chat.replies || []).length && !chat.configured) delete state.chats[id];
    }
    for (const [id, ts] of Object.entries(state.processed)) {
      if (Number(ts) < limit) delete state.processed[id];
    }
  }

  function save() {
    prune();
    const dir = path.dirname(path.resolve(file));
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  // Expired records are dropped as soon as the state is loaded, not only on save.
  prune();

  function chat(id, kind = 'dm') {
    if (!state.chats[id]) {
      state.chats[id] = { id, kind, ...DEFAULT_SETTINGS, messages: [], replies: [], lastReplyAt: 0 };
    }
    if (kind && state.chats[id].kind !== kind) state.chats[id].kind = kind;
    return state.chats[id];
  }

  return {
    get file() {
      return file;
    },
    save,
    chat,
    chats() {
      return Object.values(state.chats);
    },
    settings(id, kind) {
      const record = chat(id, kind);
      return { ...DEFAULT_SETTINGS, ...record };
    },
    updateSettings(id, patch, kind) {
      const record = chat(id, kind);
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (patch[key] !== undefined) record[key] = patch[key];
      }
      record.configured = true;
      save();
      return this.settings(id, kind);
    },
    record(id, entry, kind) {
      const record = chat(id, kind);
      // Retention is measured from when we ingested the message, not from the
      // sender's clock, so a skewed or replayed timestamp cannot wipe history.
      const stored = { ...entry, ts: now() };
      if (entry.sourceTs === undefined && entry.ts !== undefined) stored.sourceTs = entry.ts;
      record.messages = [...(record.messages || []), stored].slice(-historySize);
      save();
    },
    history(id, limit = historySize, kind) {
      const record = chat(id, kind);
      return (record.messages || []).slice(-limit);
    },
    isProcessed(messageId) {
      return Boolean(messageId && state.processed[messageId]);
    },
    markProcessed(messageId) {
      if (!messageId) return;
      state.processed[messageId] = now();
      save();
    },
    noteReply(id, kind) {
      const record = chat(id, kind);
      record.lastReplyAt = now();
      record.replies = [...(record.replies || []), record.lastReplyAt];
      save();
    },
    lastReplyAt(id, kind) {
      return chat(id, kind).lastReplyAt || 0;
    },
    repliesSince(id, since, kind) {
      return (chat(id, kind).replies || []).filter(ts => Number(ts) >= since).length;
    },
    totalRepliesSince(since) {
      let total = 0;
      for (const record of Object.values(state.chats)) {
        total += (record.replies || []).filter(ts => Number(ts) >= since).length;
      }
      return total;
    }
  };
}

module.exports = { createMemory, DEFAULT_SETTINGS };
