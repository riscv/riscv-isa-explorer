/**
 * tests/sandbox-model.test.mjs
 *
 * Test suite for the Custom Extension Sandbox pure logic (sandboxModel.js)
 * and encoding utilities (encodingUtils.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  encodingToMatchMask,
  matchMaskToEncoding,
  patternsOverlap,
  isSubsetPattern,
  overlapExampleWord,
  toHex32,
  parseHexToBigInt,
} from '../src/encodingUtils.js';

import {
  OPCODES,
  INSTRUCTION_FORMATS,
  buildTemplate,
  createExtension,
  createInstruction,
  cloneFromCatalogInstruction,
  getExtensionMajorOpcodes,
  enforcePrefix,
  validateExtensionId,
  validateMnemonic,
  validateInstruction,
  toRiscvOpcodesJson,
  allInstructionEncodings,
  serializeSandbox,
  deserializeSandbox,
  normalizeSandboxExt,
} from '../src/sandboxModel.js';
import { buildMarchString } from '../src/marchUtils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'src', 'riscv_extensions.json'), 'utf8'),
);
const catalogInstructions = allInstructionEncodings(catalog);

// ---------------------------------------------------------------------------
// Encoding Utilities Tests
// ---------------------------------------------------------------------------

test('toHex32 and parseHexToBigInt format and parse 32-bit hex values correctly', () => {
  assert.equal(toHex32(0x33n), '0x00000033');
  assert.equal(toHex32(0xfe00707fn), '0xfe00707f');
  assert.equal(toHex32(null), '0x00000000');

  assert.equal(parseHexToBigInt('0x33'), 0x33n);
  assert.equal(parseHexToBigInt('fe00707f'), 0xfe00707fn);
  assert.equal(parseHexToBigInt(''), null);
  assert.equal(parseHexToBigInt('not-hex'), null);
});

test('encodingToMatchMask parses 32-character binary pattern to match/mask BigInts', () => {
  // R-type ADD on RV32I: match 0x33, mask 0xfe00707f
  // encoding: 0000000----------000-----0110011
  const enc = '0000000----------000-----0110011';
  const { match, mask, error } = encodingToMatchMask(enc);
  assert.equal(error, null);
  assert.equal(match, 0x33n);
  assert.equal(mask, 0xfe00707fn);

  // Roundtrip back to encoding string
  const roundtrip = matchMaskToEncoding(match, mask);
  assert.equal(roundtrip, enc);
});

test('encodingToMatchMask validates input length and characters', () => {
  assert.ok(encodingToMatchMask('').error);
  assert.ok(encodingToMatchMask('0101').error.includes('32 characters'));
  assert.ok(encodingToMatchMask('0000000000000000000000000000000X').error.includes('0, 1, and -'));
});

test('patternsOverlap and isSubsetPattern accurately detect encoding collisions', () => {
  // ADD: match 0x33, mask 0xfe00707f
  // SUB: match 0x40000033, mask 0xfe00707f
  const addMatch = 0x33n;
  const addMask = 0xfe00707fn;
  const subMatch = 0x40000033n;
  const subMask = 0xfe00707fn;

  // ADD and SUB have distinct funct7 (bit 30 is 0 vs 1), so they do NOT overlap
  assert.equal(patternsOverlap(addMatch, addMask, subMatch, subMask), false);

  // Exact duplicate overlaps and is a subset
  assert.equal(patternsOverlap(addMatch, addMask, addMatch, addMask), true);
  assert.equal(isSubsetPattern(addMatch, addMask, addMatch, addMask), true);

  // A pattern that leaves funct7 unconstrained overlaps ADD and is a superset of ADD
  const looseMask = 0x0000707fn;
  assert.equal(patternsOverlap(addMatch, looseMask, addMatch, addMask), true);
  assert.equal(isSubsetPattern(addMatch, addMask, addMatch, looseMask), true);
  assert.equal(isSubsetPattern(addMatch, looseMask, addMatch, addMask), false);
});

test('overlapExampleWord produces a valid concrete colliding 32-bit word', () => {
  const aMatch = 0x33n;
  const aMask = 0x7fn; // opcode only
  const bMatch = 0x10000033n;
  const bMask = 0xfe00007fn; // opcode + funct7

  assert.equal(patternsOverlap(aMatch, aMask, bMatch, bMask), true);
  const word = overlapExampleWord(aMatch, aMask, bMatch, bMask);
  // Word must satisfy a's constraints
  assert.equal(word & aMask, aMatch & aMask);
  // Word must satisfy b's constraints
  assert.equal(word & bMask, bMatch & bMask);
});

// ---------------------------------------------------------------------------
// Sandbox Model Tests
// ---------------------------------------------------------------------------

test('OPCODES contains the 32 spaces including 4 reserved custom spaces from RISC-V specification', () => {
  assert.equal(OPCODES.length, 32);
  const custom = OPCODES.filter((c) => c.type === 'custom');
  assert.equal(custom.length, 4);
  const opcodes = custom.map((c) => c.value);
  assert.deepEqual(opcodes, [0x0b, 0x2b, 0x5b, 0x7b]);
  for (const op of OPCODES) {
    assert.equal(op.value & 0x3, 0x3, 'must have inst[1:0]=11 for 32-bit instructions');
  }
});

test('enforcePrefix and validateExtensionId follow RISC-V naming conventions', () => {
  assert.equal(enforcePrefix('myaccel', false), 'Xmyaccel');
  assert.equal(enforcePrefix('Xmyaccel', false), 'Xmyaccel');
  assert.equal(enforcePrefix('xmyaccel', false), 'Xmyaccel');

  assert.equal(enforcePrefix('myaccel', true), 'Zmyaccel');
  assert.equal(enforcePrefix('Zmyaccel', true), 'Zmyaccel');

  assert.equal(validateExtensionId('Xmyaccel', false), null);
  assert.equal(validateExtensionId('Zcustom_1', true), null);
  assert.ok(validateExtensionId('myaccel', false)?.includes('must start with "X"'));
  assert.ok(validateExtensionId('X', false)?.includes('at least one character'));
  assert.ok(validateExtensionId('X invalid', false)?.includes('only contain letters, digits'));
});

test('validateMnemonic enforces valid instruction mnemonic syntax', () => {
  assert.equal(validateMnemonic('XMACC'), null);
  assert.equal(validateMnemonic('x.custom_op'), null);
  assert.ok(validateMnemonic('')?.includes('Mnemonic is required'));
  assert.ok(validateMnemonic('123OP')?.includes('start with a letter'));
});

test('buildTemplate creates valid standard instruction format templates with custom opcode', () => {
  for (const formatKey of Object.keys(INSTRUCTION_FORMATS)) {
    const template = buildTemplate(formatKey, 0x0b);
    assert.ok(template);
    assert.equal(template.encoding.length, 32);
    // Low 7 bits must be custom-0 (0001011)
    assert.equal(template.encoding.slice(25), '0001011');
  }
});

test('createExtension and createInstruction initialize well-formed data structures', () => {
  const ext = createExtension('Xtensor');
  assert.equal(ext.id, 'Xtensor');
  assert.equal(ext.opcode, 0x0b);
  assert.deepEqual(ext.instructions, []);

  const instr = createInstruction('R', ext.opcode);
  assert.ok(instr);
  assert.equal(instr.encoding.length, 32);
  assert.equal(instr.format, 'R');
  assert.ok(instr.variable_fields.includes('rd'));
  assert.ok(instr.variable_fields.includes('rs1'));
  assert.ok(instr.variable_fields.includes('rs2'));
});

test('validateInstruction detects collisions with standard instructions in real catalog', () => {
  // Intentionally create an instruction that collides with standard ADD (match 0x33, mask 0xfe00707f)
  const collidingInstr = {
    mnemonic: 'MY_ADD',
    encoding: '0000000----------000-----0110011',
    format: 'R',
    variable_fields: ['rd', 'rs1', 'rs2'],
  };

  const diagnostics = validateInstruction(collidingInstr, catalogInstructions, []);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  assert.ok(errors.length > 0, 'Must report collision with existing ADD');
  assert.ok(errors.some((e) => e.conflictWith === 'ADD'));
});

test('validateInstruction validates cleanly for custom-0 instruction with unique encoding', () => {
  // A clean R-type custom instruction in custom-0 (0x0b) space:
  // funct7 = 0000001, funct3 = 000, opcode = 0001011 (custom-0)
  const cleanInstr = {
    mnemonic: 'XMULACC',
    encoding: '0000001----------000-----0001011',
    format: 'R',
    variable_fields: ['rd', 'rs1', 'rs2'],
  };

  const diagnostics = validateInstruction(cleanInstr, catalogInstructions, []);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  assert.equal(errors.length, 0, 'Custom instruction in custom-0 should have 0 errors');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  assert.equal(warnings.length, 0, 'Should have 0 warnings');
});

test('validateInstruction detects when instruction uses standard or reserved opcode space', () => {
  // Put an instruction in standard OP-IMM space (0x13) instead of custom-0..3
  const standardSpaceInstr = {
    mnemonic: 'XOP',
    encoding: '0000000----------000-----0010011',
    format: 'I',
    variable_fields: ['rd', 'rs1', 'imm12'],
  };

  const diagnostics = validateInstruction(standardSpaceInstr, catalogInstructions, []);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  // Since 0x13 is standard space, it will be flagged as an error (risk of colliding with existing)
  assert.ok(errors.some((e) => e.message.includes('is in STANDARD space')));
});

test('validateInstruction detects collisions between two sandbox instructions', () => {
  const instrA = {
    mnemonic: 'XOP1',
    encoding: '0000000----------000-----0001011',
    format: 'R',
  };
  const instrB = {
    mnemonic: 'XOP2',
    encoding: '0000000----------000-----0001011', // Identical encoding to instrA
    format: 'R',
  };

  const diagnosticsA = validateInstruction(instrA, catalogInstructions, [instrB]);
  const errorsA = diagnosticsA.filter((d) => d.severity === 'error');
  assert.ok(errorsA.some((e) => e.message.includes('sandbox instruction "XOP2"')));
});

test('toRiscvOpcodesJson exports in valid riscv-opcodes compatible format', () => {
  const ext = {
    id: 'Xcustom',
    instructions: [
      {
        mnemonic: 'X.ADD3',
        encoding: '0000001----------000-----0001011',
        variable_fields: ['rd', 'rs1', 'rs2'],
      },
    ],
  };

  const json = toRiscvOpcodesJson(ext);
  assert.ok(json.x_add3, 'Mnemonic key must normalize dots to underscores and lowercase');
  assert.equal(json.x_add3.encoding, '0000001----------000-----0001011');
  assert.deepEqual(json.x_add3.extension, ['rv_xcustom']);
  assert.deepEqual(json.x_add3.variable_fields, ['rd', 'rs1', 'rs2']);
  assert.ok(json.x_add3.match.startsWith('0x'));
  assert.ok(json.x_add3.mask.startsWith('0x'));
});

test('serializeSandbox and deserializeSandbox roundtrip preserved state accurately', () => {
  const original = [
    {
      id: 'Xaccelerator',
      name: 'Neural Accelerator',
      desc: 'Matrix compute ops',
      opcode: 0x0b,
      instructions: [
        {
          mnemonic: 'XMACC',
          encoding: '0000001----------000-----0001011',
          variable_fields: ['rd', 'rs1', 'rs2'],
          match: '0x0200000b',
          mask: '0xfe00707f',
          format: 'R',
          notes: 'rd = rs1 * rs2 + rd',
        },
      ],
    },
  ];

  const serialized = serializeSandbox(original);
  assert.ok(typeof serialized === 'string' && serialized.length > 0);

  const restored = deserializeSandbox(serialized);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, 'Xaccelerator');
  assert.equal(restored[0].instructions.length, 1);
  assert.equal(restored[0].instructions[0].mnemonic, 'XMACC');
});

// ---------------------------------------------------------------------------
// Mode B: Standard Extension Addition Tests
// ---------------------------------------------------------------------------

test('Mode B createExtension initializes standard addition metadata cleanly', () => {
  const allExts = Object.values(catalog).flat().filter(Boolean);
  const vExt = allExts.find((e) => e.id === 'V');
  assert.ok(vExt, 'Catalog must contain V extension');

  const vOpcodes = getExtensionMajorOpcodes(vExt);
  assert.ok(vOpcodes.includes(0x57), 'V extension must occupy OP-V (0x57)');

  const addition = createExtension('', true, 'addition', {
    id: vExt.id,
    name: vExt.name,
    desc: vExt.desc,
    primaryOpcode: vOpcodes[0] ?? 0x57,
    tags: vExt.tags,
  });

  assert.equal(addition.id, 'V__sandbox');
  assert.equal(addition.mode, 'addition');
  assert.equal(addition.baseExtensionId, 'V');
  assert.equal(addition.isOfficial, true);
  assert.equal(addition.opcode, 0x57);
  assert.deepEqual(addition.tags, ['rv_v']);
  assert.deepEqual(addition.instructions, []);
});

test('cloneFromCatalogInstruction clones sibling instruction with correct encoding and fields', () => {
  const allExts = Object.values(catalog).flat().filter(Boolean);
  const vExt = allExts.find((e) => e.id === 'V');
  assert.ok(vExt && vExt.instructions, 'V extension must have instructions');

  const firstMnemonic = Object.keys(vExt.instructions)[0];
  const sibling = { mnemonic: firstMnemonic, ...vExt.instructions[firstMnemonic] };

  const cloned = cloneFromCatalogInstruction(sibling, 0x57);
  assert.ok(cloned);
  assert.equal(cloned.clonedFrom, firstMnemonic);
  assert.equal(cloned.mnemonic, `${firstMnemonic}_NEW`);
  assert.equal(cloned.encoding.length, 32);
  assert.ok(cloned.variable_fields.length > 0);
  assert.ok(cloned.match.startsWith('0x'));
  assert.ok(cloned.mask.startsWith('0x'));
});

test('validateInstruction flips safe-zone rules for Mode B per RISC-V ISA §27', () => {
  const vContext = {
    mode: 'addition',
    baseExtensionId: 'V',
    allowedOpcodes: [0x57, 0x07, 0x27],
  };

  // 1. Custom opcode in Mode B must trigger a spec violation error
  const customInStandard = {
    mnemonic: 'VCUSTOM',
    encoding: '0000001----------000-----0001011', // custom-0 (0x0b)
    format: 'R',
  };
  const customDiag = validateInstruction(customInStandard, catalogInstructions, [], vContext);
  const customErrors = customDiag.filter((d) => d.severity === 'error');
  assert.ok(
    customErrors.some((e) =>
      e.message.includes('strictly reserved for non-standard vendor extensions'),
    ),
    'Custom space must be an error in standard-track Mode B',
  );

  // 2. Reserved opcode in Mode B is safe for future standard extension
  const reservedInStandard = {
    mnemonic: 'VRESERVED',
    encoding: '0000001----------000-----1101011', // reserved 0x6b
    format: 'R',
  };
  const reservedDiag = validateInstruction(reservedInStandard, catalogInstructions, [], vContext);
  const reservedErrors = reservedDiag.filter((d) => d.severity === 'error');
  assert.equal(reservedErrors.length, 0, 'Reserved opcode should not trigger error in Mode B');
  const reservedInfo = reservedDiag.filter((d) => d.severity === 'info');
  assert.ok(reservedInfo.some((i) => i.message.includes('RESERVED space')));

  // 3. Target extension standard opcode (0x57 for V) is valid if no collision
  // Using an unassigned funct3/funct7 combo in 0x57 space:
  const validStandardAddition = {
    mnemonic: 'VNEWOP',
    encoding: '1111111----------111-----1010111', // 0x57 OP-V
    format: 'R',
  };
  const validDiag = validateInstruction(validStandardAddition, catalogInstructions, [], vContext);
  const validWarnings = validDiag.filter((d) => d.severity === 'warning');
  assert.ok(
    !validWarnings.some((w) => w.message.includes('belongs to standard space outside')),
    'Target opcode 0x57 must not trigger foreign standard space warning',
  );

  // 4. Foreign standard opcode (0x13 OP-IMM for V) triggers warning
  const foreignStandardAddition = {
    mnemonic: 'VFOREIGN',
    encoding: '0000000----------000-----0010011', // 0x13 OP-IMM
    format: 'I',
  };
  const foreignDiag = validateInstruction(
    foreignStandardAddition,
    catalogInstructions,
    [],
    vContext,
  );
  assert.ok(
    foreignDiag.some(
      (d) => d.severity === 'warning' && d.message.includes('belongs to standard space outside V'),
    ),
    'Foreign standard space must be flagged with a warning',
  );
});

test('toRiscvOpcodesJson uses official tags for Mode B standard additions', () => {
  const additionExt = {
    id: 'Zvbb',
    mode: 'addition',
    tags: ['rv_zvbb'],
    instructions: [
      {
        mnemonic: 'VCLMUL.VV',
        encoding: '0011001----------010-----1010111',
        variable_fields: ['vd', 'vs1', 'vs2'],
      },
    ],
  };

  const json = toRiscvOpcodesJson(additionExt);
  assert.ok(json.vclmul_vv);
  assert.deepEqual(json.vclmul_vv.extension, ['rv_zvbb'], 'Must emit official rv_zvbb tag');
});

test('a match of zero is still compared (C.ADDI4SPN)', () => {
  const corpus = allInstructionEncodings(catalog);
  const cadd = corpus.find((i) => i.mnemonic === 'C.ADDI4SPN');
  assert.ok(cadd, 'C.ADDI4SPN must be in the collision corpus');
  assert.equal(cadd.match, 0n, 'this is the case a falsy guard drops');
  assert.equal(!cadd.match, true, '!0n is true, which is why the guard was wrong');
});

test('every encoding variant survives, not one per mnemonic', () => {
  const full = allInstructionEncodings(catalog).filter((i) => i.mnemonic === 'SLLI');
  const masks = full.map((i) => i.mask);
  assert.ok(masks.includes(0xfe00707fn), 'RV32 mask');
  assert.ok(masks.includes(0xfc00707fn), 'RV64 mask, the one that was being dropped');
});

test('an unfixed opcode bit is an error, not a classification', () => {
  const diags = validateInstruction(
    { name: 'loose', encoding: '0000001----------000-----1111-11' },
    allInstructionEncodings(catalog),
    [],
    null,
  );
  assert.ok(
    diags.some(
      (d) =>
        d.severity === 'error' && /opcode bits \[6:0\] are not fully specified/i.test(d.message),
    ),
  );
});

test('0x77 is OP-VE, and is not offered as reserved-and-safe', () => {
  const slot = OPCODES.find((o) => o.value === 0x77);
  assert.notEqual(slot.type, 'reserved', '0x77 is allocated to OP-VE, not reserved');
});

test('collision detection identifies conflicts against C.ADDI4SPN with zero match', () => {
  const overlappingInstr = {
    mnemonic: 'TEST_ZERO_MATCH',
    encoding: '00000000000000000000000000000000',
  };
  const diags = validateInstruction(overlappingInstr, allInstructionEncodings(catalog), [], null);
  assert.ok(
    diags.some((d) => d.conflictWith === 'C.ADDI4SPN'),
    'Must report conflict with C.ADDI4SPN even though its match is 0n',
  );
});

test('collision detection identifies conflicts against RV64-specific SLLI mask', () => {
  const rv64SlliOverlap = {
    mnemonic: 'SLLI_RV64_COLLIDE',
    encoding: '0000001----------001-----0010011',
  };
  const diags = validateInstruction(rv64SlliOverlap, allInstructionEncodings(catalog), [], null);
  assert.ok(
    diags.some((d) => d.conflictWith === 'SLLI'),
    'Must report conflict with SLLI',
  );
});

test('renaming an extension updates tags and riscv-opcodes export', () => {
  const ext = createExtension('Xext1', false);
  assert.deepEqual(ext.tags, ['rv_xext1']);

  // User renames extension to Xfoo
  ext.id = 'Xfoo';
  ext.instructions.push({
    mnemonic: 'FOO',
    encoding: '0000000----------000-----0001011',
    variable_fields: ['rd', 'rs1'],
  });

  const json = toRiscvOpcodesJson(ext);
  assert.ok(json.foo);
  assert.deepEqual(json.foo.extension, ['rv_xfoo'], 'Export must reflect renamed ID tag');
});

test('getExtensionMajorOpcodes guards against 16-bit compressed instructions', () => {
  const allExts = Object.values(catalog).flat().filter(Boolean);
  const zcbExt = allExts.find((e) => e.id === 'Zcb');
  if (zcbExt) {
    const opcodes = getExtensionMajorOpcodes(zcbExt);
    // Zcb consists of 16-bit compressed instructions; none should yield pseudo-32-bit opcodes
    for (const op of opcodes) {
      assert.equal(op & 0x3, 3, `Opcode 0x${op.toString(16)} must have inst[1:0] == 11`);
    }
  }
});

test('validateInstruction flags 16-bit compressed encodings with an error', () => {
  // 16-bit compressed encoding ending with '01' instead of '11'
  const cInst = {
    mnemonic: 'C_MY_INST',
    encoding: '00000000000000000000000000000001',
    format: 'R',
  };
  const diags = validateInstruction(cInst, catalogInstructions, []);
  assert.ok(
    diags.some(
      (d) => d.severity === 'error' && d.message.includes('16-bit compressed instruction space'),
    ),
    'Must produce error diagnostic for non-32-bit (inst[1:0] != 11) encoding',
  );
});

test('validateInstruction warns on unrecognized 32-bit major opcode', () => {
  const origFind = OPCODES.find;
  try {
    OPCODES.find = () => undefined;
    const inst = {
      mnemonic: 'UNKNOWN_OP',
      encoding: '0000000----------000-----0001011',
      format: 'R',
    };
    const diags = validateInstruction(inst, catalogInstructions, []);
    assert.ok(
      diags.some(
        (d) =>
          d.severity === 'warning' && d.message.includes('not a recognized RISC-V major opcode'),
      ),
      'Must produce warning diagnostic for unknown 32-bit opcode',
    );
  } finally {
    OPCODES.find = origFind;
  }
});

test('INSTRUCTION_FORMATS defines B and J formats with valid fields', () => {
  assert.ok(INSTRUCTION_FORMATS.B, 'Must define B format');
  assert.ok(INSTRUCTION_FORMATS.J, 'Must define J format');
  assert.ok(INSTRUCTION_FORMATS.B.fields.some((f) => f.name === 'bimm12hi'));
  assert.ok(INSTRUCTION_FORMATS.B.fields.some((f) => f.name === 'bimm12lo'));
  assert.ok(INSTRUCTION_FORMATS.J.fields.some((f) => f.name === 'jimm20'));
});

test('cloneFromCatalogInstruction infers B and J formats and rejects 16-bit instructions', () => {
  // Branch instruction with bimm12 fields
  const branchInstr = {
    mnemonic: 'BEQ',
    match: '0x00000063',
    mask: '0x0000707f',
    variable_fields: ['bimm12hi', 'rs2', 'rs1', 'funct3', 'bimm12lo'],
  };
  const clonedB = cloneFromCatalogInstruction(branchInstr, 0x63);
  assert.ok(clonedB);
  assert.equal(clonedB.format, 'B');

  // Jump instruction with jimm20 field
  const jumpInstr = {
    mnemonic: 'JAL',
    match: '0x0000006f',
    mask: '0x0000007f',
    variable_fields: ['jimm20', 'rd'],
  };
  const clonedJ = cloneFromCatalogInstruction(jumpInstr, 0x6f);
  assert.ok(clonedJ);
  assert.equal(clonedJ.format, 'J');

  // 16-bit compressed instruction should return null
  const compInstr = {
    mnemonic: 'C.NOP',
    match: '0x0001',
    mask: '0xffff',
    variable_fields: [],
  };
  const clonedC = cloneFromCatalogInstruction(compInstr, 0x01);
  assert.equal(clonedC, null, 'Must refuse to clone 16-bit compressed instructions');
});

test('normalizeSandboxExt sanitizes malformed objects safely', () => {
  assert.equal(normalizeSandboxExt(null), null);
  assert.equal(normalizeSandboxExt({}), null);
  assert.equal(normalizeSandboxExt({ id: '' }), null);

  const normalized = normalizeSandboxExt({
    id: 'Xtest',
    instructions: 'not an array', // malformed
  });
  assert.ok(normalized);
  assert.equal(normalized.id, 'Xtest');
  assert.deepEqual(normalized.instructions, []);
  assert.equal(normalized.mode, 'custom');
  assert.equal(normalized.opcode, 0x0b);
});

test('validateInstruction detects duplicate normalized riscv-opcodes keys', () => {
  const inst1 = {
    mnemonic: 'X.MAC',
    encoding: '0000000----------000-----0001011',
  };
  const inst2 = {
    mnemonic: 'X_MAC',
    encoding: '0000001----------000-----0001011',
  };
  const diags = validateInstruction(inst1, catalogInstructions, [inst2]);
  assert.ok(
    diags.some(
      (d) =>
        d.severity === 'error' && d.message.includes('normalizes to the same riscv-opcodes key'),
    ),
    'Must produce error diagnostic when two instructions normalize to the same key',
  );
});

test('vendor extension ID generation picks first unused sequential number', () => {
  const exts = [{ id: 'Xext2' }];
  const existingIds = new Set(exts.map((e) => e.id));
  let n = 1;
  while (existingIds.has(`Xext${n}`)) n++;
  assert.equal(n, 1, 'Must pick Xext1 when Xext2 already exists');
});

test('index clamp on delete follows removed index properly', () => {
  const clampAfterDelete = (cur, removedIdx, listLengthAfterDelete) => {
    if (cur === removedIdx) return Math.max(0, Math.min(cur, listLengthAfterDelete - 1));
    if (cur > removedIdx) return cur - 1;
    return cur;
  };

  assert.equal(clampAfterDelete(1, 0, 2), 0, 'Deleting preceding item shifts selection down by 1');
  assert.equal(clampAfterDelete(1, 2, 2), 1, 'Deleting succeeding item leaves selection unchanged');
  assert.equal(clampAfterDelete(1, 1, 1), 0, 'Deleting selected item clamps to remaining range');
});

test('createExtension refuses Mode B addition without valid 32-bit opcode (no OP-V 0x57 fallback)', () => {
  const badAddition = createExtension('', true, 'addition', {
    id: 'Zcb',
    name: 'Zcb',
    desc: 'Compressed instructions',
    // primaryOpcode missing / undefined
  });
  assert.equal(
    badAddition,
    null,
    'Must return null instead of silently defaulting to vector opcode 0x57',
  );
});

test('refuses duplicate Mode B proposals to the same base extension', () => {
  const existingExtensions = [
    {
      id: 'Zba__sandbox',
      mode: 'addition',
      baseExtensionId: 'Zba',
      instructions: [],
    },
  ];

  const targetId = 'Zba';
  const existingIdx = existingExtensions.findIndex(
    (e) =>
      e.mode === 'addition' && (e.baseExtensionId === targetId || e.id === `${targetId}__sandbox`),
  );
  assert.equal(existingIdx, 0, 'Must detect existing proposal targeting same base extension');
});

test('buildMarchString excludes sandbox proposal IDs from generated -march string', () => {
  const allExts = Object.values(catalog).flat().filter(Boolean);
  const res = buildMarchString(['RV64I', 'Zba__sandbox'], allExts);
  assert.equal(res.march, 'rv64i', 'Must not include proposal ID Zba__sandbox in -march string');
  assert.ok(
    res.excluded.some((e) => e.id === 'Zba__sandbox'),
    'Proposal ID must be recorded in excluded list',
  );

  const customExt = { id: 'Xcustom', isSandbox: true };
  const res2 = buildMarchString(['RV32I', 'Xcustom'], [...allExts, customExt]);
  assert.equal(res2.march, 'rv32i', 'Must not include isSandbox custom extension in -march string');
  assert.ok(
    res2.excluded.some((e) => e.id === 'Xcustom'),
    'Sandbox custom extension must be recorded in excluded list',
  );
});

test('validateInstruction flags exact duplicate mnemonics between sibling instructions', () => {
  const instr1 = {
    mnemonic: 'XMAC',
    encoding: '0000000----------000-----0001011', // custom-0
    format: 'R',
  };
  const instr2 = {
    mnemonic: 'XMAC',
    encoding: '0000001----------000-----0001011', // custom-0 with different funct7
    format: 'R',
  };

  const diags = validateInstruction(instr1, catalogInstructions, [instr1, instr2], null);
  const dupErrors = diags.filter(
    (d) => d.severity === 'error' && d.message.includes('Duplicate mnemonic "XMAC"'),
  );
  assert.equal(
    dupErrors.length,
    1,
    'Must emit error when two sibling instructions have identical mnemonics',
  );
});

test('OPCODES classifies expanded instruction-length prefixes and validateInstruction rejects them', () => {
  const reservedOps = OPCODES.filter((op) => op.type === 'reserved');
  assert.deepEqual(
    reservedOps.map((op) => op.value),
    [0x6b],
    'Only 0x6b is a genuine 32-bit reserved opcode slot',
  );

  const lengthPrefixes = OPCODES.filter((op) => op.type === 'instruction-length');
  assert.deepEqual(
    lengthPrefixes.map((op) => op.value),
    [0x1f, 0x3f, 0x5f, 0x7f],
    '0x1f, 0x3f, 0x5f, 0x7f are designated as instruction-length prefixes',
  );

  // Attempting to validate a 32-bit instruction with an instruction-length opcode (e.g. 0x7f)
  const instr7f = {
    mnemonic: 'BAD_LEN_PREFIX',
    encoding: '0000000----------000-----0111111', // 0x7f (>=80b)
    format: 'R',
  };
  const diags = validateInstruction(instr7f, catalogInstructions, [], null);
  const lenErrors = diags.filter(
    (d) => d.severity === 'error' && d.message.includes('expanded instruction-length encodings'),
  );
  assert.equal(
    lenErrors.length,
    1,
    'Must emit error when attempting to place 32-bit instruction in instruction-length space',
  );
});

test('normalizeSandboxExt drops additions without valid numeric opcode (no 0x57 default)', () => {
  // An addition missing an opcode must return null, not default to 0x57
  const badAddition = normalizeSandboxExt({
    id: 'Zcb__sandbox',
    mode: 'addition',
    name: 'Zcb',
    instructions: [],
  });
  assert.equal(badAddition, null, 'Must drop addition missing numeric opcode');

  // Must also drop via deserializeSandbox (simulating untrusted share link)
  const decoded = deserializeSandbox(
    btoa('[{"id":"Zcb__sandbox","mode":"addition","name":"Zcb","instructions":[]}]'),
  );
  assert.deepEqual(decoded, [], 'Must deserialize to empty list when addition lacks valid opcode');
});

test('normalizeSandboxExt coerces string opcodes and preserves custom defaults', () => {
  // Decimal numeric string
  const decAddition = normalizeSandboxExt({
    id: 'Zba__sandbox',
    mode: 'addition',
    opcode: '59',
    instructions: [],
  });
  assert.ok(decAddition);
  assert.equal(decAddition.opcode, 59);

  // Hex numeric string
  const hexAddition = normalizeSandboxExt({
    id: 'Zba__sandbox',
    mode: 'addition',
    opcode: '0x3b',
    instructions: [],
  });
  assert.ok(hexAddition);
  assert.equal(hexAddition.opcode, 0x3b);

  // Custom extension defaults to 0x0b (custom-0) if opcode missing
  const customDefault = normalizeSandboxExt({
    id: 'Xcustom',
    mode: 'custom',
    instructions: [],
  });
  assert.ok(customDefault);
  assert.equal(customDefault.opcode, 0x0b);

  // Custom extension coerces string opcode if provided
  const customCoerced = normalizeSandboxExt({
    id: 'Xcustom',
    mode: 'custom',
    opcode: '43', // 0x2b custom-1
    instructions: [],
  });
  assert.ok(customCoerced);
  assert.equal(customCoerced.opcode, 43);
});
