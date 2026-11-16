const fs = require('node:fs');
const path = require('node:path');

/**
 * Reminders: a tiny persistent queue.
 * Times may be given as ISO or as plain speech ("tomorrow 9am", "in 2 hours").
 */

function parseWhen(value, now = new Date()) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('no time given');

  const iso = Date.parse(raw);
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(raw)) return new Date(iso);

  const text = raw.toLowerCase().replace(/\s+/g, ' ');
  const base = new Date(now);

  const clock = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  let hour = clock ? Number(clock[1]) : null;
  const minute = clock && clock[2] ? Number(clock[2]) : 0;
  const meridiem = clock && clock[3] ? clock[3] : null;
  if (hour !== null && meridiem === 'pm' && hour < 12) hour += 12;
  if (hour !== null && meridiem === 'am' && hour === 12) hour = 0;

  const relative = text.match(/\bin\s+(\d+)\s*(minute|min|hour|hr|day|week)s?\b/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const ms = unit.startsWith('minute') || unit.startsWith('min')
      ? amount * 60000
      : unit.startsWith('hour') || unit.startsWith('hr')
        ? amount * 3600000
        : unit.startsWith('week')
          ? amount * 604800000
          : amount * 86400000;
    return new Date(base.getTime() + ms);
  }

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayName = days.find(day => text.includes(day));
  const tomorrow = text.includes('tomorrow');
  const tonight = text.includes('tonight');
  const today = text.includes('today');

  if (tomorrow || tonight || today || dayName) {
    const result = new Date(base);
    result.setSeconds(0, 0);
    if (hour !== null) result.setHours(hour, minute, 0, 0);
    else if (tonight) result.setHours(20, 0, 0, 0);
    else result.setHours(9, 0, 0, 0);
    if (tomorrow) result.setDate(result.getDate() + 1);
    if (dayName) {
      const target = days.indexOf(dayName);
      let delta = (target - result.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      result.setDate(result.getDate() + delta);
    }
    if (result.getTime() <= base.getTime()) result.setDate(result.getDate() + 1);
    return result;
  }

  throw new Error(`could not understand the time "${raw}"`);
}

function createReminderStore(options = {}) {
  const file = options.file || 'data/reminders.json';
  const now = options.now || (() => Date.now());
  let items = load();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('reminder read failed:', error.message);
      return [];
    }
  }

  function save() {
    const dir = path.dirname(path.resolve(file));
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(items, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  return {
    add({ chatId, text, when, createdBy }) {
      if (!text) throw new Error('reminder needs text');
      if (!chatId) throw new Error('reminder needs a chat');
      const due = parseWhen(when, new Date(now()));
      const item = {
        id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        chatId,
        text: String(text).slice(0, 500),
        due: due.toISOString(),
        createdAt: new Date(now()).toISOString(),
        createdBy: createdBy || null,
        done: false
      };
      items.push(item);
      save();
      return item;
    },
    list({ chatId } = {}) {
      const all = chatId ? items.filter(item => item.chatId === chatId) : items;
      return all.filter(item => !item.done).sort((a, b) => new Date(a.due) - new Date(b.due));
    },
    due() {
      const current = now();
      return items.filter(item => !item.done && new Date(item.due).getTime() <= current);
    },
    complete(id) {
      const item = items.find(entry => entry.id === id);
      if (!item) return false;
      item.done = true;
      item.completedAt = new Date(now()).toISOString();
      save();
      return true;
    },
    remove(id) {
      const before = items.length;
      items = items.filter(item => item.id !== id);
      if (items.length !== before) save();
      return items.length !== before;
    },
    all() {
      return items;
    }
  };
}

module.exports = { createReminderStore, parseWhen };
