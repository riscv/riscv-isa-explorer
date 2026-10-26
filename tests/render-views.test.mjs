/**
 * Every view opens, and opens with its parts in place.
 *
 * render-smoke.test.mjs answers "did the page come up". This answers it for
 * each screen behind a click: the extension details panel, the instruction and
 * CSR details inside it, the Evolution dialog with both charts, the Encoding
 * Map, the Extension Sandbox, the About dialog and the builder. Several of them
 * are lazy-loaded chunks, which the smoke harness never loads (it evaluates
 * bundle.js alone), so until this file the Encoding Map, the builder and the
 * Evolution charts had never been rendered by any test.
 *
 * Same contract as the smoke test: the real built bundle in jsdom, shallow
 * assertions that the view rendered its key parts, and no console errors.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const mounted = [];

after(() => {
  for (const win of mounted) win.window.close();
});

/*
 * Mounts the bundle and serves its lazy chunks. webpack loads a chunk by
 * appending <script src="NNN.bundle.js"> to <head> and waiting for its load
 * event; jsdom fetches nothing here, so the append is intercepted, the file
 * read from dist/ and evaluated, and load fired, which is what a browser does.
 */
async function mount(url) {
  assert.ok(
    fs.existsSync(path.join(dist, 'bundle.js')),
    'dist/bundle.js is missing — run `npm run build` first',
  );
  const dom = new JSDOM(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url,
  });
  const { window } = dom;
  const errors = [];
  window.console.error = (...args) => errors.push(args.join(' '));
  window.Element.prototype.scrollIntoView = () => {};
  window.Element.prototype.scrollTo = () => {};
  window.matchMedia ??= () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  });
  const append = window.HTMLHeadElement.prototype.appendChild;
  window.HTMLHeadElement.prototype.appendChild = function appendChild(node) {
    const chunk = node?.tagName === 'SCRIPT' && node.src?.match(/([^/]+\.bundle\.js)$/)?.[1];
    if (!chunk) return append.call(this, node);
    window.eval(fs.readFileSync(path.join(dist, chunk), 'utf8'));
    setTimeout(() => node.onload?.({ type: 'load', target: node }), 0);
    return node;
  };
  window.eval(fs.readFileSync(path.join(dist, 'bundle.js'), 'utf8'));
  mounted.push(dom);
  await waitFor(() => window.document.querySelector('[id^="ext-"]'));
  // An ?ext= link focuses its tile on a short timer after mount. Let it land
  // first: on a slow runner it otherwise fires mid-test and takes the focus a
  // test is checking (CI caught exactly that).
  if (new URL(url).searchParams.has('ext')) {
    await waitFor(() => window.document.activeElement?.classList?.contains('ext-tile-primary'));
  }
  return { window, document: window.document, errors };
}

async function waitFor(find, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() - start > timeout) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const button = (root, text) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const byLabel = (root, label) => root.querySelector(`[aria-label="${label}"]`);
const noErrors = (errors) => assert.deepEqual(errors, [], `console errors:\n${errors.join('\n')}`);

test('the extension details panel shows the name, status, spec link and toolchain rows', async () => {
  const { document, errors } = await mount('https://example.test/?ext=Zvbb');
  const panel = await waitFor(() => document.querySelector('#detail-panel .riscv-spec-link'));
  assert.ok(panel, 'Read Online link missing');
  const detail = document.querySelector('#detail-panel');
  assert.match(detail.textContent, /Zvbb/);
  assert.match(detail.textContent, /Ratified/i);
  const heading = [...detail.querySelectorAll('h3')].find((h) =>
    /Toolchain support/i.test(h.textContent),
  );
  assert.ok(heading, 'toolchain section missing');
  const chips = [...heading.parentElement.querySelectorAll('span[title]')].map(
    (c) => c.textContent,
  );
  for (const tool of ['Clang', 'GCC', 'binutils', 'QEMU', 'Linux']) {
    assert.ok(
      chips.some((c) => c.startsWith(tool)),
      `${tool} chip missing: ${chips}`,
    );
  }
  noErrors(errors);
});

