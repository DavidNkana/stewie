const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.join(__dirname, 'custom.json');

function file() {
  return process.env.STEWIE_PERSONA_FILE || DEFAULT_FILE;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('custom persona read failed:', error.message);
    return {};
  }
}

function listCustom() {
  return Object.values(read());
}

function getCustom(id) {
  if (!id) return null;
  return read()[String(id).toLowerCase()] || null;
}

function saveCustom(persona) {
  const id = slugify(persona.id || persona.name);
  if (!id) throw new Error('persona needs an id or name');
  const all = read();
  all[id] = { id, name: persona.name || id, prompt: persona.prompt, createdAt: new Date().toISOString() };
  fs.writeFileSync(file(), JSON.stringify(all, null, 2), { mode: 0o600 });
  return all[id];
}

function deleteCustom(id) {
  const all = read();
  const key = String(id || '').toLowerCase();
  if (!all[key]) return false;
  delete all[key];
  fs.writeFileSync(file(), JSON.stringify(all, null, 2), { mode: 0o600 });
  return true;
}

module.exports = { listCustom, getCustom, saveCustom, deleteCustom, slugify };
