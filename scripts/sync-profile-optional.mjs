/**
 * Resolve each profile's OPTIONAL extension set from riscv-unified-db.
 *
 * Why a resolver rather than a copy: UDB profiles are layered. RVA23U64 declares
 * only its delta — nine entries — and inherits the rest from RVB23U64, which
 * inherits from RVA22U64, and so on back to RVI20U64. The chain is expressed by
 * `$inherits` plus a `$remove` list, and both must be applied in order.
 *
 * Naive set subtraction gets this wrong. Deriving RVA23U64 by removing its
 * mandatory promotions from RVB23U64's optional set yields 20 extensions; the
 * ratified spec lists 15. The five extras — Zvkg, Zvknc, Zvksc, Zkn, Zks — are
 * exactly RVA23U64's `$remove`. Honouring `$remove` reproduces the spec exactly,
 * which is what the self-check below asserts.
 *
 * Mandatory sets are deliberately NOT written. Those live in src/profiles.js,
 * are validated against a real clang in CI, and differ from UDB by modelling
 * rather than by error: UDB counts S and U as extensions and expresses the base
 * as `base: 64`, where this project uses RV64I and Ss1p13.
 *
 *   node scripts/sync-profile-optional.mjs <path-to-udb>          # write
 *   node scripts/sync-profile-optional.mjs <path-to-udb> --check  # verify only
 */
import fs from 'node:fs';
import path from 'node:path';

/*
 * The families, and the UDB profiles each resolves from.
 *
 * The A and B families are U64+S64 pairs. RVI20 is unprivileged and has no
 * supervisor half, so each of its two profiles stands alone — the second slot
 * is simply absent, and resolve() returns {} for it.
 *
 * RVI20 matters more here than its size suggests: it mandates nothing beyond
 * the base ISA, so ALL of its content is optional. Without an entry the builder
 * offers no add-chips at all and the profile reads as empty rather than minimal.
 */
const PROFILE_PAIRS = {
  RVI20U32: ['RVI20U32'],
  /*
   * RVI20U64 resolves from RVI20U32 rather than from its own file, because its
   * file has no `extensions:` block at all — it inherits the whole document:
   *
   *   $inherits: "profile/RVI20U32.yaml#"
   *
   * Teaching resolve() to follow that generally is tempting and wrong. The A
   * and B chains inherit from RVI20U64 too, and following it there re-admits
   * Zca, Zcd, Zcf and Zifencei as RVA23 options, which the ratified profile
   * does not list — SPEC_CHECK below catches it. Naming the parent here keeps
   * the fix where the difference actually is.
   */
  RVI20U64: ['RVI20U32'],
  RVA20: ['RVA20U64', 'RVA20S64'],
  RVA22: ['RVA22U64', 'RVA22S64'],
  RVA23: ['RVA23U64', 'RVA23S64'],
  RVB23: ['RVB23U64', 'RVB23S64'],
};

/*
 * Extensions that exist for one XLEN only, and the XLEN they belong to.
 *
 * UDB's RVI20U64 inherits RVI20U32 wholesale with no `$remove`, so Zcf — the
 * compressed single-precision loads and stores, which the Zc specification
 * defines for RV32 alone — is inherited into a 64-bit profile. Offering it
 * there would put an unbuildable chip in front of the reader. The catalogue
 * already carries the same fact in its tags: Zcf is `rv32_c_f`, while Zcd is
 * `rv_c_d` and is correctly available to both.
 */
const XLEN_ONLY = { Zcf: 32 };

/** The XLEN each family targets. Everything but RVI20U32 is 64-bit. */
const FAMILY_XLEN = { RVI20U32: 32 };
const xlenOf = (family) => FAMILY_XLEN[family] ?? 64;

// From the ratified RVA23 profiles document. The resolver must reproduce these
// exactly; if it cannot, the inheritance rules have changed upstream and the
// output is not trustworthy.
const SPEC_CHECK = {
  RVA23U64: ['Zabha', 'Zacas', 'Zama16b', 'Zbc', 'Zfbfmin', 'Zfh', 'Ziccamoc', 'Zicfilp',
    'Zicfiss', 'Zvbc', 'Zvfbfmin', 'Zvfbfwma', 'Zvfh', 'Zvkng', 'Zvksg'],
  RVA23S64: ['Sdtrig', 'Sspm', 'Ssstrict', 'Sv48', 'Sv57', 'Svadu', 'Svvptc', 'Zkr'],
};

const udbRoot = process.argv[2];
const checkOnly = process.argv.includes('--check');

if (!udbRoot || !fs.existsSync(udbRoot)) {
  console.error('usage: node scripts/sync-profile-optional.mjs <path-to-riscv-unified-db> [--check]');
  process.exit(1);
}

const profileDir = path.join(udbRoot, 'spec', 'std', 'isa', 'profile');
if (!fs.existsSync(profileDir)) {
  console.error(`no profile directory at ${profileDir}`);
  process.exit(1);
}

