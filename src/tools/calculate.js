/**
 * Safe arithmetic evaluator.
 *
 * Deliberately not eval(): a small shunting-yard parser with a fixed function
 * whitelist, so a message can never execute code.
 */
const FUNCTIONS = {
  abs: Math.abs,
  round: (value, digits = 0) => {
    const factor = 10 ** Number(digits);
    return Math.round(value * factor) / factor;
  },
  floor: Math.floor,
  ceil: Math.ceil,
  sqrt: Math.sqrt,
  min: (...args) => Math.min(...args),
  max: (...args) => Math.max(...args),
  pow: (a, b) => a ** b,
  log: Math.log,
  exp: Math.exp
};

const CONSTANTS = { pi: Math.PI, e: Math.E };

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const text = String(input || '').replace(/\s+/g, '');
  while (i < text.length) {
    const ch = text[i];
    if (/[0-9.]/.test(ch)) {
      let number = '';
      while (i < text.length && /[0-9.]/.test(text[i])) number += text[i++];
      if ((number.match(/\./g) || []).length > 1) throw new Error('bad number');
      tokens.push({ type: 'number', value: Number(number) });
      continue;
    }
    if (/[a-z]/i.test(ch)) {
      let name = '';
      while (i < text.length && /[a-z]/i.test(text[i])) name += text[i++].toLowerCase();
      if (FUNCTIONS[name]) tokens.push({ type: 'function', value: name });
      else if (name in CONSTANTS) tokens.push({ type: 'number', value: CONSTANTS[name] });
      else throw new Error(`unknown name: ${name}`);
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character: ${ch}`);
  }
  return tokens;
}

function evaluateExpression(input) {
  const tokens = tokenize(input);
  let pos = 0;

  function peek() {
    return tokens[pos];
  }

  function parseExpression() {
    let left = parseTerm();
    while (peek() && peek().type === 'op' && '+-'.includes(peek().value)) {
      const op = tokens[pos++].value;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parsePower();
    while (peek() && peek().type === 'op' && '*/%'.includes(peek().value)) {
      const op = tokens[pos++].value;
      const right = parsePower();
      if (op === '*') left *= right;
      else if (op === '/') left /= right;
      else left %= right;
    }
    return left;
  }

  function parsePower() {
    const base = parseUnary();
    if (peek() && peek().type === 'op' && peek().value === '^') {
      pos += 1;
      return base ** parsePower();
    }
    return base;
  }

  function parseUnary() {
    if (peek() && peek().type === 'op' && (peek().value === '-' || peek().value === '+')) {
      const op = tokens[pos++].value;
      const value = parseUnary();
      return op === '-' ? -value : value;
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = tokens[pos++];
    if (!token) throw new Error('unexpected end of expression');
    if (token.type === 'number') return token.value;
    if (token.type === 'function') {
      if (!peek() || peek().value !== '(') throw new Error(`expected ( after ${token.value}`);
      pos += 1;
      const args = [];
      if (peek() && peek().value !== ')') {
        args.push(parseExpression());
        while (peek() && peek().value === ',') {
          pos += 1;
          args.push(parseExpression());
        }
      }
      if (!peek() || peek().value !== ')') throw new Error('missing )');
      pos += 1;
      return FUNCTIONS[token.value](...args);
    }
    if (token.type === 'op' && token.value === '(') {
      const value = parseExpression();
      if (!peek() || peek().value !== ')') throw new Error('missing )');
      pos += 1;
      return value;
    }
    throw new Error(`unexpected token: ${token.value}`);
  }

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error('trailing input');
  if (!Number.isFinite(result)) throw new Error('result is not a finite number');
  return result;
}

/** True when the text looks like a calculation worth running. */
function looksLikeMath(text) {
  const value = String(text || '');
  if (!/[0-9]/.test(value)) return false;
  if (!/[-+*/^%×÷]/.test(value)) return false;
  if (/\d{4}-\d{2}-\d{2}/.test(value)) return false; // dates
  return value.length < 120;
}

module.exports = { evaluateExpression, looksLikeMath, FUNCTIONS };
