/**
 * The opcode map arithmetic.
 *
 * Worth pinning because the width rule is easy to get wrong in a way that still
 * looks plausible. The first version classified an instruction as compressed
 * when its mask fitted in 16 bits, which sounds reasonable until you notice an
 * I-type mask of 0x707f is numerically below 0xffff. That filed ordinary 32-bit
 * instructions into quadrant 3, which does not exist, and the totals still
 * looked believable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  barWidth,
  buildEncodingMap,
  distinctInstructions,
  isThirtyTwoBit,
  FREE_SLOT_KINDS,
  OPCODE_NAMES,
} from '../src/encodingMap.js';

import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'src', 'riscv_extensions.json'), 'utf8'),
);
const instructions = distinctInstructions(catalog);
const map = buildEncodingMap(catalog);

test('width is decided by inst[1:0], not by the mask', () => {
  // The contract, stated in bits: 11 is 32-bit, everything else is compressed.
  assert.equal(isThirtyTwoBit(0b11n), true);
  assert.equal(isThirtyTwoBit(0b00n), false);
  assert.equal(isThirtyTwoBit(0b01n), false);
  assert.equal(isThirtyTwoBit(0b10n), false);

  // The regression, in real data. ADDI has a mask of 0x707f, comfortably under
  // 0xffff, so a mask-width test calls it compressed. It is not.
  const addi = instructions.find((i) => i.mnemonic === 'ADDI');
  assert.ok(addi, 'ADDI missing from the catalogue');
  assert.ok(addi.mask < 0x10000n, 'precondition: ADDI mask fits in 16 bits');
  assert.equal(isThirtyTwoBit(addi.match), true, 'ADDI is a 32-bit instruction');

  // And the genuine article: C.JAL, match 0x2001, quadrant 1.
  const cjal = instructions.find((i) => i.mnemonic === 'C.JAL');
  assert.ok(cjal, 'C.JAL missing from the catalogue');
  assert.equal(isThirtyTwoBit(cjal.match), false, 'C.JAL is compressed');
});

test('the grid is the opcode map as the manual draws it', () => {
  assert.equal(map.cells.length, 32, '8 rows of inst[4:2] by 4 columns of inst[6:5]');
  assert.equal(new Set(map.cells.map((c) => c.opcode)).size, 32, 'no slot appears twice');
  for (const cell of map.cells) {
    assert.equal(cell.opcode & 0x3, 0x3, `${cell.name} must imply inst[1:0]=11`);
    assert.ok(cell.row >= 0 && cell.row < 8, 'row is inst[4:2]');
    assert.ok(cell.col >= 0 && cell.col < 4, 'col is inst[6:5]');
    assert.equal(cell.opcode, (cell.col << 5) | (cell.row << 2) | 0x3, 'position matches opcode');
  }
});

test('every instruction lands somewhere, exactly once', () => {
  const { totals } = map;
  assert.equal(
    totals.thirtyTwoBit + totals.compressed, totals.distinct,
    'each instruction is either 32-bit or compressed, never both or neither',
  );
  assert.equal(
    map.cells.reduce((n, c) => n + c.count, 0), totals.thirtyTwoBit,
    'the grid holds every 32-bit instruction and nothing else',
  );
  assert.equal(
    map.quadrants.reduce((n, q) => n + q.count, 0), totals.compressed,
    'the quadrants hold every compressed instruction',
  );
});

test('quadrant 3 does not exist', () => {
  // inst[1:0]=11 is the 32-bit encoding, so it cannot also be a quadrant. A
  // populated quadrant 3 was the visible symptom of the mask-width bug.
  assert.deepEqual(map.quadrants.map((q) => q.quadrant), [0, 1, 2]);
});

test('a mnemonic is counted once, however many extensions offer it', () => {
  // ADD is in RV32I and in every umbrella containing it. Counting catalogue
  // entries rather than distinct mnemonics would inflate occupancy.
  const add = instructions.filter((i) => i.mnemonic === 'ADD');
  assert.equal(add.length, 1, 'ADD should collapse to a single instruction');
  assert.ok(add[0].extensions.length > 1, 'but should still record every extension offering it');
  assert.equal(
    new Set(instructions.map((i) => i.mnemonic)).size, instructions.length,
    'no mnemonic appears twice',
  );
});

test('known opcodes sit in their known slots', () => {
  const byName = new Map(map.cells.map((c) => [c.name, c]));
  // Fixed by the ISA, so these are safe to assert literally.
  assert.equal(byName.get('LOAD').opcode, 0x03);
  assert.equal(byName.get('OP-IMM').opcode, 0x13);
  assert.equal(byName.get('OP').opcode, 0x33);
  assert.equal(byName.get('SYSTEM').opcode, 0x73);
  assert.equal(OPCODE_NAMES[0x57], 'OP-V');

  const op = byName.get('OP');
  assert.ok(op.instructions.some((i) => i.mnemonic === 'ADD'), 'ADD belongs to OP');
  assert.ok(op.extensions.includes('RV32I'), 'and OP should credit the base ISA');
});

test('occupancy is reported honestly', () => {
  const { totals } = map;
  const occupied = map.cells.filter((c) => c.count > 0).length;
  assert.equal(totals.occupiedSlots, occupied, 'the headline figure matches the cells');
  assert.equal(totals.totalSlots, 32);
  assert.ok(occupied > 0 && occupied < 32, 'some slots used, some still free');
  assert.equal(
    totals.busiest.count, Math.max(...map.cells.map((c) => c.count)),
    'busiest really is the maximum',
  );

  // Ratchet, in the spirit of the catalogue coverage tests: a sync that quietly
  // stopped delivering instructions would otherwise still produce a valid map.
  assert.ok(totals.distinct > 1000, `expected over 1000 distinct instructions, found ${totals.distinct}`);
  assert.ok(occupied >= 20, `expected at least 20 opcode slots in use, found ${occupied}`);
});

test('empty cells are real slots, not missing data', () => {
  // The free slots are the interesting half of the map, so they must be present
  // and nameable rather than simply absent from the grid.
  const empty = map.cells.filter((c) => c.count === 0);
  assert.ok(empty.length > 0, 'the encoding space is not full');
  for (const cell of empty) {
    assert.ok(cell.name, `slot 0x${cell.opcode.toString(16)} has no name`);
    assert.deepEqual(cell.instructions, []);
    assert.deepEqual(cell.extensions, []);
  }
});

test('every free slot says what it is reserved for', () => {
  // Drawn as one undifferentiated grey, the free slots read as spare capacity.
  // Almost none of them is: they are vendor space, longer-than-32-bit
  // encodings, an unratified allocation, and one outright reservation. An
  // uncategorised slot would silently fall back to "unassigned" in the UI, so
  // this fails rather than letting that pass.
  const uncategorised = map.cells
    .filter((c) => c.count === 0 && c.category === 'unassigned')
    .map((c) => `${c.name} @ 0x${c.opcode.toString(16)}`);
  assert.deepEqual(uncategorised, [], `free slots with no category:\n  ${uncategorised.join('\n  ')}`);

  for (const cell of map.cells) {
    if (cell.count > 0) {
      assert.equal(cell.category, null, `${cell.name} is occupied and needs no category`);
    } else {
      assert.ok(FREE_SLOT_KINDS[cell.category], `${cell.name} has no description for ${cell.category}`);
    }
  }

  // The tally the summary sentence is built from must match the cells.
  const counted = Object.values(map.totals.freeByKind).reduce((a, b) => a + b, 0);
  assert.equal(
    counted, map.cells.filter((c) => c.count === 0).length,
    'freeByKind must account for every free slot',
  );
});

test('there are four custom opcodes, and 0x5b is one of them', () => {
  // This encodes a correction. An earlier version named 0x5b "OP-P" and filed
  // it as an unratified allocation, which was wrong twice over: the manual
  // assigns 0x5b to custom-2, and P does not use the slot at all, encoding
  // under OP-IMM, OP-IMM-32 and OP-32 (0x13, 0x1b, 0x3b) in riscv-opcodes. The
  // mistake came from treating a name in our own table as a source, so the fix
  // is pinned rather than merely applied.
  const byOpcode = new Map(map.cells.map((c) => [c.opcode, c]));
  for (const [i, opcode] of [0x0b, 0x2b, 0x5b, 0x7b].entries()) {
    const cell = byOpcode.get(opcode);
    assert.equal(cell.name, `custom-${i}`, `0x${opcode.toString(16)} should be custom-${i}`);
    assert.equal(cell.category, 'vendor', `custom-${i} is custom space`);
  }
  assert.equal(map.totals.freeByKind.vendor, 4, 'all four custom opcodes counted');
  assert.equal(map.cells.find((c) => c.name === 'OP-P'), undefined, 'nothing should claim to be OP-P');
});

test('the free-slot taxonomy describes the specification, not our dataset', () => {
  // Whether we hold instructions for a slot is a fact about this catalogue;
  // what the slot is set aside for is a fact about the specification. Only the
  // second belongs in a category, which is why "unratified" is not one.
  assert.deepEqual(
    Object.keys(FREE_SLOT_KINDS).sort(), ['reserved', 'vendor', 'wide'],
    'categories cover specification allocation only',
  );
  assert.deepEqual(
    map.totals.freeByKind, { vendor: 4, wide: 4, reserved: 1 },
    'four custom, four longer-than-32-bit, one reserved',
  );
});

test('the bar measures share of the whole, not share of the busiest slot', () => {
  // The defect this pins is a denominator, not a curve. Two earlier versions
  // divided by the busiest slot, so a full bar meant "ties OP-V": circular, and
  // unstable, because a slot's bar would shrink when a *different* slot gained
  // instructions. Dividing by the total gives a fixed interval.
  const total = map.totals.thirtyTwoBit;

  // Proportional: doubling the count doubles the length.
  assert.equal(barWidth(200, 1000), 20);
  assert.equal(barWidth(400, 1000), 40);

  // A slot holding everything fills the track. Nothing on this map does, which
  // is the point: the endpoint is real rather than whatever the maximum happens
  // to be today.
  assert.equal(barWidth(total, total), 100);
  const busiest = map.totals.busiest;
  assert.ok(
    barWidth(busiest.count, total) < 100,
    `${busiest.name} should not fill the track: it holds ${busiest.count} of ${total}`,
  );

  // The regression itself. Under the old rule the busiest slot always measured
  // 100% whatever it held, so these two would be equal.
  assert.notEqual(barWidth(busiest.count, total), barWidth(total, total));

  // And a slot's bar must not depend on any other slot. Same count, same width.
  assert.equal(barWidth(40, total), barWidth(40, total));

  // Empty stays empty; the stub is only for occupied slots.
  assert.equal(barWidth(0, total), 0);
  assert.equal(barWidth(1, total), 0.8, 'one instruction gets the hairline stub');
  assert.ok(
    barWidth(1, total) < barWidth(21, total),
    'the stub must stay below the smallest real share, or it reads as a measurement',
  );

  // Guard against a zero denominator rather than emitting NaN into a style.
  assert.equal(barWidth(5, 0), 0);
});

test('cells carry their coordinates as bits', () => {
  // The grid is only readable as the manual prints it if a cell states its own
  // position. Without these the reader has to redo the arithmetic.
  for (const cell of map.cells) {
    assert.equal(cell.rowBits, cell.row.toString(2).padStart(3, '0'));
    assert.equal(cell.colBits, cell.col.toString(2).padStart(2, '0'));
    // And the bits must reconstruct the opcode, which is the whole point.
    const rebuilt = (parseInt(cell.colBits, 2) << 5) | (parseInt(cell.rowBits, 2) << 2) | 0b11;
    assert.equal(rebuilt, cell.opcode, `${cell.name} coordinates do not rebuild its opcode`);
  }
});
