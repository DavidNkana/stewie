const SILENT_TOKEN = '[SILENT]';

/**
 * The agent loop: lets the model request tools, run them, and answer with
 * the result. Bounded so a confused model cannot loop forever.
 */
async function runAgent({ brain, tools, toolSchemas, messages, context = {}, maxRounds = 3, logger }) {
  const conversation = [...messages];
  const seenCalls = new Map();
  let nudge = null;

  for (let round = 1; round <= maxRounds; round++) {
    const finalRound = round === maxRounds;
    // On the last round the model gets no tools, so it has to answer.
    const reply = await brain.chat(conversation, {
      tools: finalRound ? undefined : (toolSchemas ?? tools.schemas),
      maxTokens: 2000
    });
    const calls = reply.toolCalls || [];

    if (logger) {
      logger.debug('agent_round', {
        round,
        contentLength: String(reply.content || '').length,
        tools: calls.map(call => call.function?.name).join(',')
      });
    }

    if (!calls.length) {
      const answer = String(reply.content || '').trim();
      if (!answer || answer === SILENT_TOKEN) return { content: null, rounds: round, toolsUsed: [] };
      return { content: answer, rounds: round, toolsUsed: [...seenCalls.keys()] };
    }

    conversation.push({ role: 'assistant', content: reply.content || '', tool_calls: calls });

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }
      const signature = `${name}:${JSON.stringify(args)}`;
      const previous = seenCalls.get(signature);

      let outcome;
      if (previous) {
        // The same call twice means the model is looping. Say so plainly.
        outcome = {
          ok: true,
          result: previous,
          note: 'This search was already run and returned the same thing. You have all the information there is. Answer the person now.'
        };
        if (logger) logger.warn('agent_repeated_tool', { tool: name });
      } else {
        outcome = await tools.execute(name, args, context);
        seenCalls.set(signature, outcome.result ?? outcome);
      }

      conversation.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: JSON.stringify(outcome).slice(0, 8000)
      });
    }

    nudge = 'You now have everything available. Answer the person directly. Do not call any more tools.';
    conversation.push({ role: 'system', content: nudge });
  }

  return { content: null, rounds: maxRounds, toolsUsed: [...seenCalls.keys()] };
}

module.exports = { runAgent, SILENT_TOKEN };
