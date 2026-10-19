const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 25;

const SYSTEM_PROMPT = [
  'You are Luna, a concise and friendly WhatsApp assistant.',
  'Answer in plain text in at most 3 short paragraphs. Be useful, honest, and ask one clarifying question when needed.',
  'Do not provide medical, legal, financial, self-harm, or other sensitive-domain advice; recommend a qualified professional or emergency service instead.',
  'Never claim to have taken an action you cannot take. Do not initiate contact or reveal private conversation data.'
].join(' ');

function envConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    verifyToken: env.WEBHOOK_VERIFY_TOKEN || '',
    appSecret: env.META_APP_SECRET || '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    graphVersion: env.GRAPH_API_VERSION || 'v23.0',
    openaiKey: env.OPENAI_API_KEY || '',
    openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: env.OPENAI_MODEL || 'gpt-5.6-luna',
    // Mocking must be explicit so missing live credentials cannot silently disable auth.
    mockMode: env.MOCK_MODE === 'true',
    stateFile: env.STATE_FILE || path.join(process.cwd(), 'state.json'),
    retentionDays: Number(env.RETENTION_DAYS || DEFAULT_RETENTION_DAYS),
    retryAttempts: Number(env.RETRY_ATTEMPTS || DEFAULT_RETRY_ATTEMPTS),
    retryDelayMs: Number(env.RETRY_DELAY_MS || DEFAULT_RETRY_DELAY_MS)
  };
}

function validateConfig(config) {
  if (config.mockMode) return;
  const required = ['verifyToken', 'appSecret', 'accessToken', 'phoneNumberId', 'openaiKey'];
  const missing = required.filter(key => !String(config[key] || '').trim());
  if (missing.length) throw new Error(`live configuration missing: ${missing.join(', ')}`);
}

function readState(file, retentionDays = DEFAULT_RETENTION_DAYS) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cutoff = Date.now() - Math.max(0, retentionDays) * 24 * 60 * 60 * 1000;
    const processed = Object.fromEntries(Object.entries(value.processed || {}).filter(([, timestamp]) => Number(timestamp) >= cutoff));
    const optedOut = Object.fromEntries(Object.entries(value.optedOut || {}).filter(([, timestamp]) => Number(timestamp) >= cutoff));
    const conversations = Object.fromEntries(Object.entries(value.conversations || {}).map(([user, entries]) => [user, (entries || []).filter(entry => !entry.timestamp || Number(entry.timestamp) >= cutoff)]).filter(([, entries]) => entries.length));
    return { processed, conversations, optedOut };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('state read failed:', error.message);
    return { processed: {}, conversations: {}, optedOut: {} };
  }
}

function createStore(file, retentionDays = DEFAULT_RETENTION_DAYS) {
  const state = readState(file, retentionDays);
  function prune() {
    const cutoff = Date.now() - Math.max(0, retentionDays) * 24 * 60 * 60 * 1000;
    for (const [id, timestamp] of Object.entries(state.processed)) if (Number(timestamp) < cutoff) delete state.processed[id];
    for (const [user, timestamp] of Object.entries(state.optedOut)) if (Number(timestamp) < cutoff) delete state.optedOut[user];
    for (const user of Object.keys(state.conversations)) {
      state.conversations[user] = state.conversations[user].filter(entry => !entry.timestamp || Number(entry.timestamp) >= cutoff);
      if (!state.conversations[user].length) delete state.conversations[user];
    }
  }
  function save() {
    prune();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  return {
    seen(id) { return Boolean(state.processed[id]); },
    claim(id) { return !state.processed[id]; },
    complete(id) { state.processed[id] = Date.now(); save(); },
    // Kept as a compatibility alias; callers should complete only after delivery.
    markSeen(id) { this.complete(id); },
    isOptedOut(user) { return Boolean(state.optedOut[user]); },
    optOut(user) { state.optedOut[user] = Date.now(); save(); },
    history(user) { return (state.conversations[user] || []).slice(-8); },
    add(user, role, content) {
       state.conversations[user] = [...(state.conversations[user] || []).slice(-7), { role, content, timestamp: Date.now() }];
      save();
    }
  };
}

function isValidSignature(rawBody, header, secret) {
  if (!secret) return false;
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = header.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

function extractTextMessages(payload) {
  const messages = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      for (const message of Array.isArray(change?.value?.messages) ? change.value.messages : []) {
        if (message.type === 'text' && message.id && message.from && message.text?.body) {
          messages.push({ id: message.id, from: message.from, text: message.text.body, phoneNumberId: change.value?.metadata?.phone_number_id || '' });
        }
      }
    }
  }
  return messages;
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const json = response.json?.bind(response);
    if (json) response.json = async (...args) => { try { return await json(...args); } finally { clearTimeout(timer); } };
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function createModelAdapter(config, fetchImpl = fetch) {
  return async function generate(user, history, text) {
    if (!config.openaiKey && config.mockMode) return `Luna (mock): I received your message: ${text}`;
    const response = await fetchWithTimeout(fetchImpl, `${config.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openaiKey}` },
      body: JSON.stringify({ model: config.model, temperature: 0.3, max_tokens: 220, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: text }] })
    });
    if (!response.ok) throw new Error(`model API returned ${response.status}`);
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) throw new Error('model API returned no text');
    return answer.slice(0, 4000);
  };
}

function createSender(config, fetchImpl = fetch) {
  return async function send(to, text) {
    if (config.mockMode) {
      return { mock: true };
    }
    const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } })
    });
    if (!response.ok) throw new Error(`Meta API returned ${response.status}`);
    return response.json();
  };
}

