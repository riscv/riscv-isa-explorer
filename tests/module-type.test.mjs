import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('src/ loads as ES modules without a module type warning', () => {
  const url = pathToFileURL(path.join(root, 'src', 'marchUtils.js')).href;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `importing src/marchUtils.js failed:\n${result.stderr}`);
  assert.ok(
    !result.stderr.includes('MODULE_TYPELESS_PACKAGE_JSON'),
    `src/package.json must keep "type": "module"; Node warned:\n${result.stderr}`,
  );
});
