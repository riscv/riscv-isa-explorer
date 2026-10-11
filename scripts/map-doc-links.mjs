#!/usr/bin/env node
/**
 * Points each catalog extension at its chapter on docs.riscv.org.
 *
 *   node scripts/map-doc-links.mjs            # rewrite src/riscv_extensions.json
 *   node scripts/map-doc-links.mjs --check    # report drift, write nothing
 *
 * Every entry used to carry the same link — the riscv-isa-manual repository
 * root — which told a reader nothing about the extension they had clicked.
 *
 * Three things about the site shape this, all learned the hard way:
 *
 * 1. The reference index is a library of specifications, not a list of
 *    extensions. Extensions live inside chapter pages of the unprivileged and
 *    privileged volumes.
 * 2. The unversioned chapter URLs are META-REFRESH stubs, ~400 bytes, that
 *    redirect to a dated snapshot. Fetching them gets you the stub, not the
 *    chapter, and matching against that finds nothing. Content must be read
 *    from the versioned path.
 * 3. The unversioned URL is nonetheless the right thing to LINK to, because it
 *    follows to whatever snapshot is current. Linking to the dated path would
 *    rot at the next release.
 *
 * Matching is deliberately conservative, in precedence order, because a wrong
 * link is worse than the generic one it replaces:
 *
 *   explicit  — single letters and bases. A heading "A Rationale" contains the
 *               word "a", so word-matching sends A to the wrong chapter. These
 *               are named by hand.
 *   filename  — the chapter is named for the extension (zfa.html -> Zfa).
 *   heading   — a heading names it (Zbb inside b-st-ext).
 *   anchor    — a section id names it (Zicbom inside cmo).
 *   body      — mentioned in the chapter text. Last resort, and only for names
 *               of three characters or more.
 *
 * Unprivileged chapters are searched first: an extension defined in Volume I
 * should not be attributed to a privileged chapter that merely mentions it.
 *
 * Extensions with no home in either volume fall back to the ratified profile
 * specifications, which docs.riscv.org publishes as their own components
 * (rva20-rvi20-rva22, rva23, rvb23). Those define the profile-named
 * extensions (Ziccrse, Za64rs, Sstvala, Shgatpa, ...) that the ISA volumes do
 * not have chapters for yet. Only a bold list term counts as a match: every
 * name in a profile page sits in such a list, and a body mention of an
 * extension there usually means "not in this profile". The profiles come after
 * the volumes, so an extension that gets its own chapter moves to it on the
 * next run.
 *
 * What is left keeps whatever URL it had: unratified drafts and extensions
 * documented in separate specifications. A handful of those separate specs
 * are mapped by hand below.
 */
import fs from 'node:fs';
import path from 'node:path';

const REF = 'https://docs.riscv.org/reference';
const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.join(here, '..');
const CATALOG = path.join(repoRoot, 'src', 'riscv_extensions.json');
const checkOnly = process.argv.includes('--check');

/** Names a word-match cannot be trusted with, plus the base ISAs. */
const EXPLICIT = {
  A: 'unpriv/a-st-ext', B: 'unpriv/b-st-ext', C: 'unpriv/c-st-ext', D: 'unpriv/d-st-ext',
  F: 'unpriv/f-st-ext', M: 'unpriv/m-st-ext', Q: 'unpriv/q-st-ext', V: 'unpriv/v-st-ext',
  H: 'priv/hypervisor', S: 'priv/supervisor', U: 'priv/machine',
  RV32I: 'unpriv/rv32', RV64I: 'unpriv/rv64', RV32E: 'unpriv/rv32e', RV64E: 'unpriv/rv32e',

  // Zvknhb is "Vector SHA-2 (full)" and lives in the vector-crypto chapter with
  // the rest of the Zvk family. Its id appears nowhere in the text the word
  // matcher scans, so without this it falls through to the colophon — which is
  // where it had been sending readers.
  Zvknhb: 'unpriv/vector-crypto',

  // Zk is the scalar-crypto umbrella — "shorthand for the following set of
  // other extensions", per the chapter that defines it. Its whole family
  // (Zkn, Zknd, Zkne, Zknh, Zkr, Zks, Zksed, Zksh, Zkt) already resolves to
  // that chapter, but the two-letter id is below the matcher's length floor,
  // so it fell through to the generic repo link despite being ratified and
  // carrying 51 instructions.
  Zk: 'unpriv/scalar-crypto',

  // Privileged-spec version tags. The profiles name them ("Ss1p13: Supervisor
  // architecture version 1.13") but no page defines them as extensions; the
  // privileged preface is where each version's changes are listed.
  Sm1p11: 'priv/priv-preface', Ss1p11: 'priv/priv-preface',
  Sm1p12: 'priv/priv-preface', Ss1p12: 'priv/priv-preface',
  Sm1p13: 'priv/priv-preface', Ss1p13: 'priv/priv-preface',
};

