const crypto = require('node:crypto');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/** Stable, non-reversible short id so logs can be correlated without leaking numbers. */
function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function createLogger(options = {}) {
  const level = LEVELS[options.level] ?? LEVELS.info;
  const sink = options.sink || (entry => console.log(JSON.stringify(entry)));
  function emit(levelName, event, fields = {}) {
    if ((LEVELS[levelName] ?? LEVELS.info) > level) return;
    sink({ event, level: levelName, ts: new Date().toISOString(), ...fields });
  }
  return {
    error: (event, fields) => emit('error', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    info: (event, fields) => emit('info', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
    child: extra => createLogger({ level: options.level, sink })
  };
}

module.exports = { createLogger, shortHash, LEVELS };
