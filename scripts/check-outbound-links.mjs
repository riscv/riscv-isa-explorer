#!/usr/bin/env node
/*
 * Checks every outbound link the explorer shows (#635), and prints a markdown
 * report for the weekly workflow to keep in one issue.
 *
 *   node scripts/check-outbound-links.mjs            # check, print the report
 *   node scripts/check-outbound-links.mjs --list     # print the links, fetch nothing
 *
 * Where the links come from:
 *   - every string in src/*.json that is a URL: extension doc links, UDB
 *     source links, intrinsic documentation, citations;
 *   - the Sail, Spike and ACT links, built per instruction by referenceLinks()
 *     exactly as the details panel builds them;
 *   - each profile's specification (PROFILE_METADATA);
 *   - URL literals in src/*.js and src/*.jsx (repository and issue links).
 * Compiler Explorer links are left out: each one is generated from the
 * instruction and opens whatever state it carries, so there is nothing to find
 * missing.
 *
 * How they are checked:
 *   - A GitHub link pinned to a commit (/blob/<sha>/path) is looked up in that
 *     commit's tree: one API call per repository and commit instead of one
 *     request per file, which GitHub would rate-limit. A #L<n> anchor is
 *     checked against the file's line count.
 *   - Anything else is requested: HEAD, then GET when HEAD is refused, with a
 *     few retries. 404 and 410 are broken. Other failures (403, 429, 5xx,
 *     timeouts) are listed as unreachable: likely the host, not the link.
 *   - URL fragments other than #L<n> are not checked.
 *
 * Exit status: 0 nothing broken, 1 broken links, 2 the check itself failed.
 * Unreachable links alone do not fail it. Set GITHUB_TOKEN (or GH_TOKEN) for
 * the GitHub API; without one, its 60-requests-an-hour limit still covers a
 * run, barely.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const URL_RE = /^https?:\/\/[^\s"'<>]+$/;
const LITERAL_RE = /(['"`])(https?:\/\/[^'"`\s]+)\1/g;
// Compiler Explorer links are generated state (see above); the XML namespaces
// in the .xlsx writer are names, not pages; the rest are test and local hosts.
const SKIP_HOSTS = new Set([
  'godbolt.org',
  'schemas.openxmlformats.org',
  'www.w3.org',
  'example.test',
  'localhost',
]);
const PINNED_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)\/(?:blob|tree)\/([0-9a-f]{40})\/([^#?]+)(?:#L(\d+)(?:-L\d+)?)?$/;

/** Adds `where` to the list of places `url` appears. */
function note(links, url, where) {
  if (!URL_RE.test(url)) return;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (SKIP_HOSTS.has(host)) return;
  if (!links.has(url)) links.set(url, []);
  const places = links.get(url);
  if (places.length < 3 && !places.includes(where)) places.push(where);
}

/** Every URL string inside a parsed JSON value, with its path. */
function walkJson(value, where, visit) {
  if (typeof value === 'string') visit(value, where);
  else if (Array.isArray(value)) value.forEach((v, i) => walkJson(v, `${where}[${i}]`, visit));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) walkJson(v, `${where}.${k}`, visit);
}

/**
 * url -> up to three places it appears, from every source listed in the
 * header. `root` is the repository; tests point it at the real one.
 */
export async function collectLinks(root = ROOT) {
  const src = path.join(root, 'src');
  const links = new Map();
  for (const name of fs
    .readdirSync(src)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    if (name === 'package.json') continue;
    const data = JSON.parse(fs.readFileSync(path.join(src, name), 'utf8'));
    walkJson(data, name, (value, where) => note(links, value, where));
  }

  const { referenceLinks } = await import(pathToFileURL(path.join(src, 'instructionUsage.js')));
  const references = JSON.parse(
    fs.readFileSync(path.join(src, 'instruction-references.json'), 'utf8'),
  );
  for (const mnemonic of Object.keys(references.instructions ?? {}).sort()) {
    const built = referenceLinks(references, mnemonic);
    for (const model of ['sail', 'spike', 'act'])
      if (built[model].url) note(links, built[model].url, `${model} link for ${mnemonic}`);
  }

  const { PROFILE_METADATA } = await import(pathToFileURL(path.join(src, 'profiles.js')));
  for (const [name, meta] of Object.entries(PROFILE_METADATA))
    if (meta.specUrl) note(links, meta.specUrl, `profile ${name}`);

  for (const name of fs
    .readdirSync(src)
    .filter((f) => /\.jsx?$/.test(f))
    .sort()) {
    const text = fs.readFileSync(path.join(src, name), 'utf8');
    for (const match of text.matchAll(LITERAL_RE)) {
      // A template with an interpolation is built at run time; its pieces are
      // covered by the data it is built from.
      if (match[2].includes('${')) continue;
      note(links, match[2], name);
    }
  }
  return links;
}

/** { owner, repo, commit, path, line } for a commit-pinned GitHub link, else null. */
export function parsePinned(url) {
  const m = PINNED_RE.exec(url);
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2],
    commit: m[3],
    path: decodeURIComponent(m[4]),
    line: m[5] ? Number(m[5]) : null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(fetchImpl, url, options, { retries = 2, timeout = 20000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
        ...options,
      });
    } catch (error) {
      if (attempt >= retries)
        return { ok: false, status: 0, error: String(error?.message ?? error) };
      await sleep(500 * 2 ** attempt);
    }
  }
}

