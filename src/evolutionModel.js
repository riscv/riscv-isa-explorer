/**
 * evolutionModel.js — the catalogue arranged as a history.
 *
 * Pure functions, no React and no JSON import: the catalogue is passed in, the
 * same contract marchUtils.js keeps.
 *
 * This replaced a waffle model. A waffle is a part-of-whole chart and this data
 * has no whole: a family drawn as 42 filled squares reads as "42 of 42", but
 * the catalogue grows and there is no denominator. Equal squares also weighed
 * `V` (627 instructions) the same as an umbrella tag defining none. What the
 * reader actually wants is how fast RISC-V grew and which parts have stopped
 * moving, and neither is a composition question.
 */

/** The 18 catalogue groups, in tile order, with their headings. */
export const CATALOGUE_GROUPS = [
  { key: 'base', label: 'Base ISA' },
  { key: 'standard', label: 'Single-Letter Extensions' },
  { key: 'z_bit', label: 'Bit Manipulation (Zb*)' },
  { key: 'z_atomics', label: 'Atomics (Za/Zic*)' },
  { key: 'z_compress', label: 'Compressed (Zc*)' },
  { key: 'z_float', label: 'Float & Numerics (Zf*)' },
  { key: 'z_load_store', label: 'Load / Store' },
  { key: 'z_integer', label: 'Integer' },
  { key: 'z_vector', label: 'Vector Subsets (Zv/Zve)' },
  { key: 'z_security', label: 'Security & CFI' },
  { key: 'z_crypto', label: 'Cryptography (Zk*)' },
  { key: 'z_vector_crypto', label: 'Vector Cryptography (Zvk*)' },
  { key: 'z_system', label: 'System' },
  { key: 'z_caches', label: 'Caches' },
  { key: 's_mem', label: 'Memory & Addressing' },
  { key: 's_interrupt', label: 'Interrupts (Sm/Ss)' },
  { key: 's_counters', label: 'Counters & Profiling' },
  { key: 's_trap', label: 'Traps' },
];

/**
 * The ratification date as a fractional year, or null when none is recorded.
 *
 * The catalogue stores "YYYY-MM", so snapping to the year discards precision the
 * data actually has -- and that precision is the story: 2021 was not a steady
 * year, it was four extensions in June and twenty in November.
 */
export function monthOf(ext) {
  const m = String(ext?.ratification_date ?? '').match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  return Number(m[1]) + (Number(m[2]) - 1) / 12;
}

/** The year an extension was ratified, or null when the catalogue records none. */
export function yearOf(ext) {
  const m = String(ext?.ratification_date ?? '').match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

/**
 * The catalogue arranged as a history rather than as a composition.
 *
 * WHY THIS REPLACED THE WAFFLE
 *
 * A waffle is a part-of-whole chart, and this data has no whole. A family drawn
 * as 42 filled squares reads as "42 of 42, complete", but the catalogue grows:
 * there is no denominator, and implying one is the single most misleading thing
 * the old view did. Equal squares also weighed `V` (627 instructions) the same
 * as an umbrella tag defining none.
 *
 * A cumulative curve has no ceiling to misread, and a lifecycle bar is a span
 * rather than a fraction. Between them they answer the two questions actually
 * being asked: how fast did RISC-V grow, and which parts of it have settled.
 *
 * The undated entries stay off both charts. 56 of 219 carry no ratification
 * date, and placing them anywhere on a time axis would invent one.
 */
export function buildEvolution(catalog, today = new Date()) {
  const rows = [];
  for (const group of CATALOGUE_GROUPS) {
    for (const ext of catalog?.[group.key] || []) {
      rows.push({
        id: ext.id,
        group: group.key,
        label: group.label,
        year: yearOf(ext),
        instructions: Object.keys(ext.instructions || {}).length,
      });
    }
  }

  const dated = rows.filter((r) => r.year !== null);
  const years = dated.map((r) => r.year);
  const minYear = years.length ? Math.min(...years) : null;
  const maxYear = years.length ? Math.max(...years) : null;

  const series = [];
  let cumulative = 0;
  let cumulativeInstructions = 0;
  for (let y = minYear; y <= maxYear; y += 1) {
    const inYear = dated.filter((r) => r.year === y);
    const instructions = inYear.reduce((n, r) => n + r.instructions, 0);
    cumulative += inYear.length;
    cumulativeInstructions += instructions;
    series.push({
      year: y,
      added: inYear.length,
      instructions,
      cumulative,
      cumulativeInstructions,
      /*
       * The current year has not finished, so its bar is not comparable with a
       * full one. Marked rather than hidden: dropping it would understate the
       * total, and drawing it unmarked would overstate the slowdown.
       */
      partial: y === today.getFullYear(),
    });
  }

  const families = CATALOGUE_GROUPS.map((group) => {
    const members = dated.filter((r) => r.group === group.key);
    if (members.length === 0) return null;
    const span = members.map((r) => r.year);
    /*
     * One entry per year the family actually shipped in, rather than a first-to-last
     * span. A span implies continuous work across every year it covers, and that is
     * not what happened: Memory & Addressing reads as six years of steady output but
     * is really four bursts separated by two silent years. Discrete points can show
     * a gap; a bar cannot.
     */
    const byYear = new Map();
    for (const r of members) byYear.set(r.year, (byYear.get(r.year) || 0) + 1);
    const points = [...byYear.entries()]
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => a.year - b.year);
    return {
      key: group.key,
      label: group.label,
      first: Math.min(...span),
      last: Math.max(...span),
      count: members.length,
      instructions: members.reduce((n, r) => n + r.instructions, 0),
      points,
      // The busiest single year this family had, which sets the largest dot.
      busiest: Math.max(...points.map((p) => p.count)),
    };
  })
    .filter(Boolean)
    .sort((a, b) => a.first - b.first || a.last - b.last || b.count - a.count);

  const undated = rows.filter((r) => r.year === null);

  return {
    series,
    families,
    minYear,
    maxYear,
    total: rows.length,
    dated: dated.length,
    undated: undated.length,
    undatedInstructions: undated.reduce((n, r) => n + r.instructions, 0),
    peak: series.reduce((a, b) => (b.added > a.added ? b : a), series[0] || null),
    // One scale across every row. Sizing each family against its own maximum
    // would make a family that shipped 2 in a year look like one that shipped 14.
    busiestCell: families.reduce((n, f) => Math.max(n, f.busiest), 1),
  };
}

