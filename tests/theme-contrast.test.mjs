// Contrast in all three themes (dark, dusk, light), computed from the tokens in
// src/index.css. The category borders measured 1.2:1 in every theme before
// they became per-theme tokens; this keeps them, the section titles, the
// tile's small text and its + button above the WCAG floors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Comments go first: several token blocks explain themselves in prose that
// mentions braces.
const css = fs
  .readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const src = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// Every `selector { --name: value; }` block whose selector is exactly one of
// these, merged in file order: dark is the default (:root), and dusk and light
// override it.
function tokens(theme) {
  const selectors = theme === 'dark' ? [':root'] : [':root', `:root[data-theme='${theme}']`];
  const out = {};
  for (const m of css.matchAll(/(^|\n)([^{}\n][^{}]*?)\s*\{([^{}]*)\}/g)) {
    const sel = m[2].trim();
    const rank = selectors.indexOf(sel);
    if (rank < 0) continue;
    for (const d of m[3].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      // Later blocks of the same rank, and higher ranks, win.
      if (out[d[1]] && out[d[1]].rank > rank) continue;
      out[d[1]] = { rank, value: d[2].trim() };
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.value]));
}

const rgb = (v) => {
  const h = v.match(/^#([0-9a-f]{6})$/i);
  if (h) return [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16));
  const r = v.match(/^rgba?\(([^)]+)\)$/);
  if (r) return r[1].split(',').map((x) => parseFloat(x));
  throw new Error(`not a colour: ${v}`);
};
const over = (fg, bg) => {
  const a = fg[3] ?? 1;
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
};
const lin = (c) => {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const THEMES = ['dark', 'dusk', 'light'];
const HUES = [
  'blue',
  'emerald',
  'purple',
  'amber',
  'indigo',
  'pink',
  'sky',
  'fuchsia',
  'teal',
  'red',
  'violet',
  'orange',
  'cyan',
];
const SECTIONS = [
  'blue',
  'emerald',
  'violet',
  'amber',
  'indigo',
  'pink',
  'sky',
  'fuchsia',
  'teal',
  'red',
  'slate',
  'lavender',
  'orange',
  'peach',
  'cyan',
];

for (const theme of THEMES) {
  const t = tokens(theme);
  const c = (name) => {
    assert.ok(t[name], `${theme}: ${name} is defined`);
    return rgb(t[name]);
  };
  const page = c('--riscv-bg');
  const surfaces = [c('--riscv-surface'), c('--riscv-surface-2')];
  const tileBgs = HUES.map((h) => over(c(`--tile-${h}-bg`), page));

  test(`${theme}: every category edge clears 3:1 against the page and its tile`, () => {
    for (const h of HUES) {
      const edge = c(`--tile-${h}-edge`);
      const bg = over(c(`--tile-${h}-bg`), page);
      assert.ok(contrast(edge, page) >= 3, `${h} edge on page: ${contrast(edge, page).toFixed(2)}`);
      assert.ok(contrast(edge, bg) >= 3, `${h} edge on tile: ${contrast(edge, bg).toFixed(2)}`);
    }
    const n = c('--tile-neutral-edge');
    for (const s of [page, ...surfaces]) assert.ok(contrast(n, s) >= 3, 'neutral edge');
  });

  test(`${theme}: section titles clear 4.5:1 on the page`, () => {
    for (const s of SECTIONS) {
      const v = contrast(c(`--section-${s}`), page);
      assert.ok(v >= 4.5, `${s}: ${v.toFixed(2)}`);
    }
  });

  test(`${theme}: a tile's small text and its + button stay readable on every tile`, () => {
    const text3 = c('--riscv-text-3');
    for (const bg of [...tileBgs, ...surfaces]) {
      assert.ok(contrast(text3, bg) >= 4.5, `text-3: ${contrast(text3, bg).toFixed(2)}`);
      assert.ok(contrast(c('--tile-add'), bg) >= 3, `+ icon: ${contrast(c('--tile-add'), bg)}`);
    }
    const edge = over(c('--tile-add-edge'), tileBgs[0]);
    if (theme === 'light') assert.ok(contrast(edge, tileBgs[0]) >= 3, '+ edge on light');
    const wash = over([255, 77, 107, 0.12], surfaces[0]);
    assert.ok(contrast(c('--tile-eol'), wash) >= 4.5, 'EOL badge');
  });

  test(`${theme}: accents used as text clear 4.5:1 on the page and surfaces`, () => {
    const accents = [
      '--riscv-violet',
      '--riscv-success',
      '--riscv-danger',
      '--riscv-gold',
      '--riscv-info',
      '--riscv-warn',
      '--riscv-check',
      '--riscv-gold-locked',
    ];
    const low = [];
    for (const a of accents) {
      for (const bg of [page, ...surfaces]) {
        const v = contrast(over(c(a), bg), bg);
        if (v < 4.5) low.push(`${a} ${v.toFixed(2)}`);
      }
    }
    assert.deepEqual(low, []);
  });

  test(`${theme}: body text clears 7:1 and secondary text 4.5:1`, () => {
    for (const bg of [page, ...surfaces]) {
      assert.ok(contrast(c('--riscv-text'), bg) >= 7, `text: ${contrast(c('--riscv-text'), bg)}`);
      assert.ok(contrast(c('--riscv-text-2'), bg) >= 4.5, 'text-2');
    }
  });
}

test('the components read the per-theme tokens, not fixed colours', () => {
  const tile = src('src/ExtensionTile.jsx');
  assert.match(tile, /data-hue=/, 'tiles carry their category');
  assert.match(tile, /var\(--tile-add\)/);
  assert.match(tile, /var\(--tile-eol\)/);
  const view = src('src/risc_v_visualizer.jsx');
  assert.equal(
    (view.match(/var\(--section-[a-z]+\)/g) ?? []).length,
    30,
    'title and icon per section',
  );
  assert.match(view, /const THEMES = \['dark', 'dusk', 'light'\]/);
  assert.match(
    src('public/index.html'),
    /data-color-scheme-selector="\[data-theme='dark'\], \[data-theme='dusk'\]"/,
  );
});