/** Status of one ordinary link: 'ok', 'broken' or 'unreachable', with the code. */
async function checkHttp(fetchImpl, url) {
  const headers = { 'user-agent': 'riscv-isa-explorer link check' };
  let res = await request(fetchImpl, url, { method: 'HEAD', headers });
  if (res.status === 405 || res.status === 403 || res.status === 501 || res.status === 0)
    res = await request(fetchImpl, url, { method: 'GET', headers });
  for (let attempt = 0; (res.status === 429 || res.status >= 500) && attempt < 2; attempt += 1) {
    await sleep(2000 * (attempt + 1));
    res = await request(fetchImpl, url, { method: 'GET', headers });
  }
  if (res.ok || (res.status >= 200 && res.status < 400)) return { status: 'ok', code: res.status };
  if (res.status === 404 || res.status === 410) return { status: 'broken', code: res.status };
  return { status: 'unreachable', code: res.status || res.error };
}

/**
 * Checks `links` (url -> places) and returns { ok, broken, unreachable }, the
 * last two as [{ url, code, places }]. `fetchImpl` is injected for the tests.
 */
export async function checkLinks(links, { fetchImpl = fetch, token, concurrency = 6 } = {}) {
  const result = { ok: 0, broken: [], unreachable: [] };
  const record = (url, outcome) => {
    if (outcome.status === 'ok') result.ok += 1;
    else result[outcome.status].push({ url, code: outcome.code, places: links.get(url) });
  };

  const pinned = new Map(); // owner/repo@commit -> [{url, path, line}]
  const plain = [];
  for (const url of links.keys()) {
    const p = parsePinned(url);
    if (!p) {
      plain.push(url);
      continue;
    }
    const key = `${p.owner}/${p.repo}@${p.commit}`;
    if (!pinned.has(key)) pinned.set(key, []);
    pinned.get(key).push({ url, ...p });
  }

  const api = {
    accept: 'application/vnd.github+json',
    'user-agent': 'riscv-isa-explorer link check',
  };
  if (token) api.authorization = `Bearer ${token}`;
  for (const [key, entries] of pinned) {
    const { owner, repo, commit } = entries[0];
    const res = await request(
      fetchImpl,
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`,
      { headers: api },
    );
    const tree = res.ok ? await res.json() : null;
    if (!tree || tree.truncated) {
      // No tree (an unknown commit is a 404 or 422) or too large to list:
      // fall back to asking for each file.
      for (const e of entries) {
        const outcome =
          res.status === 404 || res.status === 422
            ? { status: 'broken', code: `${key} not found` }
            : await checkHttp(
                fetchImpl,
                `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${e.path}`,
              );
        record(e.url, outcome);
      }
      continue;
    }
    const paths = new Set(tree.tree.map((item) => item.path));
    const lineCounts = new Map();
    for (const e of entries) {
      const bare = e.path.replace(/\/$/, '');
      if (!paths.has(bare)) {
        record(e.url, { status: 'broken', code: 'not in the tree' });
        continue;
      }
      if (e.line) {
        if (!lineCounts.has(bare)) {
          const raw = await request(
            fetchImpl,
            `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${bare}`,
            { headers: { 'user-agent': api['user-agent'] } },
          );
          lineCounts.set(bare, raw.ok ? (await raw.text()).split('\n').length : null);
        }
        const count = lineCounts.get(bare);
        if (count !== null && e.line > count) {
          record(e.url, { status: 'broken', code: `line ${e.line} of ${count}` });
          continue;
        }
      }
      record(e.url, { status: 'ok', code: 200 });
    }
  }

  // One request per page: links that differ only in their #fragment share it.
  const pages = new Map();
  let next = 0;
  const worker = async () => {
    while (next < plain.length) {
      const url = plain[next++];
      const page = url.split('#')[0];
      if (!pages.has(page)) pages.set(page, checkHttp(fetchImpl, page));
      record(url, await pages.get(page));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, plain.length) }, worker));
  result.broken.sort((a, b) => a.url.localeCompare(b.url));
  result.unreachable.sort((a, b) => a.url.localeCompare(b.url));
  return result;
}

/** The markdown report; its last line is `complete: true|false`. */
export function formatReport(links, result) {
  const lines = [];
  const pinnedCount = [...links.keys()].filter((u) => parsePinned(u)).length;
  lines.push(
    `Checked ${links.size} distinct links: ${pinnedCount} pinned to a GitHub commit, ${links.size - pinnedCount} fetched.`,
    '',
    `| Result | Links |`,
    `|---|---|`,
    `| OK | ${result.ok} |`,
    `| Broken | ${result.broken.length} |`,
    `| Unreachable (host error, likely transient) | ${result.unreachable.length} |`,
  );
  const table = (title, rows) => {
    if (!rows.length) return;
    lines.push('', `## ${title}`, '', '| Link | Result | Where |', '|---|---|---|');
    for (const r of rows) lines.push(`| ${r.url} | ${r.code} | ${r.places.join('; ')} |`);
  };
  table('Broken', result.broken);
  table('Unreachable', result.unreachable);
  lines.push('', `complete: ${result.broken.length === 0}`);
  return lines.join('\n');
}

async function main() {
  const links = await collectLinks();
  if (process.argv.includes('--list')) {
    for (const [url, places] of links) console.log(`${url}\t${places.join('; ')}`);
    return 0;
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const result = await checkLinks(links, { token });
  console.log(formatReport(links, result));
  return result.broken.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(2);
    },
  );
}

export { SRC };