/**
 * Every dated extension as its own dot, placed at the month it was ratified.
 *
 * The per-family chart this replaced drew one mark per family-year, which still
 * aggregated: a family that shipped ten in a year was one dot. Here each of the
 * 163 dated extensions is its own dot, so the shape of the field is the real
 * distribution rather than a summary of it.
 *
 * Dots that share a month stack upward into a column. Within a column they are
 * ordered by family, so members of one family sit adjacent and a column reads as
 * coloured bands -- comparing bands is possible, picking one dot out of eighteen
 * hues is not.
 */
export function buildScatter(catalog) {
  const events = [];
  const undated = [];
  for (const [index, group] of CATALOGUE_GROUPS.entries()) {
    for (const ext of catalog?.[group.key] || []) {
      const at = monthOf(ext);
      if (at === null) {
        /*
         * Kept, not dropped. These are real catalogued extensions; excluding them
         * made the chart show 163 of 219 and quietly present a subset as the whole.
         * They cannot go on a time axis -- there is no date to place them at -- so
         * they are drawn in their own band, off the axis and labelled as such.
         */
        undated.push({
          id: ext.id,
          short: ext.short && ext.short !== ext.id ? ext.short : '',
          group: group.key,
          family: group.label,
          colour: index,
          at: null,
          year: null,
          instructions: Object.keys(ext.instructions || {}).length,
        });
        continue;
      }
      events.push({
        id: ext.id,
        short: ext.short && ext.short !== ext.id ? ext.short : '',
        group: group.key,
        family: group.label,
        colour: index,
        at,
        year: yearOf(ext),
        instructions: Object.keys(ext.instructions || {}).length,
      });
    }
  }

  const columns = new Map();
  for (const e of events) {
    if (!columns.has(e.at)) columns.set(e.at, []);
    columns.get(e.at).push(e);
  }

  /*
   * Every dot gets its exact position in the running total: the nth extension
   * ratified sits at height n. So the field rises to the right and the dots ARE
   * the cumulative growth -- the line through them is a guide, not a separate
   * chart. Before this the y axis carried nothing, dots sat at a fixed middle,
   * and the picture said "how many that month" rather than "how many so far".
   *
   * Only the horizontal offset is invented. Dots sharing a date would otherwise
   * be one vertical stroke, so they fan out sideways using a golden-angle cosine
   * (deterministic -- the picture is identical on every render, unlike jitter).
   * Vertical position is never nudged, because it is real.
   */
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  let rank = 0;
  let widest = 0;
  for (const date of [...columns.keys()].sort((x, y) => x - y)) {
    const column = columns.get(date);
    column.sort((x, y) => x.colour - y.colour || x.id.localeCompare(y.id));
    column.forEach((e, i) => {
      rank += 1;
      e.rank = rank;
      e.dx = Math.cos(i * GOLDEN) * (3.5 + Math.sqrt(i) * 2.4);
      widest = Math.max(widest, Math.abs(e.dx));
    });
  }

  const at = events.map((e) => e.at);
  const all = [...events, ...undated];
  return {
    events: events.sort((a, b) => a.rank - b.rank),
    // Grouped by family so the band reads as coloured runs, like the columns do.
    undated: undated.sort((a, b) => a.colour - b.colour || a.id.localeCompare(b.id)),
    total: all.length,
    // The running total at the end, which is also the y axis maximum, and the
    // widest horizontal fan, so the chart can inset its edges to contain it.
    peakRank: rank,
    widest,
    months: columns.size,
    from: Math.min(...at),
    to: Math.max(...at),
    // Counts every member, dated or not, so the legend totals the whole catalogue
    // rather than the part that happens to be placeable in time.
    legend: CATALOGUE_GROUPS.map((g, i) => ({
      key: g.key,
      label: g.label,
      colour: i,
      count: all.filter((e) => e.group === g.key).length,
    })).filter((g) => g.count > 0),
  };
}

