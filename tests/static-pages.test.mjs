/**
 * The static pages are what search engines and AI crawlers read in place of
 * the app (scripts/static-pages.mjs). They are generated on every build and
 * never reviewed by eye, so the failure that matters is silent: an extension
 * with no page, a page with nothing on it, or a sitemap that disagrees with
 * the pages it lists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStaticPages, loadInputs, pagePathFor, SITE_URL } from '../scripts/static-pages.mjs';

const inputs = loadInputs();
const { pages, sitemap, indexHtml } = buildStaticPages(inputs);
const extensions = Object.values(inputs.catalog).flat();
const byPath = new Map(pages.map((p) => [p.path, p.html]));

test('every catalogue extension gets exactly one page', () => {
  assert.equal(pages.length, extensions.length);
  assert.equal(byPath.size, pages.length, 'two extensions map to the same page path');
  for (const ext of extensions) {
    assert.ok(byPath.has(pagePathFor(ext.id)), `${ext.id} has no page`);
  }
});

test('extension ids are safe to use as URL path segments', () => {
  // The page path is the id lowercased. An id with a slash, a space or a glob
  // character (the catalogue once carried "Zilsm*") would make a broken URL.
  for (const ext of extensions) {
    assert.match(ext.id, /^[A-Za-z0-9]+$/, `${ext.id} cannot be used as a page path`);
  }
});

test('each page names its extension, describes it and links back to the app', () => {
  for (const ext of extensions) {
    const html = byPath.get(pagePathFor(ext.id));
    const url = `${SITE_URL}ext/${ext.id.toLowerCase()}/`;
    assert.match(html, /<title>[^<]+<\/title>/, `${ext.id}: no title`);
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), `${ext.id}: wrong canonical`);
    assert.match(html, /<meta name="description" content="[^"]+">/, `${ext.id}: empty description`);
    assert.ok(html.includes(`?ext=${encodeURIComponent(ext.id)}`), `${ext.id}: no link to the app`);
  }
});

test('instruction counts on a page match the catalogue', () => {
  for (const ext of extensions) {
    const n = Object.keys(ext.instructions ?? {}).length;
    const html = byPath.get(pagePathFor(ext.id));
    if (n) assert.ok(html.includes(`Instructions (${n})`), `${ext.id}: expected ${n} instructions`);
    else
      assert.ok(html.includes('No instruction encodings are listed'), `${ext.id}: no empty state`);
  }
});

test('catalogue text is escaped, not injected as markup', () => {
  const [group] = Object.keys(inputs.catalog);
  const hostile = {
    ...inputs,
    catalog: {
      [group]: [
        { id: 'Xtest', name: 'Xtest', short: '<b>x</b>', desc: 'a < b & "c"', instructions: {} },
      ],
    },
  };
  const html = buildStaticPages(hostile).pages[0].html;
  assert.ok(!html.includes('<b>x</b>'));
  assert.ok(html.includes('a &lt; b &amp; &quot;c&quot;'));
});

test('the sitemap lists the app and every page, and nothing else', () => {
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const expected = [SITE_URL, ...extensions.map((e) => `${SITE_URL}ext/${e.id.toLowerCase()}/`)];
  assert.deepEqual(locs.sort(), expected.sort());
});

test('the index placed in index.html links to every page', () => {
  for (const ext of extensions) {
    assert.ok(indexHtml.includes(`href="ext/${ext.id.toLowerCase()}/"`), `${ext.id} missing`);
  }
});
