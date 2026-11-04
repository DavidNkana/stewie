const DEFAULTS = {
  port: 8099,
  host: '127.0.0.1',
  evolutionBaseUrl: 'http://127.0.0.1:8080',
  evolutionInstance: 'stewie',
  model: 'gpt-5.6-luna',
  botName: 'stewie',
  groupMode: 'mention',
  dmMode: 'always',
  cooldownSeconds: 20,
  maxRepliesPerChatPerHour: 20,
  maxRepliesPerHour: 60,
  historySize: 20,
  retentionDays: 7,
  responseProbability: 1,
  requestTimeoutMs: 20000,
  evolutionTimeoutMs: 15000,
  sendBackoffMs: 60000,
  maxReplyChars: 900
};

const MODES = new Set(['never', 'mention', 'question', 'always']);

function int(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function buildConfig(env = process.env) {
  return {
    port: int(env.STEWIE_PORT, DEFAULTS.port),
    host: env.STEWIE_HOST || DEFAULTS.host,
    evolutionBaseUrl: (env.EVOLUTION_BASE_URL || DEFAULTS.evolutionBaseUrl).replace(/\/+$/, ''),
    evolutionApiKey: env.EVOLUTION_API_KEY || '',
    evolutionInstance: env.EVOLUTION_INSTANCE || DEFAULTS.evolutionInstance,
    webhookToken: env.STEWIE_WEBHOOK_TOKEN || '',
    adminToken: env.STEWIE_ADMIN_TOKEN || '',
    // Model credentials are provider specific. STEWIE_MODEL_* wins so that a
    // global OPENAI_API_KEY in the shell cannot silently point the bot at the
    // wrong provider.
    modelApiKey: env.STEWIE_MODEL_API_KEY || env.OPENAI_API_KEY || '',
    modelBaseUrl: (env.STEWIE_MODEL_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: env.STEWIE_MODEL || env.OPENAI_MODEL || DEFAULTS.model,
    botName: env.STEWIE_BOT_NAME || DEFAULTS.botName,
    aliases: (env.STEWIE_BOT_ALIASES || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean),
    persona: env.STEWIE_PERSONA || '',
    groupMode: env.STEWIE_GROUP_MODE || DEFAULTS.groupMode,
    dmMode: env.STEWIE_DM_MODE || DEFAULTS.dmMode,
    cooldownSeconds: int(env.STEWIE_COOLDOWN_SECONDS, DEFAULTS.cooldownSeconds),
    maxRepliesPerChatPerHour: int(env.STEWIE_MAX_REPLIES_PER_CHAT_PER_HOUR, DEFAULTS.maxRepliesPerChatPerHour),
    maxRepliesPerHour: int(env.STEWIE_MAX_REPLIES_PER_HOUR, DEFAULTS.maxRepliesPerHour),
    historySize: int(env.STEWIE_HISTORY_SIZE, DEFAULTS.historySize),
    retentionDays: int(env.STEWIE_RETENTION_DAYS, DEFAULTS.retentionDays),
    responseProbability: Number(env.STEWIE_RESPONSE_PROBABILITY ?? DEFAULTS.responseProbability),
    requestTimeoutMs: int(env.STEWIE_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
    evolutionTimeoutMs: int(env.STEWIE_EVOLUTION_TIMEOUT_MS, DEFAULTS.evolutionTimeoutMs),
    sendBackoffMs: int(env.STEWIE_SEND_BACKOFF_MS, DEFAULTS.sendBackoffMs),
    maxReplyChars: int(env.STEWIE_MAX_REPLY_CHARS, DEFAULTS.maxReplyChars),
    stateFile: env.STEWIE_STATE_FILE || 'data/state.json',
    logLevel: env.STEWIE_LOG_LEVEL || 'info'
  };
}

function validateConfig(config) {
  const missing = [];
  if (!config.evolutionApiKey) missing.push('EVOLUTION_API_KEY');
  if (!config.webhookToken) missing.push('STEWIE_WEBHOOK_TOKEN');
  if (!config.adminToken) missing.push('STEWIE_ADMIN_TOKEN');
  if (!config.modelApiKey) missing.push('STEWIE_MODEL_API_KEY');
  if (missing.length) throw new Error(`missing required configuration: ${missing.join(', ')}`);
  if (!MODES.has(config.groupMode)) throw new Error(`invalid STEWIE_GROUP_MODE: ${config.groupMode}`);
  if (!MODES.has(config.dmMode)) throw new Error(`invalid STEWIE_DM_MODE: ${config.dmMode}`);
  if (config.responseProbability < 0 || config.responseProbability > 1) {
    throw new Error('STEWIE_RESPONSE_PROBABILITY must be between 0 and 1');
  }
  return config;
}

module.exports = { DEFAULTS, MODES, buildConfig, validateConfig };
