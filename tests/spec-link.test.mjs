/**
 * The details panel's specification button (src/specLink.js). Its label has
 * to say where the link goes, because the catalogue mixes published chapters
 * with GitHub sources.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { specificationLink } from '../src/specLink.js';

const require = createRequire(import.meta.url);
const catalog = require('../src/riscv_extensions.json');

test('a docs.riscv.org chapter reads as the specification and names the site', () => {
  const link = specificationLink('https://docs.riscv.org/reference/isa/unpriv/b-st-ext.html');
  assert.equal(link.label, 'Read the specification');
  assert.equal(link.host, 'docs.riscv.org');
});

test('a GitHub link says it is the source, and whether it is only the repository', () => {
  assert.deepEqual(specificationLink('https://github.com/riscv/riscv-isa-manual'), {
    url: 'https://github.com/riscv/riscv-isa-manual',
    label: 'ISA manual source',
    host: 'GitHub',
  });
  const file = specificationLink(
    'https://github.com/riscv/riscv-isa-manual/blob/main/src/unpriv/zp.adoc',
  );
  assert.equal(file.label, 'Specification source');
  assert.equal(file.host, 'GitHub');
});

test('a missing URL falls back to the ISA manual, as the name link does', () => {
  assert.equal(specificationLink(undefined).url, 'https://github.com/riscv/riscv-isa-manual');
});

test('every catalogue entry gets a labelled, absolute link', () => {
  for (const ext of Object.values(catalog).flat()) {
    if (!ext) continue;
    const link = specificationLink(ext.url);
    assert.match(link.url, /^https:\/\//, ext.id);
    assert.ok(link.label && link.host, ext.id);
  }
});
