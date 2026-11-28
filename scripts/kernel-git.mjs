/*
 * What the upstream-history sync needs from the Linux kernel's history, read
 * from a local clone (#659): the commits that touched the kernel's extension
 * table, each commit's diff and trailers, and the first release tag that
 * contains a commit. No API and no rate limit: a blobless clone
 * (git clone --filter=blob:none) has the whole history and every tag, and
 * fetches file contents only for the diffs asked for, here two files.
 * tests/upstream-history.test.mjs runs these against a small repository it
 * builds.
 */
import { execFileSync } from 'node:child_process';
import { addedIds } from './upstream-history-lib.mjs';

/** The files that list extensions: riscv_isa_ext[] moved from cpu.c to cpufeature.c. */
export const TABLE_FILES = ['arch/riscv/kernel/cpufeature.c', 'arch/riscv/kernel/cpu.c'];

export function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A unified diff split into { filename, patch } per file, the shape addedIds() reads. */
export function splitDiff(diff) {
  return diff
    .split(/^diff --git /m)
    .slice(1)
    .map((chunk) => ({
      filename: (chunk.match(/^a\/(\S+) b\//) ?? [])[1] ?? '',
      patch: chunk.slice(chunk.indexOf('\n@@') + 1),
    }));
}

const SEP = '\u001f';

/**
 * One commit, in the shape the sync uses: { sha, commit: { message, author,
 * committer }, files, adds }. `adds` are the extensions (lower case) it adds
 * to the kernel's table.
 */
export function commitAt(repo, sha) {
  const head = git(repo, ['show', '-s', `--format=%H${SEP}%an${SEP}%cn${SEP}%cI${SEP}%B`, sha]);
  const [full, author, committer, date, ...message] = head.split(SEP);
  const files = splitDiff(git(repo, ['show', '--format=', '-p', sha, '--', ...TABLE_FILES]));
  return {
    sha: full.trim(),
    commit: {
      message: message.join(SEP).replace(/\n+$/, ''),
      author: { name: author },
      committer: { name: committer, date },
    },
    files,
    adds: addedIds(files),
  };
}

/** Every non-merge commit that touched the table since `since`, oldest first. */
export function tableCommits(repo, since = '2022-01-01') {
  const shas = git(repo, [
    'log',
    '--no-merges',
    '--reverse',
    '--format=%H',
    `--since=${since}`,
    '--',
    ...TABLE_FILES,
  ])
    .split('\n')
    .filter(Boolean);
  return shas.map((sha) => commitAt(repo, sha));
}

const RELEASE = /^v(\d+)\.(\d+)$/;
const byVersion = (a, b) => {
  const [, am, an] = a.match(RELEASE);
  const [, bm, bn] = b.match(RELEASE);
  return Number(am) - Number(bm) || Number(an) - Number(bn);
};

/** The first release (vX.Y, no -rc) that contains the commit, with its date; null if none yet. */
export function firstRelease(repo, sha) {
  const tags = git(repo, ['tag', '--contains', sha, '--list', 'v*'])
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => RELEASE.test(t))
    .sort(byVersion);
  if (!tags.length) return null;
  // In UTC, as the explorer's other release dates are: Linus tags in his own
  // time zone, and v6.6 was the evening of 2023-10-29 there, 2023-10-30 in UTC.
  const seconds = Number(
    git(repo, ['for-each-ref', '--format=%(creatordate:unix)', `refs/tags/${tags[0]}`]).trim(),
  );
  return { version: tags[0].slice(1), date: new Date(seconds * 1000).toISOString().slice(0, 10) };
}

/** The extensions a version of the table file lists (lower case). */
export const tableIds = (text) =>
  new Set([...text.matchAll(/__RISCV_ISA_EXT_\w+\(\s*(\w+)\s*,/g)].map((m) => m[1].toLowerCase()));

/**
 * What the kernel lists today: an extension added and later removed (P, J,
 * K and B left the table after 6.6) is not supported because it was once there.
 */
export function currentTable(repo, ref = 'HEAD') {
  return tableIds(git(repo, ['show', `${ref}:${TABLE_FILES[0]}`]));
}