/**
 * Minimal reader for the `extensions:` block. A YAML dependency is not worth
 * adding for one nested map, and the shape here is narrow: two levels of
 * indentation, `presence:` either inline or on the following line, plus the
 * `$inherits` / `$remove` directives.
 */
function readExtensions(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^extensions:\s*$/.test(l));
  if (start === -1) return { inherits: [], remove: [], own: {} };

  const inherits = [];
  const remove = [];
  const own = {};
  let current = null;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() !== '') break; // dedented out of the block
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const inh = trimmed.match(/^\$inherits:\s*(.*)$/);
    if (inh) {
      const v = inh[1].trim();
      if (v.startsWith('[')) v.slice(1, -1).split(',').forEach((x) => inherits.push(x.trim().replace(/['"]/g, '')));
      else if (v) inherits.push(v.replace(/['"]/g, ''));
      current = '$inherits';
      continue;
    }
    if (/^\$remove:/.test(trimmed)) {
      const v = trimmed.replace(/^\$remove:\s*/, '').trim();
      if (v.startsWith('[')) v.slice(1, -1).split(',').forEach((x) => remove.push(x.trim().replace(/['"]/g, '')));
      else if (v) remove.push(v.replace(/['"]/g, ''));
      current = '$remove';
      continue;
    }
    const item = trimmed.match(/^-\s*(.+)$/);
    if (item) {
      const value = item[1].trim().replace(/['"]/g, '');
      if (current === '$remove') remove.push(value);
      else if (current === '$inherits') inherits.push(value);
      continue;
    }
    // `Zvbc:` opens an extension, `presence: mandatory` may follow inline or below.
    const ext = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (ext && /^\s{2}\S/.test(line)) {
      current = ext[1];
      own[current] = 'optional';
      continue;
    }
    const pres = trimmed.match(/^presence:\s*(.+)$/);
    if (pres && current && own[current] !== undefined) {
      own[current] = pres[1].trim() === 'mandatory' ? 'mandatory' : 'optional';
    }
  }
  return { inherits, remove, own };
}

function resolve(name, seen = new Set()) {
  if (seen.has(name)) return {};
  seen.add(name);
  const file = path.join(profileDir, `${name}.yaml`);
  if (!fs.existsSync(file)) return {};

  const { inherits, remove, own } = readExtensions(file);
  const out = {};
  for (const ref of inherits) {
    const parent = ref.replace(/^profile\//, '').replace(/\.yaml#\/extensions$/, '');
    Object.assign(out, resolve(parent, new Set(seen)));
  }
  for (const r of remove) delete out[r];
  for (const [k, v] of Object.entries(own)) out[k] = v;
  return out;
}

const optionalByFamily = {};
for (const [family, [u, s]] of Object.entries(PROFILE_PAIRS)) {
  const merged = { ...resolve(s), ...resolve(u) };
  const uRes = resolve(u);
  const sRes = resolve(s);
  const mandatory = new Set(
    [...Object.entries(uRes), ...Object.entries(sRes)].filter(([, v]) => v === 'mandatory').map(([k]) => k),
  );
  const optional = [
    ...new Set(
      [...Object.entries(uRes), ...Object.entries(sRes)]
        .filter(([, v]) => v === 'optional')
        .map(([k]) => k),
    ),
  ]
    // An extension mandatory in either half is not optional for the pair.
    .filter((k) => !mandatory.has(k))
    // ...nor is one that cannot exist at this profile's XLEN.
    .filter((k) => !(k in XLEN_ONLY) || XLEN_ONLY[k] === xlenOf(family))
    .sort();
  optionalByFamily[family] = optional;
  void merged;
}

let failed = false;
for (const [profile, expected] of Object.entries(SPEC_CHECK)) {
  const got = Object.entries(resolve(profile))
    .filter(([, v]) => v === 'optional')
    .map(([k]) => k)
    .sort();
  const missing = expected.filter((e) => !got.includes(e));
  const extra = got.filter((g) => !expected.includes(g));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`${profile}: does not match the ratified spec`);
    if (missing.length) console.error(`  missing: ${missing.join(', ')}`);
    if (extra.length) console.error(`  extra:   ${extra.join(', ')}`);
  } else {
    console.log(`ok    ${profile}  ${got.length} optional extensions match the spec`);
  }
}
if (failed) {
  console.error('\nThe inheritance rules appear to have changed upstream. Not writing.');
  process.exit(1);
}

const outPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'profile-optional.json');
const payload = `${JSON.stringify(optionalByFamily, null, 2)}\n`;

if (checkOnly) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (current !== payload) {
    console.error('\nsrc/profile-optional.json is out of date; re-run without --check');
    process.exit(1);
  }
  console.log('\nprofile-optional.json is up to date');
} else {
  fs.writeFileSync(outPath, payload);
  console.log(`\nwrote ${path.relative(process.cwd(), outPath)}`);
}
for (const [f, list] of Object.entries(optionalByFamily)) {
  console.log(`  ${f.padEnd(6)} ${String(list.length).padStart(2)} optional`);
}
