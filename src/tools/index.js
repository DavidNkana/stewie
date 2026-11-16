const { fetchUrl } = require('./fetch-url');
const { readPdf } = require('./read-pdf');
const { evaluateExpression, looksLikeMath } = require('./calculate');
const { searchHistory } = require('./history');

/**
 * The tool set exposed to the model.
 *
 * Every tool declares an OpenAI function schema, and every tool runs
 * server-side with its own validation. Nothing here can be pointed at the
 * host's private network.
 */
function createToolRegistry(deps) {
  const { config, evolution, reminders, logger, directory, memory, leads } = deps;

  const definitions = [
    {
      name: 'calculate',
      description: 'Evaluate an arithmetic expression exactly. Use this for any maths instead of doing it yourself.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Arithmetic expression, for example "187 * 34 + 12"' }
        },
        required: ['expression']
      },
      execute: async ({ expression }) => {
        if (!looksLikeMath(expression)) throw new Error('that does not look like an arithmetic expression');
        const value = evaluateExpression(expression);
        return { expression, result: value };
      }
    },
    {
      name: 'fetch_url',
      description: 'Open a web page and read its text. Use it when a message contains a link you need to understand.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The http or https url to open' }
        },
        required: ['url']
      },
      execute: async ({ url }) => fetchUrl(url, { timeoutMs: config.requestTimeoutMs })
    },
    {
      name: 'read_pdf',
      description: 'Download a PDF and extract its text. Use it when a message contains a PDF link or a PDF file.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Public http(s) url of the PDF, or the local path of a file sent in the chat' }
        },
        required: ['source']
      },
      execute: async ({ source }) => readPdf(source, { timeoutMs: config.requestTimeoutMs * 3 })
    },
    {
      name: 'create_reminder',
      description: 'Set a reminder for the user. Use it when someone asks you to remind them about something.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to remind them about' },
          when: { type: 'string', description: 'When, as plain speech ("tomorrow 9am", "in 2 hours") or an ISO timestamp' }
        },
        required: ['text', 'when']
      },
      execute: async ({ text, when }, context) => {
        const item = reminders.add({
          chatId: context.chatId,
          text,
          when,
          createdBy: context.speakerName || null
        });
        logger.info('reminder_created', { chat: context.chatId, id: item.id, due: item.due });
        return item;
      }
    },
    {
      name: 'list_reminders',
      description: 'List the reminders that are still pending.',
      parameters: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'Optional: only reminders for this chat' }
        }
      },
      execute: async ({ chatId }, context) => reminders.list({ chatId: chatId || context.chatId })
    },
    {
      name: 'search_history',
      description: 'Search recent messages in the chats for something that was said earlier.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to look for' },
          chatId: { type: 'string', description: 'Optional: limit the search to one chat' }
        },
        required: ['query']
      },
      execute: async ({ query, chatId }, context) => {
        const chats = chatId ? [chatId] : memory.chats().map(chat => chat.id);
        return searchHistory({ evolution, chatId, query, chats });
      }
    },
    {
      name: 'record_client_facts',
      description: 'Store what you have learned about this person so you do not ask again. Only store what they actually told you.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Their name, if they gave it' },
          business: { type: 'string', description: 'Their business or organisation, if they gave it' },
          projectPurpose: { type: 'string', description: 'What the app or project is meant to do, in their words' },
          platforms: { type: 'string', description: 'Platforms they need, for example web and Android' },
          requiredFeatures: { type: 'string', description: 'The main features they mentioned' },
          budget: { type: 'string', description: 'Budget they stated, only if they stated one' },
          desiredTiming: { type: 'string', description: 'Timing they mentioned, only if they mentioned one' },
          currentStage: { type: 'string', description: 'Where they are: new enquiry, scoping, quoted, existing client' },
          consentForNextStep: { type: 'string', description: 'Only if they agreed to a next step' }
        }
      },
      execute: async (facts, context) => {
        if (!leads) return { ok: true, result: { stored: false, note: 'no lead storage configured' } };
        const saved = leads.record(context.chatId, facts);
        return { stored: true, facts: saved.facts };
      }
    },
    {
      name: 'list_chats',
      description: 'List the group chats and direct chats this account can talk in.',
      parameters: {
        type: 'object',
        properties: {}
      },
      execute: async () => {
        const groups = await directory.list();
        const direct = memory.chats().filter(chat => chat.kind !== 'group').map(chat => ({
          id: chat.id,
          name: chat.name || chat.id,
          kind: 'dm'
        }));
        return [...groups.map(group => ({ ...group, kind: 'group' })), ...direct];
      }
    },
    {
      name: 'send_message',
      description: 'Send a message to another chat or group. Use it to follow up, brief someone, or close a loop.',
      parameters: {
        type: 'object',
        properties: {
          chat: { type: 'string', description: 'Chat id or exact group name' },
          text: { type: 'string', description: 'The message to send' }
        },
        required: ['chat', 'text']
      },
      execute: async ({ chat, text }, context) => {
        const resolved = await resolveChatReference(chat, deps);
        if (!resolved) throw new Error(`no chat matched "${chat}"`);
        await evolution.sendText(resolved, text);
        logger.info('tool_send_message', { from: context.chatId, to: resolved });
        return { sent: true, chat: resolved };
      }
    }
  ];

  async function resolveChatReference(reference, options) {
    const value = String(reference || '').trim();
    if (!value) return null;
    if (value.endsWith('@g.us') || value.endsWith('@s.whatsapp.net')) return value;
    const groups = await options.directory.list();
    const exact = groups.find(group => String(group.name || '').trim().toLowerCase() === value.toLowerCase());
    if (exact) return exact.id;
    const partial = groups.find(group => String(group.name || '').toLowerCase().includes(value.toLowerCase()));
    return partial ? partial.id : null;
  }

  const byName = new Map(definitions.map(tool => [tool.name, tool]));

  const schemas = definitions.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));

  /**
   * Only offers the tools a message could plausibly need.
   *
   * Handing the model the whole toolbox makes it explore (and loop) instead of
   * answering, and every extra round costs seconds in a chat.
   */
  function selectSchemas(messageText, mode = 'CLIENT') {
    const text = String(messageText || '').toLowerCase();
    if (mode === 'CLIENT') {
      // Client conversations never get internal team tools.
      return schemas.filter(schema => [
        'fetch_url', 'read_pdf', 'calculate', 'create_reminder', 'list_reminders', 'record_client_facts'
      ].includes(schema.function.name)).filter(schema => {
        const name = schema.function.name;
        if (name === 'fetch_url') return /https?:\/\//.test(text);
        if (name === 'read_pdf') return /\.pdf\b|\bpdf\b/.test(text);
        if (name === 'calculate') return /\b(calculate|compute|work out|how much|total|cost|price|per cent|%)\b|[0-9].*[+\-*/x]/.test(text);
        if (name === 'create_reminder') return /\bremind\b|\breminder\b/.test(text);
        if (name === 'list_reminders') return /\breminders?\b/.test(text);
        if (name === 'record_client_facts') return /\b(my|our) (business|app|store|company|idea|project|budget|platforms?)\b/i.test(text);
        return false;
      });
    }
    const wants = {
      fetch_url: /https?:\/\/|\bwebsite\b|\bpage\b|\barticle\b|\blink\b/.test(text),
      read_pdf: /\.pdf\b|\bpdf\b/.test(text),
      calculate: /\b(calculate|compute|work out|how much|total|cost|price|per cent|%)\b|[0-9].*[+\-*/x]/.test(text),
      create_reminder: /\bremind\b|\breminder\b|\bdon'?t let me forget\b/.test(text),
      list_reminders: /\breminders?\b/.test(text),
      search_history: /\b(earlier|before|last (week|month|time)|what did (we|i|you) (say|discuss)|history|previously)\b/.test(text),
      list_chats: /\b(send|message|dm|email|tell|ask)\b/.test(text),
      send_message: /\b(send|message|dm|email|tell|ask|follow up|reply to)\b/.test(text)
    };
    const selected = schemas.filter(schema => wants[schema.function.name]);
    return selected.length ? selected : [];
  }

  return {
    definitions,
    schemas,
    selectSchemas,
    has(name) {
      return byName.has(name);
    },
    async execute(name, args, context = {}) {
      const tool = byName.get(name);
      if (!tool) throw new Error(`unknown tool: ${name}`);
      try {
        const result = await tool.execute(args || {}, context);
        return { ok: true, result };
      } catch (error) {
        logger.warn('tool_failed', { tool: name, error: error.message });
        return { ok: false, error: error.message };
      }
    }
  };
}

module.exports = { createToolRegistry };