/**
 * Ratified profile pages, oldest first. The RVA22 page is the profile
 * specification's "New ISA Extensions" list, which defines the extensions it
 * introduces; RVA23 and RVB23 define theirs inline in the profile lists.
 */
const PROFILE_PAGES = [
  'rva20-rvi20-rva22/extensions',
  'rva23/rva23-profiles',
  'rvb23/rvb23',
];

/** Extensions whose home is a different ratified specification. */
const OTHER_SPECS = {
  Smaia: `${REF}/aia/index.html`,        Ssaia: `${REF}/aia/index.html`,
  Sdext: `${REF}/debug/index.html`,      Sdtrig: `${REF}/debug/index.html`,
  Sdtrigepm: `${REF}/debug/index.html`,  Sdtrigpend: `${REF}/debug/index.html`,
  Ssqosid: `${REF}/cbqri/index.html`,    RERI: `${REF}/ras-eri/index.html`,

  // SPMP is ratified but published only as a PDF attachment — there is no HTML
  // chapter for it. /isa/extensions/sspmp/ and its index.html are both 404s,
  // while the attachment resolves, so the attachment is the link.
  Sspmp: `${REF}/isa/extensions/sspmp/_attachments/riscv-spmp.pdf`,
  Sspmpen: `${REF}/isa/extensions/sspmp/_attachments/riscv-spmp.pdf`,
  Smpmpdeleg: `${REF}/isa/extensions/sspmp/_attachments/riscv-spmp.pdf`,

  // RV128 is not served by the unversioned snapshot at all — /isa/unpriv/rv128
  // is a 404, as are rv128i, rv-128 and quad — while the dated v20240411 path
  // resolves. It is an unfrozen draft ("We have not frozen the RV128 spec at
  // this time"), so its presence in the manual moves between releases. Pinned
  // here so the mapper stops proposing the colophon; tests/doc-links.test.mjs
  // carries the matching exemption. Remove both if a later snapshot serves it.
  RV128I: `${REF}/isa/v20240411/unpriv/rv128.html`,
};

const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
};

/** Chapter keys ("unpriv/zfa") linked from a volume index. */
async function readVolume(vol, version) {
  // The unversioned volume index is itself a redirect stub carrying a single
  // link, so the chapter list has to come from the snapshot, not the stub.
  // Reading it from the stub yields two chapters and a useless mapping.
  const index = await get(`${REF}/isa/${version}/${vol}/${vol}-index.html`);
  const chapters = new Set();
  for (const href of index.matchAll(/href="([^"]+\.html)"/g)) {
    const clean = href[1].split('#')[0];
    const m = clean.match(/(?:^|\/)(unpriv|priv)\/([a-z0-9][a-z0-9_.-]*)\.html$/);
    if (m) chapters.add(`${m[1]}/${m[2]}`);
    else if (!clean.includes('/')) chapters.add(`${vol}/${clean.slice(0, -5)}`);
  }
  return chapters;
}

