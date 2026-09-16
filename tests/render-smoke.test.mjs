/**
 * Does the app actually render?
 *
 * Nothing else here answers that. While hoisting the extension tile out of the
 * render body I rewrote 17 call sites with an indentation-sensitive match, hit
 * only 2 of them, and shipped a build where searchQuery was undefined and the
 * grid was blank. All 94 tests stayed green, because none of them render
 * anything. I found it by opening the page.
 *
 * This mounts the real built bundle in jsdom and asserts the page came up. It
 * runs against dist/, not src/, for two reasons: the bundle is plain JS so no
 * JSX transform is needed, and it tests the artefact that actually ships. CI
 * builds before it tests, so dist/ is present.
 *
 * Deliberately shallow. It is a smoke test, not a UI suite: it answers "did the
 * page render and did anything throw", which is exactly the class of failure
 * that slipped through.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const bundlePath = path.join(dist, 'bundle.js');

let dom;
const consoleErrors = [];

before(async () => {
  assert.ok(
    fs.existsSync(bundlePath),
    'dist/bundle.js is missing — run `npm run build` first (CI builds before testing)',
  );

  dom = new JSDOM(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,   // gives requestAnimationFrame, which React wants
    url: 'https://example.test/',
  });

  // Capture anything React complains about, so a render that "works" but throws
  // inside an effect still fails.
  dom.window.console.error = (...args) => consoleErrors.push(args.join(' '));

  // jsdom has no layout engine; the app scrolls and measures in places.
  dom.window.Element.prototype.scrollIntoView = () => {};
  dom.window.matchMedia ??= () => ({
    matches: false,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
  });

  dom.window.eval(fs.readFileSync(bundlePath, 'utf8'));

  // Let React flush its first commit.
  await new Promise((resolve) => setTimeout(resolve, 300));
});

test('the app mounts and puts something in #root', () => {
  const root = dom.window.document.getElementById('root');
  assert.ok(root, 'no #root element');
  assert.ok(root.children.length > 0, 'the app mounted nothing — the page is blank');
});

test('the extension grid renders every catalogue entry', () => {
  // The blank-grid bug left #root populated but the tiles missing, so counting
  // tiles is the assertion that would actually have caught it.
  const tiles = dom.window.document.querySelectorAll('.ext-tile');
  assert.ok(
    tiles.length > 200,
    `expected the full catalogue to render, found ${tiles.length} tiles`,
  );
});

test('the header, the counts and the builder control are present', () => {
  // Note the casing: the header labels are uppercased by CSS, so the DOM text
  // is "Extensions", not "EXTENSIONS". Assert the rendered text, not the styled
  // appearance.
  const text = dom.window.document.body.textContent;
  for (const expected of ['ISA Explorer', 'Extensions', 'ISA Configuration Builder']) {
    assert.ok(text.includes(expected), `page text is missing "${expected}"`);
  }

  // "RISC-V" is the wordmark rather than text, so it is not in textContent as
  // part of the title. Assert the accessible name instead: a screen reader
  // still announces "RISC-V ISA Explorer", and this catches the mark being
  // dropped or losing its label, which a text search never would.
  const marks = dom.window.document.querySelectorAll('svg[aria-label="RISC-V"]');
  assert.ok(marks.length >= 1, 'the RISC-V wordmark should be present with an accessible name');

  // The count comes from the catalogue, so this proves the data loaded rather
  // than merely that a shell painted.
  const tiles = dom.window.document.querySelectorAll('.ext-tile').length;
  assert.ok(
    text.includes(String(tiles)),
    `the header should report the ${tiles} extensions the grid rendered`,
  );
});

test('nothing threw during the first render', () => {
  // React reports render errors through console.error rather than by throwing,
  // so a silent failure would otherwise look like a pass.
  const real = consoleErrors.filter((line) => !/DevTools|deprecat|not wrapped in act/i.test(line));
  assert.deepEqual(real, [], `console errors during render:\n  ${real.join('\n  ')}`);
});

/**
 * A second mount, at a comparison permalink.
 *
 * Going in through the URL rather than through synthetic clicks tests the whole
 * chain — parse, resolve, build model, render — and matches how a shared
 * comparison actually arrives.
 *
 * These exist because the suite above cannot see the comparison feature at all:
 * nothing on the landing page mounts CompareView, so a component that throws on
 * render passes 179 tests. One did. CompareTray had its React import removed as
 * "unused" — correct for the automatic JSX runtime, wrong here, because
 * webpack.config.js uses @babel/preset-react with runtime: 'classic' and so
 * compiles JSX to React.createElement. Lint and build both stayed green; the
 * page only broke when a comparison opened.
 */
