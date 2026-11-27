/**
 * Our dependency model, checked against riscv-config — RISC-V International's
 * own validator (riscv/riscv-config, isa_validator.py, v3.18.3).
 *
 * A third opinion, independent of riscv-unified-db and of clang. All 32 of our
 * canonical -march strings were accepted by it, and 9 of its rules were already
 * encoded here. The rules below are transcribed from that file so a future
 * change that contradicts the official validator fails in CI.
 *
 * The rules are transcribed rather than executed. riscv-config is Python, knows
 * 74 sub-extensions against our 227 (so it skips every profile), spells strings
 * differently from -march, and crashes on valid input — get_extension_list
 * ("RV64IZicsr_Zk") raises IndexError, because it reads the third character of
 * a two-character extension name. Shelling out to it would add a dependency, a
 * translation layer, and a silent-skip problem, for rules that fit in a table.
 *
 * Three of its rules are deliberately NOT asserted; see EXCLUDED below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closure, resolveSelection } from '../src/isaGraph.js';
import { buildMarchString, SHORTHAND_BUNDLES } from '../src/marchUtils.js';

const ALL = (() => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'riscv_extensions.json');
  return Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).flat().filter(Boolean);
})();
const CATALOG_IDS = new Set(ALL.map((e) => e.id));

/** "X cannot exist without Y" — from isa_validator.py. */
const REQUIRES = {
  F: 'Zicsr',
  D: 'F',
  Q: 'D',
  S: 'U',
  Zfinx: 'Zicsr',
  Zdinx: 'Zfinx',
  Zhinx: 'Zfinx',
  Zhinxmin: 'Zfinx',
};

/** "X and Y cannot exist together" — from isa_validator.py. */
const CONFLICTS = [
  ['F', 'Zfinx'],
  ['Zhinx', 'Zfh'],
  ['Zhinxmin', 'Zfh'],
];

/**
 * Rules we do not assert, with the reason. Kept visible so nobody has to
 * re-derive why the transcription is incomplete.
 */
const EXCLUDED = {
  'Zam -> A': 'Zam is not in our catalog, so the rule has nothing to apply to.',
  'N -> U': 'N (User-Level Interrupts) was removed from the specification in 2024. ' +
            'riscv-config still carries the rule; we keep N only as a historical catalog entry.',
  'Zfa -> Zfh': 'Disputed. riscv-config claims Zfa requires Zfh; UDB (Zfa.yaml) requires only F, ' +
                'and Zfa adds instructions for whichever FP types are present — only its ' +
                'half-precision forms need Zfh. riscv-config appends this message but never sets ' +
                'its error flag, so even there it is advisory. We follow UDB.',
};

test('the exclusion list stays honest', () => {
  // A reason that says nothing is worse than no entry at all.
  for (const [rule, reason] of Object.entries(EXCLUDED)) {
    assert.ok(reason.length > 40, `${rule}: exclusion reason is too thin to be useful`);
  }
  assert.equal(Object.keys(EXCLUDED).length, 3, 'exclusions changed — update the reasoning too');
});

for (const [ext, required] of Object.entries(REQUIRES)) {
  test(`riscv-config: ${ext} cannot exist without ${required}`, () => {
    assert.ok(CATALOG_IDS.has(ext), `${ext} is missing from the catalog`);
    assert.ok(
      closure(ext).has(required),
      `${ext} should reach ${required}; closure is [${[...closure(ext)].join(', ')}]`,
    );
  });
}

for (const [a, b] of CONFLICTS) {
  test(`riscv-config: ${a} and ${b} cannot exist together`, () => {
    // Checked through resolveSelection, not the flat conflict table: Zhinxmin
    // conflicts with Zfhmin, and Zfh only reaches that through Zfh -> Zfhmin.
    // Reading the table alone reports a false gap.
    const result = resolveSelection({ selected: [a, b] });
    assert.ok(
      result.conflicts.length > 0,
      `selecting ${a} with ${b} should conflict, got none`,
    );
  });
}

/**
 * Transcribed from riscv-config, NOT derived from SHORTHAND_BUNDLES.
 *
 * Deriving the expectation from the constant under test makes the test vacuous:
 * delete an entry and the loop simply stops checking it. This list is the
 * independent statement of what must hold.
 */
const EXPECTED_SHORTHANDS = {
  Zkn: ['Zbkb', 'Zbkc', 'Zbkx', 'Zknd', 'Zkne', 'Zknh'],
  Zks: ['Zbkb', 'Zbkc', 'Zbkx', 'Zksed', 'Zksh'],
  Zk:  ['Zbkb', 'Zbkc', 'Zbkx', 'Zknd', 'Zkne', 'Zknh', 'Zkn', 'Zkr', 'Zkt'],
};

test('every shorthand riscv-config knows about is modelled', () => {
  for (const [shorthand, members] of Object.entries(EXPECTED_SHORTHANDS)) {
    assert.ok(SHORTHAND_BUNDLES[shorthand], `${shorthand} is missing from SHORTHAND_BUNDLES`);
    assert.deepEqual(
      [...SHORTHAND_BUNDLES[shorthand]].sort(),
      [...members].sort(),
      `${shorthand} members disagree with riscv-config`,
    );
  }
});

test('a shorthand absorbs its members in the ISA string', () => {
  // riscv-config: "In presence of Zkn the subsets must be ignored in the ISA
  // string." clang accepts the redundant form, so only the official validator
  // catches this.
  for (const [shorthand, members] of Object.entries(EXPECTED_SHORTHANDS)) {
    const { resolved } = resolveSelection({ selected: ['RV64I', shorthand], base: 'RV64I' });
    const { march, excluded } = buildMarchString(resolved.filter((id) => CATALOG_IDS.has(id)), ALL);
    assert.ok(march, `${shorthand} produced no -march string`);
    const tokens = march.split('_');
    assert.ok(tokens.includes(shorthand.toLowerCase()), `${shorthand} itself should be emitted`);
    for (const member of members) {
      assert.ok(
        !tokens.includes(member.toLowerCase()),
        `${march} lists ${member}, which ${shorthand} already covers`,
      );
      assert.ok(
        excluded.some((e) => e.id === member),
        `${member} should be reported as covered by ${shorthand}, not dropped silently`,
      );
    }
  }
});

test('ordinary dependencies are NOT absorbed', () => {
  // The rule above is narrow. D implies F and both belong in the string; a
  // blanket "drop anything implied" would silently mangle every config.
  const { resolved } = resolveSelection({ selected: ['RV64I', 'D'], base: 'RV64I' });
  const { march } = buildMarchString(resolved.filter((id) => CATALOG_IDS.has(id)), ALL);
  assert.match(march, /f/, `F should still appear alongside D: ${march}`);
  assert.match(march, /d/, `D should appear: ${march}`);
});