async function build() {
  // The stub names the live snapshot; read it rather than hardcoding a date.
  const stub = await get(`${REF}/isa/unpriv/intro.html`);
  const version = stub.match(/v\d{8}/)?.[0];
  if (!version) throw new Error('could not determine the current snapshot from the redirect stub');
  const chapters = new Set([
    ...(await readVolume('unpriv', version)),
    ...(await readVolume('priv', version)),
  ]);

  const words = (s) => new Set(
    (s.replace(/<[^>]+>/g, ' ').match(/\b[A-Za-z][A-Za-z0-9]*\b/g) || []).map((w) => w.toLowerCase()),
  );

  const index = new Map();
  for (const key of chapters) {
    const [vol, ch] = key.split('/');
    let html;
    try {
      html = await get(`${REF}/isa/${version}/${vol}/${ch}.html`);
    } catch { continue; }              // a few index/colophon pages 404 under the snapshot
    const headings = [...html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g)].map((m) => m[1]).join(' ');
    index.set(key, {
      file: ch.toLowerCase(),
      anchors: new Set([...html.matchAll(/id="([A-Za-z][\w.-]*)"/g)].map((m) => m[1].toLowerCase())),
      headings: words(headings),
      body: words(html),
    });
  }

  // Volume I first — see the header note.
  const order = [...index.keys()].sort((a, b) =>
    (a.startsWith('unpriv/') ? 0 : 1) - (b.startsWith('unpriv/') ? 0 : 1) || a.localeCompare(b));

  return { version, index, order, url: (key) => `${REF}/isa/${key}.html`, profiles: await readProfiles() };
}

/**
 * Bold list terms on each profile page, as [page, Set<lowercased id>].
 * Like the ISA chapters, the unversioned profile URL is a redirect stub; the
 * content is read from the version it names and the stub is what gets linked.
 */
async function readProfiles() {
  const pages = [];
  for (const page of PROFILE_PAGES) {
    const [component, name] = page.split('/');
    const stub = await get(`${REF}/${page}.html`);
    const target = stub.match(/url=(v[\d.]+\/[\w.-]+\.html)/)?.[1];
    if (!target) throw new Error(`could not follow the redirect stub for ${page}`);
    const html = await get(`${REF}/${component}/${target}`);
    const terms = new Set(
      [...html.matchAll(/<li>\s*<p><strong>([A-Za-z][A-Za-z0-9]*)<\/strong>/g)].map((m) => m[1].toLowerCase()),
    );
    if (!terms.size) throw new Error(`no extension terms found on ${page}; has the page layout changed?`);
    pages.push([`${REF}/${component}/${name}.html`, terms]);
  }
  return pages;
}

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const entries = Object.values(catalog).flat().filter(Boolean);
const { version, index, order, url, profiles } = await build();

const resolve = (id) => {
  if (EXPLICIT[id]) return { url: url(EXPLICIT[id]), via: 'explicit' };
  if (OTHER_SPECS[id]) return { url: OTHER_SPECS[id], via: 'other-spec' };
  const low = id.toLowerCase();
  if (low.length < 3) return null;    // too short to word-match safely
  for (const [via, test] of [
    ['filename', (v) => v.file === low],
    ['heading',  (v) => v.headings.has(low)],
    ['anchor',   (v) => v.anchors.has(low)],
    ['body',     (v) => v.body.has(low)],
  ]) {
    const key = order.find((k) => test(index.get(k)));
    if (key) return { url: url(key), via };
  }
  const profile = profiles.find(([, terms]) => terms.has(low));
  if (profile) return { url: profile[0], via: 'profile' };
  return null;
};

const stats = {};
const changes = [];
let unmapped = 0;
for (const entry of entries) {
  const hit = resolve(entry.id);
  if (!hit) { unmapped++; continue; }
  stats[hit.via] = (stats[hit.via] ?? 0) + 1;
  if (entry.url !== hit.url) changes.push(`${entry.id}: ${entry.url} -> ${hit.url}`);
  entry.url = hit.url;
}

console.log(`snapshot read : ${version}  (${index.size} chapters)`);
console.log(`mapped        : ${entries.length - unmapped}/${entries.length}`, stats);
console.log(`unmapped      : ${unmapped} (keep their existing link)`);

if (checkOnly) {
  if (changes.length) {
    console.error(`\n${changes.length} link(s) differ from the catalog:`);
    changes.slice(0, 20).forEach((c) => console.error(`  ${c}`));
    process.exit(1);
  }
  console.log('no drift');
} else {
  fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`\nwrote ${changes.length} link(s) into src/riscv_extensions.json`);
}
