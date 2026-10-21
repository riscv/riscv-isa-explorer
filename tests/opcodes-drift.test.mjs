/**
 * scripts/check-opcodes-drift.mjs, against a miniature riscv-opcodes tree.
 *
 * The weekly drift report decides what reaches a human: a ratified encoding we
 * lack is reported, while assembler aliases ($pseudo_op), re-exports ($import)
 * and drafts (extensions/unratified/) never are. Each of those exclusions once
 * produced phantom gaps, so each is checked here. Bits are compared for every
 * mnemonic both sides carry, drafts included.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function opcodes(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opcodes-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, 'extensions', name)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'extensions', name), text);
  }
  return dir;
}

const drift = (dir) => {
  const run = spawnSync(process.execPath, ['scripts/check-opcodes-drift.mjs', dir, '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  return {
    status: run.status,
    report: run.stdout ? JSON.parse(run.stdout) : null,
    stderr: run.stderr,
  };
};

test('a ratified encoding we lack is reported; aliases, imports and drafts are not', () => {
  const { status, report } = drift(
    opcodes({
      rv_i: [
        '# comment',
        'add rd rs1 rs2 31..25=0 14..12=0 6..2=0x0C 1..0=3',
        '$pseudo_op rv_i::addi mv rd rs1 31..20=0',
        '$import rv_i::sub',
        'frobnicate rd rs1 31..25=1 14..12=0 6..2=0x0C 1..0=3',
      ].join('\n'),
      'unratified/rv_zdraft': 'draftop rd rs1 31..25=2 14..12=0 6..2=0x0C 1..0=3',
    }),
  );
  assert.equal(status, 1);
  assert.deepEqual(report.missing, [{ mnemonic: 'frobnicate', files: ['rv_i'] }]);
  assert.deepEqual(report.missingByFile, { rv_i: ['frobnicate'] });
  assert.equal(report.upstreamPseudoOps, 1);
  assert.equal(report.upstreamUnratifiedEncodings, 1);
});

test('in sync when upstream has nothing we lack', () => {
  const { status, report } = drift(
    opcodes({ rv_i: 'add rd rs1 rs2 31..25=0 14..12=0 6..2=0x0C 1..0=3' }),
  );
  assert.equal(status, 0);
  assert.equal(report.inSync, true);
});

test('a missing checkout is an error, not an empty report', () => {
  const { status, stderr } = drift(path.join(os.tmpdir(), 'no-such-riscv-opcodes'));
  assert.equal(status, 2);
  assert.match(stderr, /git clone/);
});

test('bits that disagree are a conflict, drafts included', () => {
  // The Zvabd case: ARC moved vabd.vv to another funct6 while the name stayed,
  // so a name-only report stayed green. Upstream here is our funct6 with one
  // bit flipped, whichever encoding the catalogue currently carries.
  const ours = JSON.parse(fs.readFileSync(path.join(root, 'src', 'instr_dict.json'), 'utf8'));
  const funct6 = (Number(ours.vabd_vv.match) >>> 26) ^ 0x04;
  const { status, report } = drift(
    opcodes({
      rv_i: 'add rd rs1 rs2 31..25=1 14..12=0 6..2=0x0C 1..0=3',
      'unratified/rv_zvabd': `vabd.vv 31..26=${funct6} vm vs2 vs1 14..12=0x2 vd 6..0=0x57`,
    }),
  );
  assert.equal(status, 1);
  assert.equal(report.inSync, false);
  assert.deepEqual(
    report.conflicts.map((c) => [c.mnemonic, c.upstream[0].file]),
    [
      ['add', 'rv_i'],
      ['vabd_vv', 'unratified/rv_zvabd'],
    ],
  );
  assert.deepEqual(report.missing, []);
});

test('pinning a bit upstream leaves free is narrower, not a conflict', () => {
  // Upstream leaves nf free on vle8.v; we pin it to 0 because the segment
  // forms are listed separately.
  const { status, report } = drift(
    opcodes({
      rv_v: 'vle8.v nf 28=0 27..26=0 vm 24..20=0 rs1 14..12=0x0 vd 6..0=0x07',
    }),
  );
  assert.equal(status, 0);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.narrowerGroups, [{ bits: '31..29', count: 1 }]);
});

test('leaving free a bit upstream pins is a conflict', () => {
  // The reverse of narrowing: ours would decode encodings upstream's does not.
  const { report } = drift(
    opcodes({ rv_i: 'add rd rs1 rs2 31..25=0 14..12=0 6..2=0x0C 1..0=3 15=1' }),
  );
  assert.deepEqual(
    report.conflicts.map((c) => c.mnemonic),
    ['add'],
  );
});
