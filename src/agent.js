const SILENT_TOKEN = '[SILENT]';

/**
 * The agent loop: lets the model request tools, run them, and answer with
 * the result. Bounded so a confused model cannot loop forever.
 */
async function runAgent({ brain, tools, messages, context = {}, maxRounds = 4, logger }) {
  const conversation = [...messages];

  for (let round = 1; round <= maxRounds; round++) {
    const reply = await brain.chat(conversation, { tools: tools.schemas, maxTokens: 900 });
    const calls = reply.toolCalls || [];

    if (!calls.length) {
      const answer = String(reply.content || '').trim();
      if (!answer || answer === SILENT_TOKEN) return { content: null, rounds: round, toolsUsed: [] };
      return { content: answer, rounds: round, toolsUsed: [] };
    }

    const used = [];
    conversation.push({ role: 'assistant', content: reply.content || '', tool_calls: calls });

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }
      const outcome = await tools.execute(name, args, context);
      used.push({ name, ok: outcome.ok, args });
      conversation.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: JSON.stringify(outcome).slice(0, 8000)
      });
    }

    if (logger) logger.debug('agent_tools', { round, tools: used.map(entry => entry.name).join(',') });
  }

  return { content: null, rounds: maxRounds, toolsUsed: [] };
}

module.exports = { runAgent, SILENT_TOKEN };
