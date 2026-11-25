// scripts/check-outbound-links.mjs: collects every outbound link and checks it
// (#635). These run offline: the collection on the real data, the checking
// against a fake fetch. The weekly workflow does the real fetching.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLinks,
  collectLinks,
  formatReport,
  parsePinned,
} from '../scripts/check-outbound-links.mjs';

const links = await collectLinks();
const urls = [...links.keys()];

test('every source of links is collected', () => {
  const from = (re) => urls.filter((u) => re.test(u)).length;
  const sources = {
    'UDB source links': from(/github\.com\/riscv\/riscv-unified-db\/blob\/[0-9a-f]{40}\//),
    'Sail links': from(/github\.com\/riscv\/sail-riscv\/blob\//),
    'Spike links': from(/github\.com\/riscv-software-src\/riscv-isa-sim\/blob\//),
    'ACT links': from(/github\.com\/riscv\/riscv-arch-test\/blob\//),
    'intrinsic docs': from(/github\.com\/riscv-non-isa\/rvv-intrinsic-doc\/blob\//),
    'docs.riscv.org pages': from(/^https:\/\/docs\.riscv\.org\//),
  };
  const floors = {
    'UDB source links': 1000,
    'Sail links': 500,
    'Spike links': 500,
    'ACT links': 300,
    'intrinsic docs': 50,
    'docs.riscv.org pages': 30,
  };
  for (const [name, count] of Object.entries(sources))
    assert.ok(count >= floors[name], `${name}: ${count}, expected at least ${floors[name]}`);
  assert.ok(
    [...links.values()].some((places) => places.some((p) => p.startsWith('profile '))),
    'the profile specifications are collected',
  );
  assert.ok(
    links.has('https://github.com/riscv/riscv-opcodes'),
    'URL literals in the source are collected',
  );
});

test('generated and non-page URLs are left out, and every link says where it is used', () => {
  for (const url of urls) {
    assert.match(url, /^https?:\/\//);
    assert.doesNotMatch(url, /godbolt\.org|schemas\.openxmlformats\.org|\$\{/, url);
    assert.ok(links.get(url).length >= 1, `${url} has no place`);
  }
});

test('commit-pinned GitHub links are parsed, with their line anchor', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(parsePinned(`https://github.com/o/r/blob/${sha}/model/x.sail#L12`), {
    owner: 'o',
    repo: 'r',
    commit: sha,
    path: 'model/x.sail',
    line: 12,
  });
  assert.equal(parsePinned(`https://github.com/o/r/blob/${sha}/a%20b.adoc`).path, 'a b.adoc');
  assert.equal(parsePinned('https://github.com/o/r/blob/main/x.adoc'), null, 'a branch is fetched');
  assert.equal(parsePinned('https://docs.riscv.org/x.html'), null);
});

/** A fetch that answers from `routes` (url -> status, or {status, json, text}). */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${url}`);
    const route = routes[url] ?? 404;
    const r = typeof route === 'number' ? { status: route } : route;
    if (r.throws) throw new Error(r.throws);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
      text: async () => r.text ?? '',
    };
  };
  return { impl, calls };
}

test('pinned links are looked up in the tree, once per repository and commit', async () => {
  const sha = 'b'.repeat(40);
  const base = `https://github.com/o/r/blob/${sha}`;
  const input = new Map([
    [`${base}/present.adoc`, ['a']],
    [`${base}/gone.adoc`, ['b']],
    [`${base}/model/x.sail#L3`, ['c']],
    [`${base}/model/x.sail#L99`, ['d']],
  ]);
  const { impl, calls } = fakeFetch({
    [`https://api.github.com/repos/o/r/git/trees/${sha}?recursive=1`]: {
      status: 200,
      json: { truncated: false, tree: [{ path: 'present.adoc' }, { path: 'model/x.sail' }] },
    },
    [`https://raw.githubusercontent.com/o/r/${sha}/model/x.sail`]: {
      status: 200,
      text: '1\n2\n3\n4',
    },
  });
  const result = await checkLinks(input, { fetchImpl: impl });
  assert.equal(result.ok, 2);
  assert.deepEqual(
    result.broken.map((b) => [b.url.replace(base, ''), b.code]),
    [
      ['/gone.adoc', 'not in the tree'],
      ['/model/x.sail#L99', 'line 99 of 4'],
    ],
  );
  assert.equal(calls.filter((c) => c.includes('/git/trees/')).length, 1, 'one tree call');
  assert.equal(calls.filter((c) => c.includes('raw.githubusercontent')).length, 1, 'one raw fetch');
});

test('other links: 404 is broken, a refused HEAD retries as GET, host errors are unreachable', async () => {
  const input = new Map(
    [
      'https://h/ok',
      'https://h/gone',
      'https://h/nohead',
      'https://h/down',
      'https://h/ok#frag',
    ].map((u) => [u, ['x']]),
  );
  const routes = {
    'https://h/ok': 200,
    'https://h/gone': 404,
    'https://h/down': { throws: 'ECONNRESET' },
  };
  const { impl, calls } = fakeFetch(routes);
  const noHead = async (url, options = {}) =>
    url === 'https://h/nohead'
      ? { ok: options.method !== 'HEAD', status: options.method === 'HEAD' ? 405 : 200 }
      : impl(url, options);
  const result = await checkLinks(input, { fetchImpl: noHead, concurrency: 1 });
  assert.equal(result.ok, 3, 'ok, the fragment of ok, and nohead via GET');
  assert.deepEqual(
    result.broken.map((b) => b.url),
    ['https://h/gone'],
  );
  assert.deepEqual(
    result.unreachable.map((b) => b.url),
    ['https://h/down'],
  );
  assert.equal(calls.filter((c) => c.endsWith('https://h/ok')).length, 1, 'one request per page');
});

test('the report counts every outcome and ends with the result line', () => {
  const input = new Map([
    ['https://h/a', ['x']],
    ['https://h/b', ['y']],
  ]);
  const report = formatReport(input, {
    ok: 1,
    broken: [{ url: 'https://h/b', code: 404, places: ['y'] }],
    unreachable: [],
  });
  assert.match(report, /\| Broken \| 1 \|/);
  assert.match(report, /\| https:\/\/h\/b \| 404 \| y \|/);
  assert.match(report, /\ncomplete: false$/);
  assert.match(formatReport(input, { ok: 2, broken: [], unreachable: [] }), /\ncomplete: true$/);
});