test('picking an instruction shows its details, references and encoding, and Close returns', async () => {
  const { document, errors } = await mount('https://example.test/?ext=F');
  const chip = await waitFor(() => button(document.querySelector('#detail-panel'), 'FCVT.L.S'));
  assert.ok(chip, 'FCVT.L.S chip missing');
  chip.click();
  const details = await waitFor(() =>
    document.querySelector('[aria-label^="Instruction details"]'),
  );
  assert.ok(details, 'instruction details did not open');
  assert.equal(document.activeElement, details, 'focus did not move to the details');
  const links = [...details.querySelectorAll('a')].map((a) => a.textContent.trim());
  for (const name of ['Sail', 'Spike']) assert.ok(links.includes(name), `${name} link missing`);
  assert.match(details.textContent, /Implementations and tests/);
  assert.match(details.textContent, /ACT/);
  assert.ok(details.querySelector('svg, [class*="encoding"], table'), 'encoding diagram missing');
  // Three titled sections, each a real heading, with jump links that move focus.
  const headings = [...details.querySelectorAll('section h4')].map((h) => h.textContent.trim());
  assert.deepEqual(headings, ['Write it', 'Encoding', 'Implementations and tests']);
  button(details.querySelector('nav'), 'Encoding').click();
  assert.equal(document.activeElement?.id, 'insn-encoding', 'the jump link did not move focus');
  button(details, 'Close').click();
  await waitFor(() => !document.querySelector('[aria-label^="Instruction details"]'));
  // Waited for, not read at once: on a slow runner the re-render that removes
  // the details can land after the click returns.
  await waitFor(() => document.activeElement?.textContent.trim() === 'F');
  assert.equal(
    document.activeElement?.textContent.trim(),
    'F',
    `focus did not return to the name; it is on ${document.activeElement?.outerHTML.slice(0, 160)}`,
  );
  noErrors(errors);
});

test('a CSR chip opens its details', async () => {
  const { document, errors } = await mount('https://example.test/?ext=F');
  const chip = await waitFor(() => button(document.querySelector('#detail-panel'), 'FCSR'));
  assert.ok(chip, 'FCSR chip missing');
  chip.click();
  const csr = await waitFor(
    () => byLabel(document, 'FCSR CSR details') || byLabel(document, 'fcsr CSR details'),
  );
  assert.ok(csr, 'CSR details did not open');
  noErrors(errors);
});

test('a CSR expands to a full-width dialog and Escape closes it', async () => {
  const { window, document, errors } = await mount('https://example.test/?ext=Sm');
  const chip = await waitFor(() => button(document.querySelector('#detail-panel'), 'MSTATUS'));
  assert.ok(chip, 'MSTATUS chip missing');
  chip.click();
  const expand = await waitFor(() => byLabel(document, 'Expand MSTATUS details to full view'));
  assert.ok(expand, 'Expand button missing');
  // The width chosen in the panel carries over to the expanded view.
  button(document.querySelector('[aria-label="mstatus CSR details"]'), 'RV32').click();
  expand.click();
  const dialog = await waitFor(() =>
    document.querySelector('[aria-labelledby="csr-expand-title"]'),
  );
  assert.ok(dialog, 'expanded dialog did not open');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(document.activeElement, dialog, 'focus did not move into the dialog');
  assert.match(document.getElementById('csr-expand-title').textContent, /MSTATUS/);
  assert.ok(dialog.querySelector('.riscv-csr-diagram'), 'register diagram missing');
  assert.equal(
    button(dialog, 'RV32').getAttribute('aria-pressed'),
    'true',
    'the expanded view lost the RV32 choice',
  );
  assert.equal(
    byLabel(dialog, 'Expand MSTATUS details to full view'),
    null,
    'the expanded view offers Expand again',
  );
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  await waitFor(() => !document.querySelector('[aria-labelledby="csr-expand-title"]'));
  assert.equal(document.querySelector('[aria-labelledby="csr-expand-title"]'), null);
  assert.ok(
    document.querySelector('[aria-label="mstatus CSR details"]'),
    'closing the dialog closed the CSR too',
  );
  noErrors(errors);
});