async function mountAt(url) {
  const win = new JSDOM(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url,
  });
  const errors = [];
  win.window.console.error = (...args) => errors.push(args.join(' '));
  win.window.Element.prototype.scrollIntoView = () => {};
  win.window.matchMedia ??= () => ({
    matches: false,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
  });
  win.window.eval(fs.readFileSync(bundlePath, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 400));
  mounted.push(win);
  return { dom: win, errors };
}

/*
 * Each mount leaves a live jsdom window behind, and anything the app scheduled
 * inside it keeps running. A component that polls on an interval therefore
 * holds the event loop open and this file hangs instead of finishing. Close
 * them once the suite is done so a timer cannot outlive the test that made it.
 */
const mounted = [];
after(() => {
  for (const win of mounted) win.window.close();
});

const compareDialog = (d) =>
  d.window.document.querySelector('[role="dialog"][aria-labelledby="compare-view-title"]');

const realErrors = (errors) =>
  errors.filter((line) => !/DevTools|deprecat|not wrapped in act/i.test(line));

test('an extension comparison permalink opens the comparison', async () => {
  const { dom: d, errors } = await mountAt('https://example.test/?cmp=e:Zba,Zbb');
  const dialog = compareDialog(d);
  assert.ok(dialog, 'the comparison did not open');

  // One attribute-column header plus one per item.
  const headers = dialog.querySelectorAll('.compare-head');
  assert.equal(headers.length, 3, `expected 3 header cells, found ${headers.length}`);
  assert.ok(dialog.textContent.includes('Zba'));
  assert.ok(dialog.textContent.includes('Zbb'));

  assert.deepEqual(realErrors(errors), [], 'console errors while rendering the comparison');
});

test('the tray appears with a comparison and stays hidden without one', async () => {
  const withPins = await mountAt('https://example.test/?cmp=e:Zba,Zbb');
  assert.ok(
    withPins.dom.window.document.querySelector('[aria-label="Comparison tray"]'),
    'the tray should be docked when items are pinned',
  );
  assert.equal(
    dom.window.document.querySelector('[aria-label="Comparison tray"]'),
    null,
    'the tray must not render when nothing is pinned',
  );
});

test('SLLI across RV32I and RV64I renders exactly one differing bit', async () => {
  // RV64 widens shamt by one bit, so bit 25 goes from a fixed 0 to part of a
  // variable field. Keyed by (extId, mnemonic) precisely because SLLI is
  // defined by five different base ISAs.
  const { dom: d } = await mountAt('https://example.test/?cmp=i:RV32I.SLLI,RV64I.SLLI');
  const dialog = compareDialog(d);
  assert.ok(dialog, 'the comparison did not open');

  // Two encodings are drawn, each marking the same single differing position.
  const marked = dialog.querySelectorAll('[data-diff="1"]');
  assert.equal(marked.length, 2, `expected one marked bit per column, found ${marked.length}`);
  for (const cell of marked) {
    // Native title, not data-tooltip: the diagram renders inside overflow-hidden
    // containers, where a ::after tooltip is clipped at the edges.
    assert.ok(
      cell.getAttribute('title').startsWith('bit[25]'),
      `marked the wrong bit: ${cell.getAttribute('title')}`,
    );
    assert.ok(
      cell.getAttribute('title').endsWith('differs'),
      'a marked bit should say that it differs',
    );
    assert.equal(
      cell.getAttribute('data-tooltip'),
      null,
      'bit cells must not carry both tooltips, or the reader gets two',
    );
  }
});

