import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/*
 * Copy that states a catalogue figure must derive it, never spell it out.
 *
 * The Evolution dialog said "219 catalogued extensions" in two places while the
 * UDB sync ran daily against upstream. The first day that sync adds an entry,
 * both sentences become quietly wrong -- the page keeps rendering, nothing
 * fails, and the number is simply a lie. It is the same failure as the tooltip
 * that described a waffle chart for eight redesigns after the waffle was
 * deleted: prose has no test, so it rots in place while the code around it
 * moves.
 *
 * This is the cheapest possible guard. It does not check that the prose is
 * true; it checks that the prose cannot state a catalogue count without asking
 * the catalogue.
 */

const SOURCES = readdirSync('src')
  .filter((f) => f.endsWith('.jsx'))
  .map((f) => ({ file: `src/${f}`, text: readFileSync(`src/${f}`, 'utf8') }));

test('no copy hardcodes a count of catalogued extensions', () => {
  const offenders = [];

  for (const { file, text } of SOURCES) {
    for (const [i, line] of text.split('\n').entries()) {
      // Only prose that actually claims a catalogue figure. A bare number
      // elsewhere is almost always geometry, and flagging those would make the
      // guard noise that someone deletes.
      // Comments are out of remit. This guards what a reader is shown, and a
      // guard that also polices prose in comments becomes noise someone deletes
      // -- taking the useful half with it.
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
      if (!/catalogued extension/i.test(code)) continue;
      const digits = line.match(/\b\d{2,}\b/g);
      if (digits) {
        offenders.push(`${file}:${i + 1} states ${digits.join(', ')} — derive it instead`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Copy naming a catalogue size must read it from the catalogue, ` +
      `e.g. \${allExtensionsFlat.length}:\n  ${offenders.join('\n  ')}`,
  );
});

test('the Evolution copy is derived, not literal', () => {
  const view = readFileSync('src/risc_v_visualizer.jsx', 'utf8');
  const claims = view.split('\n').filter((l) => /catalogued extension/i.test(l));

  assert.ok(claims.length >= 2, 'expected the tooltip and the dialog subtitle');
  for (const line of claims) {
    assert.match(
      line,
      /allExtensionsFlat\.length/,
      `this copy names a catalogue size without deriving it: ${line.trim()}`,
    );
  }
});