test('the Evolution dialog draws the ratification chart and the toolchain timeline', async () => {
  const { document, errors } = await mount('https://example.test/');
  button(document, 'Evolution').click();
  const timeline = await waitFor(() => document.querySelector('.riscv-tl'));
  assert.ok(document.querySelector('.riscv-evo__curve'), 'ratification chart missing');
  assert.ok(timeline, 'toolchain timeline missing');
  assert.equal(
    timeline.querySelectorAll('.riscv-tl__tool').length,
    5,
    'expected one line per tool',
  );
  assert.ok(timeline.querySelector('.riscv-tl__ref'), 'ratified reference line missing');
  noErrors(errors);
});

test('the Encoding Map opens', async () => {
  const { document, errors } = await mount('https://example.test/');
  byLabel(document, 'Encoding Map').click();
  const map = await waitFor(() => document.querySelector('[aria-labelledby="encoding-map-title"]'));
  assert.ok(map, 'Encoding Map dialog missing');
  assert.ok(map.textContent.length > 100, 'Encoding Map rendered nothing');
  noErrors(errors);
});

test('the Extension Sandbox opens', async () => {
  const { document, errors } = await mount('https://example.test/');
  byLabel(document, 'Extension Sandbox').click();
  const sandbox = await waitFor(() => document.querySelector('[aria-labelledby="sandbox-title"]'));
  assert.ok(sandbox, 'Sandbox dialog missing');
  noErrors(errors);
});

test('the About dialog opens', async () => {
  const { document, errors } = await mount('https://example.test/');
  button(document, 'About').click();
  const about = await waitFor(() => document.querySelector('[role="dialog"]'));
  assert.ok(about, 'About dialog missing');
  noErrors(errors);
});

test('the builder opens from a configuration link and shows what accepts the -march', async () => {
  const { document, errors } = await mount('https://example.test/?cfg=1;p:RVA23');
  // With nothing saved the link opens the builder directly; with a different
  // configuration saved, a banner asks first. A fresh jsdom has nothing saved.
  button(document, 'Open panel')?.click();
  const label = await waitFor(() =>
    [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === 'Accepted by'),
  );
  assert.ok(label, '"Accepted by" row missing');
  const chips = [...label.parentElement.querySelectorAll('span[title]')].map((c) => c.textContent);
  assert.equal(chips.length, 3, `expected Clang, GCC and binutils: ${chips}`);
  noErrors(errors);
});

test('the Ask AI launcher follows its feature flag', async () => {
  const { window, document } = await mount('https://example.test/');
  const flags = await import('../feature-flags.cjs');
  const launcher = () =>
    [...document.querySelectorAll('button')].find((b) => /Ask AI/i.test(b.textContent));
  if (!(flags.default ?? flags).AI_ASSISTANT_ENABLED) {
    assert.equal(launcher(), undefined);
    assert.equal(document.querySelector('script[src*="kapa"]'), null);
    return;
  }
  assert.ok(document.querySelector('script[src*="widget.kapa.ai"]'), 'kapa widget script missing');
  // jsdom never fetches the widget, so stand in for the method the launcher
  // waits for. It renders nothing until window.Kapa.open exists.
  const opened = [];
  window.Kapa = { open: (args) => opened.push(args) };
  const chip = await waitFor(launcher);
  assert.ok(chip, 'launcher did not render once kapa was ready');
  assert.ok(chip.querySelector('svg.ask-ai-btn__icon'), 'launcher glyph missing');
  chip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(opened.length, 1, 'Enter on the launcher did not open kapa');
});