test('a comparison permalink naming nothing real does not open a comparison', async () => {
  const { dom: d, errors } = await mountAt('https://example.test/?cmp=e:Zqqq,Zwww');
  assert.equal(compareDialog(d), null, 'opened a comparison with no resolvable items');
  assert.ok(
    d.window.document.getElementById('root').children.length > 0,
    'the page should still render',
  );
  assert.deepEqual(realErrors(errors), [], 'console errors on an unresolvable comparison');
});

test('a malformed comparison permalink does not break the page', async () => {
  for (const bad of ['?cmp=', '?cmp=x:Zba', '?cmp=:::', '?cmp=i:...']) {
    const { dom: d, errors } = await mountAt(`https://example.test/${bad}`);
    assert.ok(
      d.window.document.getElementById('root').children.length > 0,
      `the page went blank on ${bad}`,
    );
    assert.deepEqual(realErrors(errors), [], `console errors on ${bad}`);
  }
});

/**
 * Every other comparison test above arrives via a `?cmp=` URL, so nothing
 * ever exercises the click path: toggleCompareExt, removeCompareItem, the
 * tray's Compare button, or the auto-close effect when pins drop below two.
 * This drives it with real DOM events dispatched the way React's delegated
 * listeners expect, against a mount at the plain URL.
 */