function createApp(options = {}) {
  const config = options.config || envConfig();
  validateConfig(config);
  const store = options.store || createStore(config.stateFile, config.retentionDays);
  const model = options.model || createModelAdapter(config, options.fetchImpl);
  const send = options.send || createSender(config, options.fetchImpl);
  const logger = options.logger || ((event) => console.log(JSON.stringify(event)));
  const inFlight = new Map();
  const senderChains = new Map();
  const safeUser = user => crypto.createHash('sha256').update(String(user)).digest('hex').slice(0, 12);
  const event = (name, fields = {}) => logger({ event: name, timestamp: new Date().toISOString(), ...fields });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function scheduleMessage(message) {
    if (inFlight.has(message.id)) return inFlight.get(message.id);
    if (store.seen(message.id) || !store.claim(message.id)) return Promise.resolve(false);
    const previous = senderChains.get(message.from) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      for (let attempt = 1; attempt <= Math.max(1, config.retryAttempts || DEFAULT_RETRY_ATTEMPTS); attempt++) {
        try {
          await processMessageCore(message);
          store.complete(message.id);
          event('reply_success', { messageId: message.id, user: safeUser(message.from), attempt });
          return true;
        } catch (error) {
          event('processing_error', { messageId: message.id, user: safeUser(message.from), attempt, error: error.message });
          if (attempt === Math.max(1, config.retryAttempts || DEFAULT_RETRY_ATTEMPTS)) throw error;
          await sleep(config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
        }
      }
    });
    inFlight.set(message.id, work);
    senderChains.set(message.from, work);
    work.finally(() => { inFlight.delete(message.id); if (senderChains.get(message.from) === work) senderChains.delete(message.from); }).catch(() => {});
    return work;
  }
  async function processMessageCore(message) {
    const text = message.text.trim();
    if (/^(stop|unsubscribe)$/i.test(text)) {
      const started = Date.now();
      await send(message.from, 'You are unsubscribed and will not receive further messages.');
      store.optOut(message.from);
      event('opt_out', { messageId: message.id, user: safeUser(message.from), latencyMs: Date.now() - started });
      return;
    }
    if (store.isOptedOut(message.from)) return;
    const history = store.history(message.from);
    const modelStarted = Date.now();
    let answer;
    try { answer = await model(message.from, history, text); event('model_latency', { messageId: message.id, user: safeUser(message.from), latencyMs: Date.now() - modelStarted }); }
    catch (error) { event('model_error', { messageId: message.id, user: safeUser(message.from), latencyMs: Date.now() - modelStarted, error: error.message }); throw error; }
    const sendStarted = Date.now();
    try { await send(message.from, answer); event('send_latency', { messageId: message.id, user: safeUser(message.from), latencyMs: Date.now() - sendStarted }); }
    catch (error) { event('send_error', { messageId: message.id, user: safeUser(message.from), latencyMs: Date.now() - sendStarted, error: error.message }); throw error; }
    store.add(message.from, 'user', text);
    store.add(message.from, 'assistant', answer);
  }
  function processMessage(message) { return scheduleMessage(message); }
  function handler(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/health') return respond(res, 200, { ok: true, mockMode: config.mockMode });
    if (req.method === 'GET' && pathname === '/webhook') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const challenge = query.get('hub.challenge');
      if (query.get('hub.mode') !== 'subscribe' || !config.verifyToken || query.get('hub.verify_token') !== config.verifyToken || !challenge) return respond(res, 403, { error: 'verification failed' });
      res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(challenge);
    }
    if (req.method !== 'POST' || pathname !== '/webhook') return respond(res, 404, { error: 'not found' });
    let raw = ''; req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; if (raw.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      const signatureRequired = !config.mockMode || Boolean(config.appSecret);
      if (signatureRequired && !isValidSignature(raw, req.headers['x-hub-signature-256'], config.appSecret)) return respond(res, 401, { error: 'invalid signature' });
      let payload; try { payload = JSON.parse(raw); } catch { return respond(res, 400, { error: 'invalid JSON' }); }
      const validShape = payload && typeof payload === 'object' && Array.isArray(payload.entry) && payload.entry.every(entry => entry && Array.isArray(entry.changes) && entry.changes.every(change => {
        if (!change || typeof change !== 'object' || !change.value || typeof change.value !== 'object') return false;
        return !change.value.messages || (Array.isArray(change.value.messages) && change.value.metadata?.phone_number_id === config.phoneNumberId);
      }));
      if (!validShape) return respond(res, 400, { error: 'invalid payload' });
      const messages = extractTextMessages(payload).filter(message => !config.phoneNumberId || message.phoneNumberId === config.phoneNumberId);
      respond(res, 200, { ok: true });
      for (const message of messages) {
        event('inbound_accepted', { messageId: message.id, user: safeUser(message.from) });
        setImmediate(() => processMessage(message).catch(() => {}));
      }
    });
  }
  return { handler, processMessage, config, store, model, send };
}

function respond(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }

if (require.main === module) {
  const app = createApp();
  http.createServer(app.handler).listen(app.config.port, () => console.log(`WhatsApp Luna bot listening on port ${app.config.port} (${app.config.mockMode ? 'mock' : 'live'} mode)`));
}

module.exports = { SYSTEM_PROMPT, envConfig, validateConfig, createStore, isValidSignature, extractTextMessages, fetchWithTimeout, createModelAdapter, createSender, createApp };
