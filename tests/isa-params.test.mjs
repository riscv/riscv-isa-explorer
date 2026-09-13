import test from 'node:test';
import assert from 'node:assert/strict';

import paramData from '../src/isa-params.json' with { type: 'json' };
import graphData from '../src/isa-dependency-graph.json' with { type: 'json' };
import catalog from '../src/riscv_extensions.json' with { type: 'json' };
import {
  parameterDefinition,
  parameterNames,
  definingExtensions,
  gatingParameters,
  schemaSummary,
  describeParameter,
} from '../src/isaParams.js';

const params = paramData.params;

function catalogueIds() {
  const ids = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (node.id && node.tags) ids.add(node.id);
      Object.values(node).forEach(walk);
    }
  };
  walk(catalog);
  return ids;
}

test('every parameter definition carries the fields a consumer needs', () => {
  const names = parameterNames();
  assert.ok(names.length > 200, `expected the full UDB parameter set, got ${names.length}`);
  const bad = [];
  for (const name of names) {
    const def = params[name];
    if (def.name !== name) bad.push(`${name}: keyed as ${name} but named ${def.name}`);
    if (!def.schema) bad.push(`${name}: no schema`);
    if (!def.definedBy) bad.push(`${name}: no definedBy`);
    if (!def.src) bad.push(`${name}: no source file recorded`);
  }
  assert.deepEqual(bad, [], `incomplete definitions:\n  ${bad.join('\n  ')}`);
});

test('provenance is recorded so a stale file is visible', () => {
  assert.equal(paramData.sources.udb.repo, 'riscv/riscv-unified-db');
  assert.match(paramData.sources.udb.commit, /^[0-9a-f]{40}$|^unknown$/);
  assert.equal(paramData.sources.udb.path, 'spec/std/isa/param');
});

test('no schema value was rounded on the way in', () => {
  // CACHE_BLOCK_SIZE enumerates powers of two to 2**63 and HPM_EVENTS bounds at
  // 2**64. Parsed as doubles those come back wrong, and a wrong bound in a data
  // file is the kind of error nobody reads closely enough to catch. The sync
  // carries anything past 2**53 as an exact decimal string instead.
  const rounded = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === 'object') {
      return Object.entries(node).forEach(([k, v]) => walk(v, `${path}.${k}`));
    }
    if (typeof node === 'number' && Number.isInteger(node) && !Number.isSafeInteger(node)) {
      rounded.push(`${path} = ${node}`);
    }
  };
  walk(params, 'params');
  assert.deepEqual(rounded, [], `values stored as unsafe integers:\n  ${rounded.join('\n  ')}`);
});

test('an exact value survives the sync', () => {
  // Two spot checks with known answers, so the guard above cannot pass merely by
  // there being nothing large left in the file.
  const blocks = params.CACHE_BLOCK_SIZE.schema.enum;
  assert.equal(blocks[blocks.length - 1], (2n ** 63n).toString());
  assert.equal(params.HPM_EVENTS.schema.maxItems, (2n ** 64n).toString());
});

test('schemaSummary never describes an array as a choice', () => {
  // "one of" tells a reader to supply exactly one value. No array parameter
  // means that: HPM_COUNTER_EN wants 32 booleans and MSTATUS_FS_LEGAL_VALUES
  // wants a list drawn from an enum, not a member of it. Summarising either as
  // a choice would send someone to write a number where UDB wants a list.
  const arrays = parameterNames().filter((n) => params[n].schema?.type === 'array');
  assert.ok(arrays.length >= 10, `expected the array params to be present, found ${arrays.length}`);
  const wrong = [];
  for (const name of arrays) {
    const summary = schemaSummary(params[name].schema);
    if (/one of/i.test(summary)) wrong.push(`${name}: ${summary}`);
    if (!/^list\b/.test(summary)) wrong.push(`${name}: not described as a list: ${summary}`);
  }
  assert.deepEqual(wrong, [], `arrays described as choices:\n  ${wrong.join('\n  ')}`);
});

test('schemaSummary says something concrete about every parameter', () => {
  // The 7 typeless schemas ($ref to a width def, or a bare enum) are the ones a
  // naive summariser gives up on. Giving up is allowed by the return type and
  // must not be allowed by the tests.
  const vague = parameterNames()
    .map((n) => [n, schemaSummary(params[n].schema)])
    .filter(([, s]) => !s || s === 'unspecified');
  assert.deepEqual(
    vague.map(([n]) => n),
    [],
    `no useful summary for: ${vague.map(([n]) => n)}`,
  );
});

test('schemaSummary elides a long enum rather than reprinting the schema', () => {
  const summary = schemaSummary(params.CACHE_BLOCK_SIZE.schema);
  assert.match(summary, /and \d+ more$/, 'a 64-entry enum must be elided');
  assert.ok(
    summary.length < 120,
    `summary is ${summary.length} chars, too long to read at a glance`,
  );
});

