const test = require('node:test');
const assert = require('node:assert/strict');
const { matchCast, resolveCast } = require('../personality/cast');

test('cast members are matched loosely on spelling', () => {
  assert.equal(matchCast('Naazeem').id, 'naazeem');
  assert.equal(matchCast('Nazeem').id, 'naazeem');
  assert.equal(matchCast('zaaki').id, 'zaakirah');
  assert.equal(matchCast('Woody').id, 'dawood');
  assert.equal(matchCast('Dawud').id, 'dawood');
  assert.equal(matchCast('Fatima').id, 'fatima');
  assert.equal(matchCast('David Nkana').id, 'david');
});

test('unknown people get no cast member', () => {
  assert.equal(matchCast('Sarah'), null);
  assert.equal(matchCast(''), null);
});

test('the speaker rule is selected from the sender name', () => {
  const cast = resolveCast({ speakerName: 'Naazeem', text: 'hello' });
  assert.equal(cast.speaker.id, 'naazeem');
  assert.match(cast.rules, /respectful and confident/);
});

test('no hierarchy titles survive anywhere in the cast', () => {
  const banned = ['supreme leader', 'second in command', 'worse version of you', 'qween mother'];
  const names = ['Naazeem', 'David', 'Zaaki', 'Woody', 'Fatima', 'Sarah'];
  for (const name of names) {
    const rules = resolveCast({ speakerName: name, text: 'hi' }).rules.toLowerCase();
    for (const phrase of banned) {
      assert.ok(!rules.includes(phrase), `${name} still uses "${phrase}"`);
    }
  }
});

test('zaakirah gets playful bluntness without a nickname label', () => {
  const cast = resolveCast({ speakerName: 'Zaaki', text: 'hi' });
  assert.match(cast.rules, /playful and blunt/);
});

test('dawood stays easy to tease', () => {
  const cast = resolveCast({ speakerName: 'Dawood', text: 'hi' });
  assert.match(cast.rules, /easy to tease/);
});

test('fatima is always treated nicely', () => {
  const cast = resolveCast({ speakerName: 'Fatima', text: 'hi' });
  assert.match(cast.rules, /genuinely warm and kind/);
  assert.match(cast.rules, /No sarcasm/);
});

test('david gets relaxed directness with no ceremony', () => {
  const cast = resolveCast({ speakerName: 'David', text: 'hi' });
  assert.match(cast.rules, /relaxed and direct/);
  assert.match(cast.rules, /No titles/);
});

test('someone named in the message also brings their rules', () => {
  const cast = resolveCast({ speakerName: 'Sarah', text: 'what should we tell Naazeem?' });
  assert.equal(cast.speaker, null);
  assert.equal(cast.mentioned.length, 1);
  assert.equal(cast.mentioned[0].id, 'naazeem');
});

test('everyone else falls back to the default', () => {
  const cast = resolveCast({ speakerName: 'Sarah', text: 'morning' });
  assert.match(cast.rules, /no special treatment/i);
});
