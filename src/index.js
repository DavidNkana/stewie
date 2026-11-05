const http = require('node:http');
const { loadEnv } = require('./env');
const { buildConfig, validateConfig } = require('./config');
const { createLogger } = require('./logger');
const { createMemory } = require('./memory');
const { createPolicy } = require('./policy');
const { createBrain } = require('./brain');
const { createEvolution } = require('./evolution');
const { createHandler } = require('./server');
const { createGroupDirectory } = require('./groups');

async function main() {
  loadEnv();
  const config = validateConfig(buildConfig());
  const logger = createLogger({ level: config.logLevel });

  const memory = createMemory({ file: config.stateFile, retentionDays: config.retentionDays, historySize: config.historySize });
  const policy = createPolicy(config);
  const brain = createBrain(config);
  const evolution = createEvolution(config);

  const directory = createGroupDirectory({ evolution, logger, cacheFile: config.groupCacheFile });
  const handler = createHandler({ config, evolution, memory, policy, brain, logger, directory });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(error => {
      logger.error('handler_crashed', { error: error.message });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    });
  });

  server.listen(config.port, config.host, () => {
    logger.info('stewie_started', { host: config.host, port: config.port, model: config.model, instance: config.evolutionInstance });
    logger.info('powered_by', { component: 'Evolution API', license: 'Apache-2.0', note: 'Evolution API is being utilised as the WhatsApp transport' });
  });

  // Point the Evolution instance at our webhook so inbound messages arrive.
  // Evolution may still be booting when we start, so retry before giving up.
  const webhookUrl = `http://127.0.0.1:${config.port}/webhook/${config.webhookToken}`;
  let webhookSet = false;
  for (let attempt = 1; attempt <= 10 && !webhookSet; attempt++) {
    try {
      await evolution.setWebhook(webhookUrl);
      webhookSet = true;
      logger.info('evolution_webhook_set', { url: webhookUrl.replace(config.webhookToken, '<token>'), attempt });
    } catch (error) {
      if (attempt === 10) {
        logger.error('evolution_webhook_failed', { error: error.message, attempts: attempt });
      } else {
        logger.warn('evolution_webhook_retry', { attempt, error: error.message });
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  directory.prime();

  // The webhook lives on the Evolution instance. If the instance is replaced
  // or recreated, the webhook silently disappears and no messages arrive, so
  // keep verifying it and re-registering when needed.
  async function ensureWebhook(reason) {
    try {
      const current = await evolution.getWebhook();
      const url = `http://127.0.0.1:${config.port}/webhook/${config.webhookToken}`;
      const wanted = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'];
      const ok = current && current.enabled && current.url === url
        && Array.isArray(current.events) && wanted.every(event => current.events.includes(event));
      if (ok) return true;
      await evolution.setWebhook(url, wanted);
      logger.info('evolution_webhook_repaired', { reason, url: url.replace(config.webhookToken, '<token>') });
      return true;
    } catch (error) {
      logger.warn('evolution_webhook_check_failed', { reason, error: error.message });
      return false;
    }
  }

  const webhookTimer = setInterval(() => ensureWebhook('periodic'), 120000);
  webhookTimer.unref();

  try {
    const state = await evolution.connectionState();
    logger.info('evolution_connection', { state: state?.instance?.state ?? state?.state ?? 'unknown' });
  } catch (error) {
    logger.warn('evolution_state_unavailable', { error: error.message });
  }

  const shutdown = signal => {
    logger.info('shutting_down', { signal });
    clearInterval(webhookTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ event: 'startup_failed', error: error.message }));
    process.exit(1);
  });
}

module.exports = { main };