test('definingExtensions reports extensions, never gating parameters', () => {
  // PMP_GRANULARITY is defined by a PARAMETER condition, not an extension. A
  // walker that merely collects every `name:` it meets returns NUM_PMP_ENTRIES
  // here and a caller then looks for an extension by that name and finds none.
  assert.deepEqual(definingExtensions('PMP_GRANULARITY'), []);
  assert.deepEqual(gatingParameters('PMP_GRANULARITY'), [
    { name: 'NUM_PMP_ENTRIES', op: 'greaterThan', value: 0 },
  ]);

  // And the mixed case: an allOf of an extension and two parameter conditions.
  assert.deepEqual(definingExtensions('MTVEC_BASE_ALIGNMENT_VECTORED'), ['Sm']);
  const gates = gatingParameters('MTVEC_BASE_ALIGNMENT_VECTORED').map((g) => g.name);
  assert.deepEqual(gates.sort(), ['MTVEC_ACCESS', 'MTVEC_MODES']);
});

test('every extension a parameter names exists in the catalogue', () => {
  const ids = catalogueIds();
  const missing = new Set();
  for (const name of parameterNames()) {
    for (const ext of definingExtensions(name)) if (!ids.has(ext)) missing.add(`${ext} (${name})`);
  }
  assert.deepEqual([...missing], [], `parameters name extensions we do not carry: ${[...missing]}`);
});

test('every graph parameter constraint names a parameter UDB defines', () => {
  // The gate this file exists for. isa-dependency-graph.json asserts things
  // ABOUT parameters; nothing until now checked that those parameters are real.
  // A typo in a constraint name was previously undetectable: resolveParams would
  // happily merge and emit it, and the exported config would carry a key no
  // consumer recognises.
  const unknown = [];
  for (const [id, node] of Object.entries(graphData.nodes)) {
    for (const prm of node.params ?? []) {
      if (!parameterDefinition(prm.name)) unknown.push(`${id} -> ${prm.name}`);
    }
  }
  assert.deepEqual(
    unknown,
    [],
    `constraints on parameters UDB does not define:\n  ${unknown.join('\n  ')}`,
  );
});

test('every graph constraint carries a value its schema admits', () => {
  const bad = [];
  for (const [id, node] of Object.entries(graphData.nodes)) {
    for (const prm of node.params ?? []) {
      const def = parameterDefinition(prm.name);
      if (!def?.schema) continue;
      const { type, enum: allowed } = def.schema;
      const values = [].concat(prm.value);
      for (const v of values) {
        if (type === 'boolean' && typeof v !== 'boolean') {
          bad.push(`${id} -> ${prm.name}: ${JSON.stringify(v)} is not a boolean`);
        }
        if (type === 'integer' && !Number.isInteger(v)) {
          bad.push(`${id} -> ${prm.name}: ${JSON.stringify(v)} is not an integer`);
        }
        if (type === 'string' && typeof v !== 'string') {
          bad.push(`${id} -> ${prm.name}: ${JSON.stringify(v)} is not a string`);
        }
        // `includes` names a member of a list param, so the member is checked
        // against the ITEM enum rather than the parameter's own.
        const memberEnum = prm.kind === 'includes' ? def.schema.items?.enum : allowed;
        if (memberEnum && !memberEnum.includes(v)) {
          bad.push(
            `${id} -> ${prm.name}: ${JSON.stringify(v)} is not among ${memberEnum.join(', ')}`,
          );
        }
      }
    }
  }
  assert.deepEqual(bad, [], `constraints contradicting their own schema:\n  ${bad.join('\n  ')}`);
});

test('describeParameter is null for a name UDB does not define', () => {
  assert.equal(describeParameter('NOT_A_REAL_PARAM'), null);
  assert.equal(parameterDefinition('NOT_A_REAL_PARAM'), null);
});

test('no long_name or description carries a newline', () => {
  // These land inside single-line YAML comments in an exported config. A newline
  // there ends the comment rather than wrapping it, and the rest of the sentence
  // becomes a bare line the parser rejects. Collapsed at sync time; asserted here
  // because the sync is the only thing standing between upstream prose and a
  // corrupt export.
  const multiline = parameterNames().filter(
    (n) => /[\n\r]/.test(params[n].long_name ?? '') || /[\n\r]/.test(params[n].description ?? ''),
  );
  assert.deepEqual(multiline, [], `fields spanning lines: ${multiline.join(', ')}`);
});

test('no parameter carries a placeholder as its name', () => {
  // 138 of the 228 have `long_name: TODO` upstream. Copied through, the app
  // prints "TODO" in front of a real description, in the workspace card and in
  // every exported config, where it reads as OUR unfinished work rather than
  // unified-db's. Dropped at sync time so the schema summary stands alone.
  const placeholders = parameterNames().filter((n) =>
    /^(todo|tbd|fixme|xxx|n\/a|none)\.?$/i.test((params[n].long_name ?? '').trim()),
  );
  assert.deepEqual(
    placeholders,
    [],
    `placeholder names survived the sync: ${placeholders.join(', ')}`,
  );
  // And the fallback is real: a param whose name UDB has not written still says
  // something useful about itself.
  assert.equal(params.ASID_WIDTH.long_name, null);
  assert.match(describeParameter('ASID_WIDTH').summary, /integer/);
});
