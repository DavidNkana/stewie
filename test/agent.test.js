const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../src/agent');

function brainWith(rounds) {
  let index = 0;
  return {
    chat: async () => {
      const step = rounds[index++] || { content: 'final answer', toolCalls: [] };
      return step;
    }
  };
}

test('the agent executes tools and returns the final answer', async () => {
  const tools = {
    schemas: [],
    execute: async (name, args) => ({ ok: true, result: { name, args } })
  };
  const result = await runAgent({
    brain: brainWith([
      { content: '', toolCalls: [{ id: 'c1', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } }] },
      { content: 'the answer is 2', toolCalls: [] }
    ]),
    tools,
    messages: [{ role: 'user', content: 'what is 1+1' }]
  });
  assert.equal(result.content, 'the answer is 2');
});

test('a looping model is cut off and still produces an answer', async () => {
  const tools = {
    schemas: [],
    execute: async () => ({ ok: true, result: [] })
  };
  const repeated = { content: '', toolCalls: [{ id: 'c1', function: { name: 'search_history', arguments: '{"query":"x"}' } }] };
  const result = await runAgent({
    brain: brainWith([repeated, repeated, repeated, { content: 'here is the answer', toolCalls: [] }]),
    tools,
    messages: [{ role: 'user', content: 'find something' }],
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  });
  assert.equal(result.content, 'here is the answer');
});

test('a repeated tool call is not executed twice', async () => {
  let executions = 0;
  const tools = {
    schemas: [],
    execute: async () => { executions += 1; return { ok: true, result: [] }; }
  };
  const repeated = { content: '', toolCalls: [{ id: 'c1', function: { name: 'search_history', arguments: '{"query":"x"}' } }] };
  await runAgent({
    brain: brainWith([repeated, repeated, { content: 'done', toolCalls: [] }]),
    tools,
    messages: [{ role: 'user', content: 'find something' }],
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  });
  assert.equal(executions, 1);
});
