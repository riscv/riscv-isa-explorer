/**
 * docs/TESTING.md is the list of the explorer's key parts and the tests behind
 * each. This keeps it true: every source file and script must be on it, every
 * file and test it names must exist, and every module must be mentioned by at
 * least one of the tests its row names. A new module therefore cannot ship
 * without a row, and a row cannot point at a test that does not look at it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = fs.readFileSync(path.join(root, 'docs', 'TESTING.md'), 'utf8');

const rows = doc
  .split('\n')
  .filter((line) => /^\| [^-|][^|]*\| `/.test(line))
  .map((line) => {
    const [, part, files, tests] = line.split('|').map((cell) => cell.trim());
    const ticks = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    return { part, files: ticks(files), tests: ticks(tests) };
  });

test('the table has rows, and every file and test it names exists', () => {
  assert.ok(rows.length >= 20, `expected the full table, found ${rows.length} rows`);
  for (const row of rows) {
    assert.ok(row.files.length && row.tests.length, `${row.part}: needs files and tests`);
    for (const file of row.files) {
      assert.ok(fs.existsSync(path.join(root, file)), `${row.part}: ${file} does not exist`);
    }
    for (const t of row.tests) {
      assert.ok(
        fs.existsSync(path.join(root, 'tests', `${t}.test.mjs`)),
        `${row.part}: tests/${t}.test.mjs does not exist`,
      );
    }
  }
});

test('every source file and script is on the list', () => {
  const listed = new Set(rows.flatMap((row) => row.files));
  const files = [
    ...fs
      .readdirSync(path.join(root, 'src'))
      .filter((f) => /\.(jsx?|json)$/.test(f))
      .map((f) => `src/${f}`),
    ...fs
      .readdirSync(path.join(root, 'scripts'))
      .filter((f) => /\.(mjs|cjs|js)$/.test(f))
      .map((f) => `scripts/${f}`),
  ];
  const missing = files.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `add these to docs/TESTING.md with the tests that cover them`);
});

test('each JS module is mentioned by at least one of the tests its row names', () => {
  // Components are covered by the render tests, which drive the built bundle
  // rather than importing them, and data files by name or by the module that
  // reads them, so only plain modules and scripts are held to this.
  for (const row of rows) {
    const texts = row.tests.map((t) =>
      fs.readFileSync(path.join(root, 'tests', `${t}.test.mjs`), 'utf8'),
    );
    for (const file of row.files.filter((f) => /\.(js|mjs|cjs)$/.test(f))) {
      const name = path.basename(file);
      assert.ok(
        texts.some((text) => text.includes(name)),
        `${row.part}: none of ${row.tests.join(', ')} mentions ${name}`,
      );
    }
  }
});