/**
 * The cumulative mass, stacked by family instead of by date.
 *
 * The version this replaced drew one 1.24px stripe per extension in ratification
 * order, so eighteen hues interleaved a pixel apart. Two independent reviewers
 * named the same three causes: the stripes are sub-pixel on ordinary displays,
 * equal-luminance hues vibrate against one another at that scale, and the
 * overlap used to close the gaps anti-aliased neighbouring colours together.
 *
 * Grouping by family fuses those stripes into contiguous bands. The arithmetic
 * is the real constraint: 163 separately legible marks stacked with a 1px gap
 * needs about 490px of height and the whole panel has 400px, so the cumulative
 * mass cannot be built from one mark per extension. It is built from 18 bands,
 * and the individual extensions stay visible as arrival dots on top of them.
 *
 * Bands are ordered by when each family first appears, so the stack builds from
 * a stable base rather than reshuffling as it grows.
 */
export function buildBands(scatter) {
  const dates = [...new Set(scatter.events.map((e) => e.at))].sort((a, b) => a - b);

  const firstSeen = new Map();
  for (const e of scatter.events) {
    if (!firstSeen.has(e.group)) firstSeen.set(e.group, e.at);
  }
  const order = [...firstSeen.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => key);

  const running = dates.map(() => 0);
  const bands = order.map((key) => {
    const members = scatter.events
      .filter((e) => e.group === key)
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const cum = dates.map((d) => members.filter((e) => e.at <= d).length);
    const base = running.slice();
    cum.forEach((v, i) => {
      running[i] += v;
    });

    /*
     * Each member's dot sits inside its own band, at the height it took the band
     * to. Its position is therefore still the running total -- just the family's
     * contribution to it, rather than a global rank.
     */
    let within = 0;
    for (const e of members) {
      within += 1;
      const i = dates.indexOf(e.at);
      e.stackY = base[i] + within;
    }

    return { key, label: members[0].family, colour: members[0].colour, base, cum };
  });

  return { dates, bands, total: running };
}

/**
 * Monotone cubic interpolation (Fritsch-Carlson), sampled to a polyline.
 *
 * The stepped path this softens was honest but hard to look at. An ordinary
 * spline is not a safe substitute for cumulative data: a Catmull-Rom or plain
 * bezier overshoots at every corner, so a running total would appear to dip
 * below a value it had already reached, or rise above one it had not. Nothing in
 * the ISA ever un-ratifies, and the chart must not draw that.
 *
 * Fritsch-Carlson limits the tangents so the interpolant is monotone wherever
 * the data is. Cumulative counts only ever rise, so the softened edge only ever
 * rises too. What it does give up is the flat-then-jump shape of a real
 * ratification: the curve now accrues gradually between months it actually
 * jumped on. The dots stay at their true months, and carry that truth.
 */
export function monotoneSample(xs, ys, at) {
  const n = xs.length;
  if (n === 0) return [];
  if (n === 1) return at.map(() => ys[0]);

  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = xs[i + 1] - xs[i];
    slope.push(dx === 0 ? 0 : (ys[i + 1] - ys[i]) / dx);
  }

  const m = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i += 1) m[i] = (slope[i - 1] + slope[i]) / 2;

  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    // The circle of radius 3 is the monotonicity region; outside it the
    // interpolant would overshoot, so pull the tangents back onto the boundary.
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * slope[i];
      m[i + 1] = tau * b * slope[i];
    }
  }

  let seg = 0;
  return at.map((x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    while (seg < n - 2 && xs[seg + 1] < x) seg += 1;
    const h = xs[seg + 1] - xs[seg];
    if (h === 0) return ys[seg];
    const t = (x - xs[seg]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[seg] +
      (t3 - 2 * t2 + t) * h * m[seg] +
      (-2 * t3 + 3 * t2) * ys[seg + 1] +
      (t3 - t2) * h * m[seg + 1]
    );
  });
}
