const crypto = require('node:crypto');
const { parseUpsert, extractText } = require('./parse');
const { runAgent } = require('./agent');
const { resolveMode, TEAM, CLIENT } = require('./modes');
const { buildPrompt } = require('./prompt');
const { resolveCast } = require('../personality/cast');
const { prefetch } = require('./tools/prefetch');
const { shortHash } = require('./logger');
const { listPersonas, compilePersona, resolvePersona } = require('../personality');
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
  const { config, evolution, memory, policy, brain, logger, directory, tools, reminders, knowledge, leads } = deps;
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
  // A failing send (for example in a chat the account is not part of) must not
  // silence the bot everywhere, so the pause is per chat.
  const sendBlockedUntil = new Map();
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

  /** Reads recent chat history from Evolution so the bot knows the context. */
  async function fetchHistory(chatId, limit) {
    if (!limit || limit < 1) return [];
    try {
      const payload = await evolution.findMessages(chatId, limit);
      const records = Array.isArray(payload) ? payload : payload?.messages?.records || [];
      return records
        .map(record => {
          const text = extractText(record.message);
          if (!text) return null;
          const fromMe = record.key?.fromMe === true;
          return {
            id: record.key?.id || '',
            role: fromMe ? 'assistant' : 'user',
            text: text.slice(0, 1000),
            name: fromMe ? config.botName : record.pushName || record.participant || '',
            ts: Number(record.messageTimestamp) * 1000 || 0
          };
        })
        .filter(Boolean);
    } catch (error) {
      logger.warn('history_fetch_failed', { chat: shortHash(chatId), error: error.message });
      return [];
    }
  }

  /** Merge stored history with freshly fetched history, newest last, de-duplicated. */
  function mergeHistory(stored, fetched, limit) {
    const seen = new Set();
    const merged = [];
    for (const entry of [...stored, ...fetched]) {
      const key = entry.id || `${entry.role}:${entry.ts}:${entry.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
    merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return merged.slice(-limit);
  }

  /** Finds a participant's JID in a chat by matching their display name. */
  async function resolveParticipant(chatId, name) {
    const needle = String(name || '').toLowerCase().trim();
    if (!needle) return null;
    try {
      const payload = await evolution.findMessages(chatId, 100);
      const records = Array.isArray(payload) ? payload : payload?.messages?.records || [];
      let best = null;
      for (const record of records) {
        const label = String(record.pushName || '').toLowerCase();
        const participant = record.key?.participant || record.participant;
        if (!participant || !label) continue;
        if (label.includes(needle) || needle.includes(label)) {
          if (!best || (record.messageTimestamp || 0) > (best.ts || 0)) {
            best = { participant, name: record.pushName, ts: record.messageTimestamp || 0 };
          }
        }
      }
      return best;
    } catch (error) {
      logger.warn('participant_resolve_failed', { chat: shortHash(chatId), error: error.message });
      return null;
    }
  }

  /**
   * Resolves a chat id from an id or a group name.
   * An exact name match always wins, so "SafAi" never resolves to
   * "SafAi hospitalities". Ambiguous partial matches are reported instead of
   * being guessed.
   */
  async function resolveChat(reference) {
    const value = String(reference || '').trim();
    if (!value) return { id: null, matches: [] };
    if (value.endsWith('@g.us') || value.endsWith('@s.whatsapp.net')) return { id: value, matches: [] };
    const groups = await listGroupsWithNames();
    const needle = value.toLowerCase();
    const exact = groups.find(group => String(group.name || '').trim().toLowerCase() === needle);
    if (exact) return { id: exact.id, matches: [exact] };
    const matches = groups.filter(group => String(group.name || '').toLowerCase().includes(needle));
    if (matches.length === 1) return { id: matches[0].id, matches };
    return { id: null, matches };
  }

  async function resolveChatId(reference) {
    const resolved = await resolveChat(reference);
    return resolved.id;
  }

  async function handleMessage(message) {
    const kind = message.isGroup ? 'group' : 'dm';
    const chatId = message.chatId;

    // Mode comes from verified provider metadata only: the group flag and the
    // exact configured internal group id. Nothing in the message can change it.
    const routing = resolveMode({
      isGroup: message.isGroup,
      chatId,
      internalGroupIds: config.internalGroupIds
    });
    if (routing.warning) logger.warn('routing_warning', { warning: routing.warning });

    memory.record(chatId, {
      role: 'user',
      text: message.text,
      name: message.senderName,
      speakerId: message.senderId,
      ts: message.timestamp
    }, kind);

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
    // If the voice changed since our last reply here, drop our old replies so
    // the new persona is not anchored by the previous one.
    const personaKey = settings.persona || config.persona || config.personaId || 'stewie';
    if (memory.applyPersona(chatId, personaKey, kind)) {
      logger.info('persona_history_reset', { chat: shortHash(chatId), persona: personaKey });
    }
    const contextLimit = settings.contextMessages ?? config.contextMessages;
    const storedHistory = memory.history(chatId, 12, kind);
    const history = contextLimit
      ? mergeHistory(storedHistory, await fetchHistory(chatId, contextLimit), Math.max(contextLimit, 12))
      : storedHistory;
    const started = Date.now();

    let reply;
    try {
      // Read links, PDFs and arithmetic deterministically before the model answers.
      const fetched = await prefetch({ message, config, logger });

      // Only the context authorised for this conversation is included.
      const contextParts = [];
      if (routing.mode === TEAM) {
        if (settings.context) contextParts.push(`What this chat is about: ${settings.context}`);
        if (chatName) contextParts.push(`Chat name: ${chatName}`);
      } else {
        if (settings.publicContext) contextParts.push(`What this chat is about: ${settings.publicContext}`);
        if (chatName) contextParts.push(`Chat name: ${chatName}`);
      }
      const lead = leads?.get(chatId);
      if (lead?.facts && Object.keys(lead.facts).length) {
        contextParts.push(`What you already know about this person: ${JSON.stringify(lead.facts)}`);
      }
      if (fetched) contextParts.push(fetched);

      const castRules = routing.mode === TEAM ? resolveCast({
        speakerName: message.senderName,
        speakerId: message.senderId,
        text: message.text
      }).rules : null;

      const systemPrompt = buildPrompt({
        mode: routing.mode,
        knowledgeBlock: knowledge?.block || '',
        contextBlock: contextParts.join('\n\n'),
        castRules,
        teamGroupIds: routing.internalGroupIds,
        identityMode: config.identityMode
      });

      const messages = brain.buildMessages({ history, message, settings, systemPrompt, chatName, kind });
      const result = await runAgent({
        brain,
        tools,
        toolSchemas: tools.selectSchemas(message.text, routing.mode),
        messages,
        context: {
          chatId,
          kind,
          chatName,
          speakerName: message.senderName,
          speakerId: message.senderId
        },
        logger
      });
      reply = result.content;
      if (result.toolsUsed?.length) {
        logger.info('tools_used', { chat: shortHash(chatId), tools: result.toolsUsed.map(entry => entry.name).join(',') });
      }
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
      if (Date.now() < (sendBlockedUntil.get(chatId) || 0)) {
        logger.warn('send_skipped', { chat: shortHash(chatId), reason: 'send_backoff' });
        return;
      }
      await evolution.sendText(chatId, reply);
    } catch (error) {
      sendBlockedUntil.set(chatId, Date.now() + Math.max(0, config.sendBackoffMs));
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
        context: chat.context || null,
        publicContext: chat.publicContext || null,
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
    const allowed = ['enabled', 'mode', 'persona', 'probability', 'name', 'contextMessages', 'context', 'publicContext'];
    const clean = {};
    for (const key of allowed) {
      if (patch[key] !== undefined) clean[key] = patch[key];
    }
    if (clean.mode && !['never', 'mention', 'question', 'addressed', 'always'].includes(clean.mode)) {
      return json(res, 400, { error: 'invalid mode' });
    }
    if (clean.probability !== undefined && (clean.probability < 0 || clean.probability > 1)) {
      return json(res, 400, { error: 'probability must be between 0 and 1' });
    }
    if (clean.contextMessages !== undefined && (clean.contextMessages < 0 || clean.contextMessages > 200)) {
      return json(res, 400, { error: 'contextMessages must be between 0 and 200' });
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
        let whatsapp = 'unknown';
        try {
          const state = await evolution.connectionState();
          whatsapp = state?.instance?.state ?? 'unknown';
        } catch {
          whatsapp = 'unreachable';
        }
        return json(res, 200, {
          ok: true,
          instance: config.evolutionInstance,
          model: config.model,
          whatsapp
        });
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
        if (req.method === 'POST' && pathname === '/admin/roast') {
          let body;
          try {
            const raw = await readBody(req, 64 * 1024);
            body = raw ? JSON.parse(raw) : {};
          } catch (error) {
            return json(res, 400, { error: error.message });
          }
          if (!body.chat) return json(res, 400, { error: 'chat is required' });
          if (!body.target) return json(res, 400, { error: 'target is required' });
          const resolvedChat = await resolveChat(body.chat);
          if (!resolvedChat.id) {
            if (resolvedChat.matches.length > 1) {
              return json(res, 409, { error: 'multiple chats matched', matches: resolvedChat.matches });
            }
            return json(res, 404, { error: 'no chat matched that reference' });
          }
          const chatId = resolvedChat.id;
          const participant = await resolveParticipant(chatId, body.target);
          const persona = resolvePersona(body.persona || config.persona || config.personaId);
          const instruction = [
            `Write a short, funny, savage message for ${body.target} in the WhatsApp group "${body.chat}".`,
            body.note ? `The joke you must land: ${body.note}` : 'Make it as cutting and funny as you can.',
            'Address them by name. Keep it to one or two sentences. Plain text, no markdown.',
            'Roast their behaviour and choices, never their race, religion, family, health or nationality. Keep it verbal banter, no threats and no private information.',
            'Output only the message text.'
          ].join(' ');
          try {
            const text = await brain.complete({
              system: `${persona.text}\n\n${instruction}`,
              user: 'Write it.'
            });
            const options = participant ? { mentioned: [participant.participant] } : undefined;
            await evolution.sendText(chatId, text, options);
            logger.info('roast_sent', { chat: shortHash(chatId), target: body.target, mentioned: Boolean(participant) });
            return json(res, 200, { ok: true, chat: chatId, target: body.target, mentioned: participant?.participant ?? null, text });
          } catch (error) {
            logger.error('roast_failed', { error: error.message });
            return json(res, 502, { error: error.message });
          }
        }
        if (req.method === 'POST' && pathname.endsWith('/context-refresh') && pathname.startsWith('/admin/groups/')) {
          const chatId = decodeURIComponent(pathname.slice('/admin/groups/'.length, -'/context-refresh'.length));
          const records = await fetchHistory(chatId, 80);
          const transcript = records
            .filter(entry => entry.text)
            .map(entry => `${entry.name || 'someone'}: ${entry.text}`)
            .slice(-40)
            .join('\n');
          if (!transcript) return json(res, 404, { error: 'no recent messages to summarise' });
          try {
            const note = await brain.complete({
              system: 'You write short operational notes about a chat. Plain text, two sentences maximum, no lists, no quotes, no preamble.',
              user: `Chat: ${chatId}\n\nRecent messages:\n${transcript}\n\nWrite a note describing what this chat is currently about and what an assistant should know to be useful in it.`
            });
            memory.updateSettings(chatId, { context: note.trim() }, 'group');
            logger.info('context_refreshed', { chat: shortHash(chatId) });
            return json(res, 200, { ok: true, context: note.trim() });
          } catch (error) {
            logger.error('context_refresh_failed', { error: error.message });
            return json(res, 502, { error: error.message });
          }
        }
        if (req.method === 'POST' && pathname === '/admin/groups/bulk') {
          let body;
          try {
            const raw = await readBody(req, 32 * 1024);
            body = raw ? JSON.parse(raw) : {};
          } catch (error) {
            return json(res, 400, { error: error.message });
          }
          const patch = {};
          if (body.enabled !== undefined) patch.enabled = body.enabled;
          if (body.mode !== undefined) patch.mode = body.mode;
          if (body.persona !== undefined) patch.persona = body.persona;
          if (body.probability !== undefined) patch.probability = body.probability;
          if (body.mode && !['never', 'mention', 'question', 'addressed', 'always'].includes(body.mode)) {
            return json(res, 400, { error: 'invalid mode' });
          }
          if (!Object.keys(patch).length) return json(res, 400, { error: 'nothing to change' });
          // Always refresh first: acting on a cached list could target groups
          // this account is no longer in.
          const groups = await listGroupsWithNames({ force: true });
          let updated = 0;
          for (const group of groups) {
            memory.updateSettings(group.id, patch, 'group');
            updated += 1;
          }
          logger.info('groups_bulk_updated', { count: updated, mode: patch.mode ?? null, enabled: patch.enabled ?? null });
          return json(res, 200, { ok: true, updated, mode: patch.mode ?? null, enabled: patch.enabled ?? null });
        }
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
