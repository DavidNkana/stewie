const { fetchUrl } = require('./fetch-url');
const { readPdf } = require('./read-pdf');
const { evaluateExpression, looksLikeMath } = require('./calculate');

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

function extractUrls(text) {
  const found = String(text || '').match(URL_PATTERN) || [];
  return [...new Set(found.map(url => url.replace(/[.,;:!?]+$/, '')))].slice(0, 3);
}

function isPdf(url, mimetype) {
  if (mimetype && /pdf/i.test(mimetype)) return true;
  return /\.pdf($|\?)/i.test(url);
}

/**
 * Reads what the message points at, before the model is asked anything.
 *
 * The model is unreliable at choosing to call tools, and when it skips them
 * it invents the contents. So links, PDFs and arithmetic are resolved here,
 * deterministically, and handed over as context.
 */
async function prefetch({ message, config, logger }) {
  const parts = [];

  for (const url of extractUrls(message.text)) {
    try {
      if (isPdf(url)) {
        const pdf = await readPdf(url, { timeoutMs: (config.requestTimeoutMs || 20000) * 3 });
        parts.push(`PDF at ${url}:\n${pdf.text}`);
      } else {
        const page = await fetchUrl(url, { timeoutMs: config.requestTimeoutMs });
        parts.push(`Web page ${url}${page.title ? ` (${page.title})` : ''}:\n${page.text}`);
      }
    } catch (error) {
      parts.push(`Could not open ${url}: ${error.message}`);
      if (logger) logger.warn('prefetch_failed', { url, error: error.message });
    }
  }

  // A document sent straight into the chat (not a link).
  const document = message.document;
  if (document?.url && !extractUrls(message.text).includes(document.url)) {
    try {
      const pdf = await readPdf(document.url, { timeoutMs: (config.requestTimeoutMs || 20000) * 3 });
      parts.push(`PDF attachment ${document.fileName || ''}:\n${pdf.text}`);
    } catch (error) {
      parts.push(`Could not read the attached document: ${error.message}`);
      if (logger) logger.warn('prefetch_document_failed', { error: error.message });
    }
  }

  if (looksLikeMath(message.text)) {
    const expression = message.text.match(/[\d\s+\-*/^%().,]+/g)?.join(' ').trim();
    if (expression) {
      try {
        const value = evaluateExpression(expression);
        parts.push(`Calculator: ${expression} = ${value}`);
      } catch {
        /* not an expression after all */
      }
    }
  }

  if (!parts.length) return null;
  return parts.join('\n\n---\n\n').slice(0, 12000);
}

module.exports = { prefetch, extractUrls, isPdf };
