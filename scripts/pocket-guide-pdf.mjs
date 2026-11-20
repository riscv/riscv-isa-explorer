/**
 * Prints every pocket guide the build wrote (dist/pocket-guide/*.html,
 * scripts/pocket-guide.mjs) to a PDF of the same name, with headless Chrome.
 *
 * Run by the deploy job after `npm run build`, with the runner's Chrome; it
 * is not part of the build because a build must not need a browser. Locally:
 *
 *   npm run build && npm run guide:pdf
 *
 * Chrome is CHROME_BIN when set, else the first of google-chrome, chromium,
 * chromium-browser on PATH, else the macOS application. Exits non-zero when
 * there is no Chrome, no guide to print, or a PDF is missing or empty, so the
 * deploy never publishes a link to a file that is not there.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.argv[2] ?? join(here, '..', 'dist', 'pocket-guide'));

/* A real guide is tens of KB at least; anything smaller is a failed print. */
const MIN_BYTES = 10 * 1024;

const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return MAC_PATHS.find((p) => existsSync(p)) ?? null;
}

function fail(message) {
  console.error(`guide:pdf: ${message}`);
  process.exit(1);
}

const chrome = findChrome();
if (!chrome) {
  fail(
    'no Chrome found. Set CHROME_BIN, or install google-chrome or chromium. ' +
      'The PDFs are printed by the deploy job; nothing else needs them.',
  );
}
if (!existsSync(DIR)) fail(`${DIR} does not exist; run npm run build first.`);

const pages = readdirSync(DIR)
  .filter((f) => f.endsWith('.html'))
  .sort();
if (!pages.length) fail(`no .html guides in ${DIR}; run npm run build first.`);

// A throwaway profile, so a Chrome the user has open is neither reused nor touched.
const profile = mkdtempSync(join(tmpdir(), 'pocket-guide-chrome-'));
try {
  for (const page of pages) {
    const pdf = join(DIR, page.replace(/\.html$/, '.pdf'));
    rmSync(pdf, { force: true });
    const run = spawnSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdf}`,
        pathToFileURL(join(DIR, page)).href,
      ],
      { encoding: 'utf8', timeout: 180_000 },
    );
    if (run.error) fail(`${page}: ${run.error.message}`);
    if (!existsSync(pdf)) {
      fail(`${page}: Chrome wrote no PDF (exit ${run.status}).\n${run.stderr ?? ''}`);
    }
    const bytes = statSync(pdf).size;
    if (bytes < MIN_BYTES) fail(`${page}: ${pdf} is only ${bytes} bytes`);
    console.log(`${page.replace(/\.html$/, '.pdf')}: ${(bytes / 1024).toFixed(0)} KB`);
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}
