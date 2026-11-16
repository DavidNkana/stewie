const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;

/** Blocks private, loopback and link-local targets so a fetch cannot reach the host network. */
function isPrivateAddress(address) {
  const type = net.isIP(address);
  if (type === 4) {
    const parts = address.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (type === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    return false;
  }
  return true;
}

async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('not a valid url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http and https are allowed');
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length) throw new Error('host did not resolve');
  for (const record of records) {
    if (isPrivateAddress(record.address)) throw new Error('refusing to fetch a private address');
  }
  return url;
}

/** Removes markup and collapses whitespace so the model gets readable text. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]).slice(0, 200) : null;
}

/**
 * Fetches a web page and returns readable text.
 */
async function fetchUrl(rawUrl, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxChars = options.maxChars || 6000;
  const url = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; StewieBot/1.0; +https://github.com/DavidNkana/stewie)',
        accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8'
      }
    });
    if (!response.ok) throw new Error(`fetch returned ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new Error('response too large');
    if (contentType.includes('application/pdf')) {
      return { url: url.toString(), contentType, note: 'PDF content: use read_pdf with this url' };
    }
    const html = buffer.toString('utf8');
    return {
      url: url.toString(),
      contentType,
      title: extractTitle(html),
      text: htmlToText(html).slice(0, maxChars)
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchUrl, htmlToText, extractTitle, isPrivateAddress, assertPublicUrl, MAX_BYTES };
