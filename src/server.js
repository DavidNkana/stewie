const crypto = require('node:crypto');
const { parseUpsert } = require('./parse');
const { shortHash } = require('./logger');
const { listPersonas, compilePersona } = require('../personality');
const { saveCustom, deleteCustom } = require('../personality/store');

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/**
 * Builds the stewie HTTP handler.
 * Public routes: /health, /webhook/:token, /qr/:token.
 * Admin routes require `Authorization: Bearer <STEWIE_ADMIN_TOKEN>`.
 */
function createHandler(deps) {
  const { config, evolution, memory, policy, brain, logger, directory } = deps;
  // Fallback for callers that do not provide a cached directory.
  const groupDirectory = directory || {
    list: async () => {
      try {
        const groups = await evolution.fetchGroups();
        const list = Array.isArray(groups) ? groups : Array.isArray(groups?.groups) ? groups.groups : [];
        return list
          .map(group => ({ id: group?.id || group?.jid, name: group?.subject || group?.name || null }))
          .filter(group => group.id);
      } catch (error) {
        logger.warn('group_list_failed', { error: error.message });
        return [];
      }
    }
  };
  const chains = new Map();
  // A failing send (for example while WhatsApp is unpaired) must not stall the
  // chat queue for every message, so sends are paused briefly after a failure.
  let sendBlockedUntil = 0;
  const unknownGroups = new Set();

  /** Serializes work per chat so replies never interleave in the same chat. */
  function enqueue(chatId, task) {
    const previous = chains.get(chatId) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    chains.set(chatId, next);
    next.finally(() => {
      if (chains.get(chatId) === next) chains.delete(chatId);
    }).catch(() => {});
    return next;
  }

  async function resolveGroupName(chatId) {
    const existing = memory.settings(chatId).name;
    if (existing) return existing;
    // Negative cache: an unknown group must not be looked up on every message.
    if (unknownGroups.has(chatId)) return null;
    try {
      const info = await evolution.groupInfo(chatId);
      const record = Array.isArray(info) ? info[0] : info;
      const name = record?.subject || record?.name || null;
      if (name) memory.updateSettings(chatId, { name });
      else unknownGroups.add(chatId);
      return name;
    } catch {
      unknownGroups.add(chatId);
      return null;
    }
  }

  async function handleMessage(message) {
    const kind = message.isGroup ? 'group' : 'dm';
    const chatId = message.chatId;
    memory.record(chatId, { role: 'user', text: message.text, name: message.senderName, ts: message.timestamp }, kind);

    const settings = memory.settings(chatId, kind);
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const decision = policy.decide({
      message,
      settings,
      lastReplyAt: memory.lastReplyAt(chatId, kind),
      chatReplyCount: memory.repliesSince(chatId, hourAgo, kind),
      globalReplyCount: memory.totalRepliesSince(hourAgo)
    });

    if (!decision.reply) {
      logger.info('reply_skipped', { chat: shortHash(chatId), reason: decision.reason });
      return;
    }

    const chatName = message.isGroup ? await resolveGroupName(chatId) : settings.name;
    const history = memory.history(chatId, 12, kind);
    const started = Date.now();

    let reply;
    try {
      reply = await brain.generate({ history, message, settings, chatName, kind });
    } catch (error) {
      logger.error('brain_failed', { chat: shortHash(chatId), error: error.message });
      return;
    }

    // The model may choose to stay quiet instead of replying.
    if (!reply) {
      logger.info('reply_suppressed', { chat: shortHash(chatId), kind, reason: 'model_stayed_silent' });
      return;
    }

    try {
      if (Date.now() < sendBlockedUntil) {
        logger.warn('send_skipped', { chat: shortHash(chatId), reason: 'send_backoff' });
        return;
      }
      await evolution.sendText(chatId, reply);
    } catch (error) {
      sendBlockedUntil = Date.now() + Math.max(0, config.sendBackoffMs);
      logger.error('send_failed', { chat: shortHash(chatId), error: error.message, backoffMs: config.sendBackoffMs });
      return;
    }

    memory.record(chatId, { role: 'assistant', text: reply, name: config.botName, ts: Date.now() }, kind);
    memory.noteReply(chatId, kind);
    logger.info('reply_sent', { chat: shortHash(chatId), kind, reason: decision.reason, latencyMs: Date.now() - started });
  }

  async function handleWebhook(req, res, token) {
    if (!safeEqual(token, config.webhookToken)) return json(res, 401, { error: 'unauthorized' });
    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      return json(res, 413, { error: error.message });
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: 'invalid json' });
    }
    json(res, 200, { ok: true });
    const messages = parseUpsert(payload);
    // Log every inbound envelope so a delivery that fails to parse is visible
    // instead of silently dropping the message.
    logger.info('webhook_received', {
      event: typeof payload?.event === 'string' ? payload.event : 'unknown',
      instance: typeof payload?.instance === 'string' ? payload.instance : 'unknown',
      parsed: messages.length,
      keys: Object.keys(payload || {}).join(',')
    });
    for (const message of messages) {
      if (message.messageId && memory.isProcessed(message.messageId)) continue;
      if (message.messageId) memory.markProcessed(message.messageId);
      enqueue(message.chatId, () => handleMessage(message).catch(error => logger.error('message_failed', { error: error.message })));
    }
  }

  async function handleQr(res, token, wantImage) {
    if (!safeEqual(token, config.adminToken)) return json(res, 401, { error: 'unauthorized' });
    let payload;
    try {
      payload = await evolution.qr();
    } catch (error) {
      return json(res, 502, { error: error.message });
    }
    if (wantImage) {
      if (!payload?.base64) return json(res, 404, { error: 'no qr available' });
      const buffer = Buffer.from(String(payload.base64).split(',').pop(), 'base64');
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': buffer.length });
      return res.end(buffer);
    }
    return json(res, 200, { code: payload?.code ?? null, pairingCode: payload?.pairingCode ?? null, count: payload?.count ?? null });
  }

  async function requireAdmin(req, res) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!safeEqual(token, config.adminToken)) {
      json(res, 401, { error: 'unauthorized' });
      return false;
    }
    return true;
  }

  /** Groups known to Evolution, with their subject names, for name-based lookup. */
  async function listGroupsWithNames() {
    return groupDirectory.list();
  }

  async function adminGroups(res, kind) {
    const merged = new Map();
    const chats = memory.chats().filter(chat => (kind ? chat.kind === kind : true));
    for (const chat of chats) {
      merged.set(chat.id, {
        id: chat.id,
        name: chat.name || null,
        kind: chat.kind,
        enabled: chat.enabled !== false,
        mode: chat.mode || null,
        persona: chat.persona || null,
        probability: chat.probability ?? null,
        messages: (chat.messages || []).length,
        replies: (chat.replies || []).length,
        lastReplyAt: chat.lastReplyAt || null
      });
    }
    // Also list groups the account belongs to, so they can be enabled before
    // anyone has posted in them.
    if (kind !== 'dm') {
      try {
        const list = await listGroupsWithNames();
        for (const group of list) {
          const id = group?.id || group?.jid;
          if (!id) continue;
          const subject = group?.subject || group?.name || null;
          const existing = merged.get(id);
          if (existing) {
            // Keep local settings, but fill in a name we have not learned yet.
            if (!existing.name && subject) existing.name = subject;
            continue;
          }
          merged.set(id, {
            id,
            name: group?.subject || group?.name || null,
            kind: 'group',
            enabled: memory.settings(id, 'group').enabled !== false,
            mode: memory.settings(id, 'group').mode || null,
            persona: memory.settings(id, 'group').persona || null,
            probability: memory.settings(id, 'group').probability ?? null,
            messages: 0,
            replies: 0,
            lastReplyAt: null
          });
        }
      } catch (error) {
        logger.warn('group_list_failed', { error: error.message });
      }
    }
    json(res, 200, { chats: [...merged.values()] });
  }

  async function adminUpdateGroup(req, res, chatId) {
    let patch = {};
    try {
      const raw = await readBody(req, 64 * 1024);
      if (raw) patch = JSON.parse(raw);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
    const allowed = ['enabled', 'mode', 'persona', 'probability', 'name'];
    const clean = {};
    for (const key of allowed) {
      if (patch[key] !== undefined) clean[key] = patch[key];
    }
    if (clean.mode && !['never', 'mention', 'question', 'always'].includes(clean.mode)) {
      return json(res, 400, { error: 'invalid mode' });
    }
    if (clean.probability !== undefined && (clean.probability < 0 || clean.probability > 1)) {
      return json(res, 400, { error: 'probability must be between 0 and 1' });
    }
    const settings = memory.updateSettings(chatId, clean);
    logger.info('settings_updated', { chat: shortHash(chatId), enabled: settings.enabled, mode: settings.mode });
    json(res, 200, { ok: true, settings });
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        return json(res, 200, { ok: true, instance: config.evolutionInstance, model: config.model });
      }

      if (req.method === 'POST' && pathname.startsWith('/webhook/')) {
        return await handleWebhook(req, res, decodeURIComponent(pathname.slice('/webhook/'.length)));
      }

      if (req.method === 'GET' && pathname.startsWith('/qr.png/')) {
        return await handleQr(res, decodeURIComponent(pathname.slice('/qr.png/'.length)), true);
      }

      if (req.method === 'GET' && pathname.startsWith('/qr/')) {
        return await handleQr(res, decodeURIComponent(pathname.slice('/qr/'.length)), false);
      }

      if (pathname.startsWith('/admin/')) {
        if (!(await requireAdmin(req, res))) return undefined;
        if (req.method === 'GET' && pathname === '/admin/groups') return adminGroups(res, 'group');
        if (req.method === 'GET' && pathname === '/admin/chats') return adminGroups(res, 'dm');
        if (req.method === 'GET' && pathname === '/admin/personas') return json(res, 200, { personas: listPersonas() });
        if (req.method === 'POST' && pathname === '/admin/group-by-name') {
          let body;
          try {
            const raw = await readBody(req, 32 * 1024);
            body = raw ? JSON.parse(raw) : {};
          } catch (error) {
            return json(res, 400, { error: error.message });
          }
          if (!body.name) return json(res, 400, { error: 'name is required' });
          const needle = String(body.name).toLowerCase();
          const known = await listGroupsWithNames();
          const matches = known.filter(group => String(group.name || '').toLowerCase().includes(needle));
          if (!matches.length) return json(res, 404, { error: 'no group matched that name' });
          if (matches.length > 1 && !body.exact) {
            return json(res, 409, { error: 'multiple groups matched', matches });
          }
          const target = matches[0];
          const patch = {};
          if (body.enabled !== undefined) patch.enabled = body.enabled;
          if (body.mode !== undefined) patch.mode = body.mode;
          if (body.persona !== undefined) patch.persona = body.persona;
          if (body.probability !== undefined) patch.probability = body.probability;
          const settings = memory.updateSettings(target.id, patch, 'group');
          logger.info('group_enabled_by_name', { chat: shortHash(target.id), name: target.name, mode: settings.mode });
          return json(res, 200, { ok: true, group: { id: target.id, name: target.name }, settings });
        }
        if (req.method === 'POST' && pathname === '/admin/persona') {
          let body;
          try {
            const raw = await readBody(req, 32 * 1024);
            body = raw ? JSON.parse(raw) : {};
          } catch (error) {
            return json(res, 400, { error: error.message });
          }
          if (!body.character) return json(res, 400, { error: 'character is required' });
          try {
            const compiled = await compilePersona({
              character: body.character,
              notes: body.notes,
              complete: args => brain.complete(args)
            });
            const saved = saveCustom(compiled);
            logger.info('persona_compiled', { id: saved.id, name: saved.name });
            return json(res, 200, { ok: true, persona: saved });
          } catch (error) {
            logger.error('persona_compile_failed', { error: error.message });
            return json(res, 502, { error: error.message });
          }
        }
        if (req.method === 'DELETE' && pathname.startsWith('/admin/persona/')) {
          const id = decodeURIComponent(pathname.slice('/admin/persona/'.length));
          const removed = deleteCustom(id);
          return json(res, removed ? 200 : 404, { ok: removed });
        }
        if (req.method === 'POST' && pathname.startsWith('/admin/groups/')) {
          return await adminUpdateGroup(req, res, decodeURIComponent(pathname.slice('/admin/groups/'.length)));
        }
        return json(res, 404, { error: 'not found' });
      }

      return json(res, 404, { error: 'not found' });
    } catch (error) {
      logger.error('request_failed', { path: pathname, error: error.message });
      if (!res.headersSent) return json(res, 500, { error: 'internal error' });
      return undefined;
    }
  };
}

module.exports = { createHandler, safeEqual };
