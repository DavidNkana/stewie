const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertPublicUrl } = require('./fetch-url');

const MAX_PDF_BYTES = 12 * 1024 * 1024;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeoutMs || 30000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${(stderr || error.message).toString().slice(0, 200)}`));
      else resolve(stdout);
    });
  });
}

/**
 * Downloads a PDF and extracts its text with poppler's pdftotext.
 * Accepts a public http(s) url or a local file path that was sent in the chat.
 */
async function readPdf(source, options = {}) {
  const maxChars = options.maxChars || 12000;
  const value = String(source || '').trim();
  if (!value) throw new Error('no pdf source given');

  let tempFile = null;
  let filePath = value;

  if (/^https?:\/\//i.test(value)) {
    const url = await assertPublicUrl(value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60000);
    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; StewieBot/1.0)' }
      });
      if (!response.ok) throw new Error(`download returned ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_PDF_BYTES) throw new Error('pdf too large');
      tempFile = path.join(os.tmpdir(), `stewie-${process.pid}-${Date.now()}.pdf`);
      fs.writeFileSync(tempFile, buffer);
      filePath = tempFile;
    } finally {
      clearTimeout(timer);
    }
  } else {
    if (!fs.existsSync(filePath)) throw new Error('file not found');
    if (fs.statSync(filePath).size > MAX_PDF_BYTES) throw new Error('pdf too large');
  }

  try {
    const info = await run('pdfinfo', [filePath]).catch(() => '');
    const pages = (String(info).match(/Pages:\s+(\d+)/) || [])[1] || null;
    const text = await run('pdftotext', ['-layout', filePath, '-']);
    const cleaned = String(text).replace(/\n{3,}/g, '\n\n').trim();
    return {
      source: value,
      pages: pages ? Number(pages) : null,
      truncated: cleaned.length > maxChars,
      text: cleaned.slice(0, maxChars)
    };
  } finally {
    if (tempFile) {
      try {
        fs.rmSync(tempFile, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

module.exports = { readPdf, MAX_PDF_BYTES };
