/*
 * The upstream-history dialog's logic (#649), kept out of the .jsx so the
 * tests can import it: which extensions it opens for, what Previous and Next
 * walk, the timeline's order, and the Progression chart's axis and labels.
 * The data is src/upstream-history-index.json (in the bundle) and
 * src/upstream-history.json (loaded when a dialog opens), both written by
 * scripts/sync_upstream_history.mjs.
 */

/** An extension has a history to open: collected, or a bundle whose parts were. */
export const hasHistory = (index, id) => Boolean(index[id]) && !index[id].listed;

/**
 * The set Previous and Next walk: a bundle's parts after its own overview, or
 * the extensions that landed in one commit. Null for an extension on its own.
 */
export function groupFor(index, root, current) {
  const parts = index[root]?.parts;
  if (parts) return { label: `${root} parts`, items: [root, ...parts] };
  const together = index[current]?.landedWith ?? [];
  if (!together.length) return null;
  return { label: 'Landed together', items: [current, ...together].sort() };
}

const DAY = 864e5;
export const day = (s) => Date.parse(`${s}T00:00:00Z`);
export const month = (s) => s.slice(0, 7);

/** "2y 03m", "5m" or "18 days" between two ISO dates. */
export function span(from, to) {
  const days = Math.round((day(to) - day(from)) / DAY);
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30.42);
  if (!years && !months) return `${days} days`;
  return years ? `${years}y ${String(months).padStart(2, '0')}m` : `${months}m`;
}

/**
 * The release that completes a bundle: its last part's. Null while any part's
 * release is unknown, since the bundle is only available once all of them are.
 */
export function bundleRelease(index, parts) {
  const releases = parts.map((p) => index[p]?.release);
  if (!releases.length || releases.some((r) => !r)) return null;
  return releases.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
}

/** Earlier attempts, each version, applied and released, oldest first. */
export function timelineItems(series) {
  const items = [
    ...series.earlier.map((e) => ({
      kind: 'earlier',
      date: e.date,
      text: e.title,
      sub: `${e.authors.join(', ')}${e.postings > 1 ? `, ${e.postings} postings` : ''}`,
    })),
    ...series.versions.map((v) => ({
      kind: 'landed',
      date: v.date,
      text: v.version,
      sub: `${v.author}${v.resends ? `, resent ${v.resends}×` : ''}`,
      href: v.href,
    })),
    {
      kind: 'applied',
      date: series.commit.applied,
      text: `Applied by ${series.commit.committer}`,
      sub: series.commit.sha,
    },
    {
      kind: 'release',
      date: series.release.date,
      text: `Released in Linux ${series.release.version}`,
    },
  ];
  // Stable: on one day, an attempt before a version before applied before released.
  const rank = { earlier: 0, landed: 1, applied: 2, release: 3 };
  return items
    .map((it, i) => ({ it, i }))
    .sort(
      (a, b) =>
        a.it.date.localeCompare(b.it.date) || rank[a.it.kind] - rank[b.it.kind] || a.i - b.i,
    )
    .map(({ it }) => it);
}

/**
 * The Progression chart's time axis: it fits the data with a little room
 * either side, draws year lines, quarter lines under four years and quarter
 * names under eighteen months, and the first label always names its year.
 * Returns the ticks and the x() mapping onto [left, width - right].
 */
export function progressionAxis(
  firstDates,
  lastDates,
  { width = 1000, left = 96, right = 72 } = {},
) {
  const tFirst = Math.min(...firstDates.map(day));
  const tLast = Math.max(...lastDates.map(day));
  const pad = Math.max(30 * DAY, (tLast - tFirst) * 0.04);
  const t0 = tFirst - pad;
  const t1 = tLast + pad;
  const years = (t1 - t0) / (365.25 * DAY);
  const xt = (t) => left + ((t - t0) / (t1 - t0)) * (width - left - right);
  const ticks = [];
  const yearStep = years > 8 ? 2 : 1;
  for (let y = new Date(t0).getUTCFullYear(); y <= new Date(t1).getUTCFullYear(); y += 1)
    for (const m of [0, 3, 6, 9]) {
      const t = Date.UTC(y, m, 1);
      if (t < t0 || t > t1 || (m && years >= 4)) continue;
      let label = null;
      if (m === 0) label = y % yearStep === 0 ? String(y) : null;
      else if (years < 1.5) label = ['', 'Apr', 'Jul', 'Oct'][m / 3];
      ticks.push({ t, major: m === 0, label });
    }
  const firstLabel = ticks.find((k) => k.label);
  if (firstLabel && !firstLabel.major)
    firstLabel.label = `${new Date(firstLabel.t).getUTCFullYear()} ${firstLabel.label}`;
  else if (ticks.length && firstLabel && xt(firstLabel.t) - xt(ticks[0].t) > 80)
    ticks[0].label = String(new Date(ticks[0].t).getUTCFullYear());
  return { t0, t1, ticks, xt, x: (s) => xt(day(s)) };
}

/**
 * The dates printed under a lane, most important first: a date that would
 * land within `gap` of one already placed is left out.
 */
export function placeDates(points, gap = 52) {
  const placed = [];
  for (const p of points) if (placed.every((q) => Math.abs(q.at - p.at) > gap)) placed.push(p);
  return placed;
}

const list = (items) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0];

/**
 * The Ask AI question while the history dialog shows `id`: about the
 * extension, its specification and its family, never the kernel thread or
 * the people in it, which the specifications kapa answers from do not cover.
 * Named by id and with "RISC-V", as the panel's own question is (askAi.js).
 */
export function historyQuestion(index, id) {
  const entry = index[id] ?? {};
  if (entry.parts?.length)
    return `Explain the RISC-V ${id} extension and its parts ${list(entry.parts)}.`;
  if (entry.landedWith?.length)
    return `Explain the RISC-V ${id} extension and how it relates to ${list(entry.landedWith)}.`;
  return `Explain the RISC-V ${id} extension and the specification that defines it.`;
}

/** Lane names are 13px JetBrains Mono: about this many chart units a character. */
const LABEL_CHAR = 8.2;
/** The longest lane name, in characters, before it is shortened. */
export const LABEL_MAX = 22;

/**
 * A lane's name: its extensions, as many as fit in LABEL_MAX characters,
 * then "+N" for the rest ("Za64rs +2"). The full list goes in the lane's title.
 */
export function laneLabel(members) {
  const all = members.join(', ');
  if (all.length <= LABEL_MAX) return all;
  for (let k = members.length - 1; k >= 1; k -= 1) {
    const label = `${members.slice(0, k).join(', ')} +${members.length - k}`;
    if (label.length <= LABEL_MAX) return label;
  }
  return `${members[0]} +${members.length - 1}`;
}

/** The left column the lane names need, so none runs into its bar: 96 units at least. */
export function labelColumn(labels) {
  const longest = Math.max(0, ...labels.map((l) => l.length));
  return Math.max(96, Math.ceil(12 + longest * LABEL_CHAR + 16));
}
