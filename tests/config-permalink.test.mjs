import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  configQuery,
  decodeBuilderConfig,
  encodeBuilderConfig,
  findProfileName,
  readConfigParam,
  sameBuilderConfig,
  sanitizeBuilderState,
} from '../src/configPermalink.js';
import { missingMandatory } from '../src/workspaceLock.js';
import { PROFILES } from '../src/profiles.js';

const require = createRequire(import.meta.url);
const extensions = require('../src/riscv_extensions.json');
const catalogIds = new Set(
  Object.values(extensions)
    .flat()
    .filter(Boolean)
    .map((ext) => ext.id),
);
const CHECKS = { catalogIds, profiles: PROFILES, missingMandatory };

const roundTrip = (state) =>
  sanitizeBuilderState(decodeBuilderConfig(encodeBuilderConfig(state, PROFILES), PROFILES), CHECKS);

test('findProfileName ignores case, as the issue spelled it', () => {
  assert.equal(findProfileName('rva23.1', PROFILES), 'RVA23.1');
  assert.equal(findProfileName(' RVB23 ', PROFILES), 'RVB23');
  assert.equal(findProfileName('RVA99', PROFILES), null);
  assert.equal(findProfileName('', PROFILES), null);
  assert.equal(findProfileName(null, PROFILES), null);
});

test('a compliant profile configuration is written as the profile alone', () => {
  const value = encodeBuilderConfig(
    {
      workspaceIds: PROFILES['RVA23.1'],
      seedProfile: 'RVA23.1',
      customFromProfile: null,
      paramChoices: {},
      baselineLocked: true,
    },
    PROFILES,
  );
  assert.equal(value, '1;p:RVA23.1');
});

test('additions, removals, the released floor and parameters survive a round trip', () => {
  const removed = PROFILES.RVA23[0];
  const state = {
    workspaceIds: [...PROFILES.RVA23.filter((id) => id !== removed), 'Zbc', 'Zfh'],
    seedProfile: null,
    customFromProfile: 'RVA23',
    paramChoices: { VLEN: 256, MODE: 'bare', FLAG: true },
    baselineLocked: false,
  };
  const value = encodeBuilderConfig(state, PROFILES);
  assert.match(value, /^1;c:RVA23;a:Zbc,Zfh;r:/);
  assert.match(value, /;u;/);

  const back = roundTrip(state);
  assert.deepEqual(new Set(back.workspaceIds), new Set(state.workspaceIds));
  assert.equal(back.seedProfile, null);
  assert.equal(back.customFromProfile, 'RVA23');
  assert.equal(back.baselineLocked, false);
  assert.deepEqual(back.paramChoices, { VLEN: 256, MODE: 'bare', FLAG: true });
});

test('a configuration with no profile lists every extension', () => {
  const state = {
    workspaceIds: ['RV64I', 'M', 'Zba'],
    seedProfile: null,
    customFromProfile: null,
    paramChoices: {},
    baselineLocked: true,
  };
  assert.equal(encodeBuilderConfig(state, PROFILES), '1;a:M,RV64I,Zba');
  assert.deepEqual(new Set(roundTrip(state).workspaceIds), new Set(['RV64I', 'M', 'Zba']));
});

test('parameter values that need escaping cannot break the format', () => {
  const state = {
    workspaceIds: ['RV64I'],
    seedProfile: null,
    customFromProfile: null,
    paramChoices: { ODD: 'a,b;c=d e' },
    baselineLocked: true,
  };
  assert.deepEqual(roundTrip(state).paramChoices, { ODD: 'a,b;c=d e' });
});

test('an empty builder has nothing to share', () => {
  assert.equal(encodeBuilderConfig({ workspaceIds: [] }, PROFILES), '');
  assert.equal(encodeBuilderConfig({}, PROFILES), '');
});

test('malformed or foreign values decode to nothing rather than throwing', () => {
  for (const value of [null, '', 'nonsense', '2;p:RVA23', '1', '1;p:RVA99', '1;o:%E0%A4%A']) {
    assert.equal(decodeBuilderConfig(value, PROFILES), null, String(value));
  }
});

test('unknown extensions in a link are dropped, not passed to -march', () => {
  const back = sanitizeBuilderState(decodeBuilderConfig('1;a:RV64I,M,Xbogus', PROFILES), CHECKS);
  assert.deepEqual(back.workspaceIds, ['RV64I', 'M']);
});

test('a link claiming a held profile floor it does not satisfy is released (#214)', () => {
  const removed = PROFILES.RVA23[0];
  // A hand-edited link: p: says compliant, r: removes a mandatory extension.
  const back = sanitizeBuilderState(
    decodeBuilderConfig(`1;p:RVA23;r:${removed}`, PROFILES),
    CHECKS,
  );
  assert.equal(back.seedProfile, null);
  assert.equal(back.customFromProfile, 'RVA23');
  assert.equal(back.baselineLocked, false);
  assert.ok(!back.workspaceIds.includes(removed));
});

test('unknown segments from a newer link are skipped', () => {
  const back = decodeBuilderConfig('1;p:RVB23;z:future', PROFILES);
  assert.equal(back.seedProfile, 'RVB23');
});

test('sameBuilderConfig ignores order', () => {
  const a = { workspaceIds: ['M', 'RV64I'], paramChoices: { B: 1, A: 2 } };
  const b = { workspaceIds: ['RV64I', 'M'], paramChoices: { A: 2, B: 1 } };
  assert.ok(sameBuilderConfig(a, b, PROFILES));
  assert.ok(!sameBuilderConfig(a, { workspaceIds: ['RV64I'] }, PROFILES));
});

test('the link keeps its separators readable and values encoded once', () => {
  const value = encodeBuilderConfig(
    {
      workspaceIds: [...PROFILES.RVA23, 'Zbc'],
      seedProfile: 'RVA23',
      paramChoices: { LRSC_RESERVATION_STRATEGY: 'reserve naturally-aligned 64-byte region' },
      baselineLocked: true,
    },
    PROFILES,
  );
  assert.equal(
    configQuery(value),
    '?cfg=1;p:RVA23;a:Zbc;o:LRSC_RESERVATION_STRATEGY=reserve%20naturally-aligned%2064-byte%20region',
  );
  assert.equal(readConfigParam(configQuery(value)), value);
});

test('readConfigParam accepts a link a client has re-escaped', () => {
  const value = '1;p:RVA23;o:ODD=a%2Cb';
  const escaped = `?${new URLSearchParams({ ext: 'Zba', cfg: value })}`;
  assert.ok(!escaped.includes(';'));
  assert.equal(readConfigParam(escaped), value);
  assert.equal(readConfigParam('?ext=Zba&cfg=1;p:RVB23'), '1;p:RVB23');
  assert.equal(readConfigParam('?ext=Zba'), null);
  assert.equal(readConfigParam(''), null);
});

test('choices for parameters isa-params.json does not define are dropped', () => {
  const back = sanitizeBuilderState(
    { workspaceIds: ['RV64I'], paramChoices: { LRSC_RESERVATION_STRATEGY: 'x', VLEN: 256 } },
    { ...CHECKS, paramNames: new Set(['LRSC_RESERVATION_STRATEGY']) },
  );
  assert.deepEqual(back.paramChoices, { LRSC_RESERVATION_STRATEGY: 'x' });
});