test('clicking pins, opening Compare, and unpinning drives the whole tray/dialog flow', async () => {
  const { dom: d, errors } = await mountAt('https://example.test/');
  const doc = d.window.document;

  const click = (el) => {
    el.dispatchEvent(new d.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

  // 0. Switch compare mode on — the pins do not exist until it is.
  const modeToggle = doc.querySelector('.compare-mode-toggle');
  assert.ok(modeToggle, 'no compare mode toggle in the toolbar');
  assert.equal(modeToggle.getAttribute('aria-pressed'), 'false', 'mode should start off');
  assert.equal(
    doc.querySelectorAll('.ext-tile-compare').length,
    0,
    'pins must not render before the mode is on',
  );
  click(modeToggle);
  await tick();
  assert.equal(modeToggle.getAttribute('aria-pressed'), 'true', 'mode did not switch on');

  // 1. Pin two different extension tiles.
  const pins = doc.querySelectorAll('.ext-tile-compare');
  assert.ok(pins.length >= 2, `need at least 2 compare pins to drive this test, found ${pins.length}`);
  click(pins[0]);
  await tick();
  click(pins[1]);
  await tick();

  // 2. The tray appears and its Compare button is enabled.
  const tray = doc.querySelector('[aria-label="Comparison tray"]');
  assert.ok(tray, 'the tray did not appear after pinning two tiles');
  const findCompareButton = () =>
    [...doc.querySelectorAll('[aria-label="Comparison tray"] button')].find((b) =>
      b.textContent.trim().startsWith('Compare ('),
    );
  const compareBtn = findCompareButton();
  assert.ok(compareBtn, 'no Compare button found in the tray');
  assert.equal(compareBtn.disabled, false, 'Compare button should be enabled with two pins');

  // 3. Click Compare; the dialog opens.
  click(compareBtn);
  await tick();
  const dialog = compareDialog(d);
  assert.ok(dialog, 'clicking Compare did not open the dialog');

  // 4. The URL gained a cmp parameter.
  const url = new d.window.URL(d.window.location.href);
  assert.ok(url.searchParams.get('cmp'), 'the URL should have gained a cmp parameter');

  // 5. Close the dialog, remove one pin via its tray chip, Compare disables again.
  const closeBtn = dialog.querySelector('[aria-label="Close comparison"]');
  assert.ok(closeBtn, 'no close button found on the dialog');
  click(closeBtn);
  await tick();
  assert.equal(compareDialog(d), null, 'the dialog should have closed');

  const removeBtn = doc.querySelector('[aria-label="Comparison tray"] button[aria-label^="Remove "]');
  assert.ok(removeBtn, 'no remove button found on a tray chip');
  click(removeBtn);
  await tick();

  const compareBtnAfter = findCompareButton();
  assert.ok(compareBtnAfter, 'Compare button missing from the tray after removing a pin');
  assert.equal(
    compareBtnAfter.disabled,
    true,
    'Compare button should be disabled again with fewer than two pins',
  );

  assert.deepEqual(realErrors(errors), [], 'console errors while driving the pin/compare/remove flow');
});

test('compare mode is off by default, so no pins clutter the grid', () => {
  const tiles = dom.window.document.querySelectorAll('.ext-tile').length;
  assert.ok(tiles > 200, 'expected the catalogue to render');
  assert.equal(
    dom.window.document.querySelectorAll('.ext-tile-compare').length,
    0,
    'pins must stay hidden until compare mode is switched on',
  );
  assert.ok(
    dom.window.document.querySelector('.compare-mode-toggle'),
    'the compare mode toggle should be in the toolbar',
  );
});

test('with compare mode off, no pin of any kind is reachable', async () => {
  // Counting tile pins alone was not enough: the instruction-chip pin was
  // rendered regardless of the mode, so a reader could pin an instruction,
  // watch ?cmp=i:… appear in the URL, and have no tray to open it with. A
  // control that half-works is worse than one that is absent.
  const { dom: d, errors } = await mountAt('https://example.test/?ext=Zba');
  const doc = d.window.document;

  assert.equal(doc.querySelectorAll('.ext-tile-compare').length, 0, 'tile pins should be hidden');
  assert.equal(
    doc.querySelector('[aria-label="Comparison tray"]'),
    null,
    'the tray should be hidden',
  );

  // The detail panel is open for Zba, so its instruction chips are on screen.
  const chips = [...doc.querySelectorAll('button')].filter((b) =>
    /^Compare |^Remove .* from comparison$/.test(b.getAttribute('title') || ''),
  );
  assert.deepEqual(
    chips.map((b) => b.getAttribute('title')),
    [],
    'no instruction or profile pin may be reachable while compare mode is off',
  );

  assert.deepEqual(realErrors(errors), [], 'console errors with compare mode off');
});

test('switching compare mode off hides the pins and tray but keeps the comparison', async () => {
  // The promise the mode makes: turning it off is never destructive. The pins
  // and the ?cmp= URL survive, so switching back on restores the same
  // comparison rather than making the user rebuild it.
  const { dom: d, errors } = await mountAt('https://example.test/');
  const doc = d.window.document;
  const click = (el) =>
    el.dispatchEvent(new d.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

  const modeToggle = doc.querySelector('.compare-mode-toggle');
  click(modeToggle);
  await tick();

  const pins = doc.querySelectorAll('.ext-tile-compare');
  click(pins[0]);
  await tick();
  click(pins[1]);
  await tick();

  const pinnedUrl = d.window.location.search;
  assert.ok(pinnedUrl.includes('cmp='), `expected a cmp param, got ${pinnedUrl}`);
  assert.ok(doc.querySelector('[aria-label="Comparison tray"]'), 'tray should be docked');

  // Off: affordances gone, comparison retained.
  click(modeToggle);
  await tick();
  assert.equal(doc.querySelectorAll('.ext-tile-compare').length, 0, 'pins should be hidden');
  assert.equal(doc.querySelector('[aria-label="Comparison tray"]'), null, 'tray should be hidden');
  assert.equal(d.window.location.search, pinnedUrl, 'the comparison must survive in the URL');

  // On again: the same two pins are still there.
  click(modeToggle);
  await tick();
  const tray = doc.querySelector('[aria-label="Comparison tray"]');
  assert.ok(tray, 'tray should come back');
  const compareBtn = [...tray.querySelectorAll('button')].find((b) =>
    b.textContent.trim().startsWith('Compare ('),
  );
  assert.ok(compareBtn.textContent.includes('(2)'), `expected 2 pins retained: ${compareBtn.textContent}`);

  assert.deepEqual(realErrors(errors), [], 'console errors while toggling compare mode');
});

test('a profile comparison permalink opens a membership matrix', async () => {
  const { dom: d, errors } = await mountAt('https://example.test/?cmp=p:RVA20,RVA22');
  const dialog = compareDialog(d);
  assert.ok(dialog, 'the profile comparison did not open');

  // One attribute-column header plus one per profile.
  assert.equal(dialog.querySelectorAll('.compare-head').length, 3);
  assert.ok(dialog.textContent.includes('RVA20'));
  assert.ok(dialog.textContent.includes('RVA22'));
  assert.ok(
    dialog.textContent.includes('as listed in the specification'),
    'the view should say which dependency mode it is in',
  );

  // Presence renders as marks, never as the words true/false.
  assert.ok(!/\btrue\b|\bfalse\b/.test(dialog.textContent), 'a boolean leaked into the matrix');
  assert.ok(dialog.querySelector('[aria-label="present"]'), 'expected at least one present mark');

  assert.deepEqual(realErrors(errors), [], 'console errors rendering a profile comparison');
});

test('the header is an identity row plus one full-width toolbar', () => {
  // The header's shape is load-bearing, not decoration. Every clipping bug it
  // had came from packing its controls into a right-hand column narrower than
  // they needed, inside an overflow-x-hidden root that cuts rather than
  // scrolls. A single full-width toolbar wraps instead.
  const toolbar = dom.window.document.querySelector('.riscv-toolbar');
  assert.ok(toolbar, 'no header toolbar');
  assert.equal(toolbar.children.length, 2, 'toolbar should hold a filters group and an actions group');

  const [filters, actions] = [...toolbar.children].map((g) =>
    [...g.querySelectorAll('button')].map((b) => b.textContent.trim()),
  );
  for (const profile of ['RVA20', 'RVA22', 'RVA23', 'RVB23']) {
    assert.ok(filters.some((t) => t === profile), `${profile} missing from the filters group`);
  }
  for (const action of ['Encoder Validator', 'Encoding Map']) {
    assert.ok(actions.some((t) => t.startsWith(action)), `${action} missing from the actions group`);
  }
  assert.ok(
    actions.some((t) => t.startsWith('Compare')),
    'the Compare mode toggle should live in the actions group',
  );
});

test('the page declares itself a tech preview and offers somewhere to report', () => {
  // Both are promises to the reader, not decoration: the caveat says the data
  // is not the ratified reference, and the link is where findings go. A silent
  // regression in either is worse than a visual one.
  const doc = dom.window.document;
  const tag = doc.querySelector('.riscv-preview-sup');
  assert.ok(tag, 'no Tech Preview mark in the header');
  assert.equal(tag.textContent.trim(), 'Tech Preview');
  assert.equal(tag.tagName, 'SUP', 'the caveat should ride the title as an exponent');
  assert.ok(
    doc.querySelector('h1').contains(tag),
    'it must live inside the h1 so it tracks the title at any size',
  );

  const link = doc.querySelector('a[href="https://github.com/riscv/riscv-isa-explorer/issues"]');
  assert.ok(link, 'no link to the issue tracker');
  assert.equal(link.target, '_blank', 'the issue tracker should open in a new tab');
  assert.match(link.rel, /noreferrer/, 'external link needs rel=noreferrer');
  assert.match(link.rel, /noopener/, 'external link needs rel=noopener');
});
