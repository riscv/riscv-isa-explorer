import React from 'react';
import { buildBands, buildEvolution, buildScatter, monotoneSample } from './evolutionModel.js';

/**
 * ExtensionEvolution — how RISC-V grew, and when each extension arrived.
 *
 * Two charts over one calendar axis. The curve answers "how fast did this grow";
 * the scatter puts every dated extension on the month it was ratified, so the
 * reader sees the events themselves rather than a summary of them.
 *
 * Neither chart has a denominator. The waffle these replaced drew each family as
 * a row of filled squares, which reads as "42 of 42" when the catalogue has no
 * maximum; the lifecycle bars that followed implied continuous work across every
 * year a bar spanned, which is equally untrue. A dot is an event.
 *
 * Inline SVG and absolutely-positioned spans rather than a charting library: two
 * charts of this size do not justify a dependency, and the published page's CSP
 * admits scripts from a short allowlist only.
 */

const PAD = { top: 14, right: 10, bottom: 20, left: 38 };
const CURVE_H = 240;

export default function ExtensionEvolution({ catalog, onSelect }) {
  const model = React.useMemo(() => buildEvolution(catalog), [catalog]);
  const scatter = React.useMemo(() => buildScatter(catalog), [catalog]);
  const bands = React.useMemo(() => buildBands(scatter), [scatter]);
  const { series, minYear, maxYear } = model;

  const reduceMotion = React.useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  /*
   * A continuous playhead rather than a yearly tick. The drawing edge sweeps the
   * axis and each dot appears as the edge reaches its own month, so the curve is
   * drawn and populated in one motion instead of arriving in eight jumps.
   */
  const [playing, setPlaying] = React.useState(!reduceMotion);
  const [lit, setLit] = React.useState(null);

  /*
   * Measured in real pixels rather than a stretched viewBox. Scaling a viewBox
   * with preserveAspectRatio="none" smears everything that is not a horizontal
   * line -- axis labels become squiggles, point markers become ellipses -- and
   * it turns fixed padding into a percentage of the width.
   */
  const boxRef = React.useRef(null);
  const [boxW, setBoxW] = React.useState(0);

  /*
   * Measured synchronously before paint, then kept current by an observer. The
   * observer alone was not enough: its first callback can land after the frame
   * that matters, and the chart then renders its whole geometry against a guessed
   * width -- the SVG letterboxes and every mark shifts. Measuring in a layout
   * effect means the first painted frame is already correct.
   */
  React.useLayoutEffect(() => {
    const node = boxRef.current;
    if (!node) return undefined;
    const read = () => {
      const next = node.getBoundingClientRect().width;
      if (next > 0) setBoxW((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(node);
    return () => ro.disconnect();
    /*
     * Mount only. Without the dependency array this re-ran on every render,
     * tearing down and rebuilding the observer each time; the measured width
     * churned by fractions of a pixel, which restarted the animation effect
     * before it could advance a frame. The playhead sat at the start line.
     */
  }, []);

  if (minYear === null) return null;

  /*
   * One calendar domain -- January of the first year to January after the last --
   * so a given month is the same horizontal position in both charts. A year's
   * cumulative total is plotted at the END of that year, which is when it was
   * actually true, and the line starts from zero at the domain's origin.
   */
  const X0 = minYear;
  const X1 = maxYear + 1;
  const at = (t) => (t - X0) / (X1 - X0);

  // The layout effect measures before paint, so this fallback only ever applies
  // in a non-DOM render; the first painted frame already has the real width.
  const W = boxW || 680;
  const top = Math.max(...series.map((s) => s.cumulative));
  const px = (t) => PAD.left + at(t) * (W - PAD.left - PAD.right);
  const py = (v) => PAD.top + (1 - v / top) * (CURVE_H - PAD.top - PAD.bottom);

  /*
   * Every edge sampled off one monotone spline, so the bands and the outline
   * bend identically and the outline still bounds the mass exactly.
   */
  const SAMPLES = 240;
  const sampleXs = Array.from(
    { length: SAMPLES },
    (_, i) => px(X0) + (i / (SAMPLES - 1)) * (px(X1) - px(X0)),
  );
  const edgeXs = bands.dates.map((d) => px(d)).concat([px(X1)]);
  const smoothEdge = (values) =>
    monotoneSample(
      edgeXs,
      values.map((v) => py(v)).concat([py(values[values.length - 1])]),
      sampleXs,
    );

  /*
   * The guide is the top of the stack, sampled off the very same spline as the
   * band edges. Built independently it would drift from the mass it is meant to
   * bound -- the failure this chart already had once, when the line stepped
   * yearly over bands that stepped monthly.
   */
  const topEdge = smoothEdge(bands.total);
  const line = `M ${sampleXs.map((x, i) => `${x.toFixed(2)} ${topEdge[i].toFixed(2)}`).join(' L ')}`;

  /*
   * Each family is one band, stacked in the order the families first
   * appear. The band's height at any moment is that family's cumulative count,
   * so the top of the stack is the total and the bands are contiguous blocks of
   * one colour instead of eighteen hues interleaved a pixel apart.
   *
   * Stepped, never smoothed: the total genuinely holds flat between ratification
   * months, and a curve through those points would draw growth that did not
   * happen.
   */
  const bandPath = (band) => {
    const lo = smoothEdge(band.base);
    const hi = smoothEdge(band.base.map((v, i) => v + band.cum[i]));
    const bottom = sampleXs.map((x, i) => `${x.toFixed(2)} ${lo[i].toFixed(2)}`);
    const top = sampleXs.map((x, i) => `${x.toFixed(2)} ${hi[i].toFixed(2)}`).reverse();
    return `M ${bottom.join(' L ')} L ${top.join(' L ')} Z`;
  };

  const monthLabel = (t) => {
    const year = Math.floor(t + 1e-6);
    const month = Math.round((t - year) * 12) + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
  };

  return (
    <section className="riscv-evo" onMouseLeave={() => setLit(null)}>
      <figure className="riscv-evo__fig" ref={boxRef}>
        <figcaption>
          Extensions ratified, cumulative
          <span className="riscv-evo__hint">
            every dot is one extension, at its own place in the running total
          </span>
          <output className="riscv-evo__read">{`${scatter.events.length} of ${scatter.total}`}</output>
          <button
            type="button"
            className="riscv-evo__play"
            onClick={() => {
              // Stopping shows the finished picture rather than whichever year the
              // loop happened to be passing -- that is the frame worth reading.
              setPlaying((p) => !p);
            }}
            aria-label={playing ? 'Stop and show every year' : 'Replay the timeline from the start'}
          >
            {playing ? '❙❙ Show all' : '▶ Replay'}
          </button>
        </figcaption>

        {/* The dots are positioned as percentages of this box, so it must wrap the
            SVG alone. Anchoring them to the <figure> included the caption and
            pushed every dot upward by its height. */}
        {/*
         * The sweep is a CSS animation on this wrapper, inherited by the mass,
         * the guide and the dot layer alike, so they reveal in lockstep.
         *
         * It was a requestAnimationFrame loop writing attributes directly. That
         * cannot be made reliable here: React owns these elements, and every
         * reconcile reset the values the frame had just written -- so the
         * playhead kept snapping back to the start line.
         */}
        <div className={'riscv-evo__plot' + (playing ? ' is-sweeping' : '')}>
          <svg
            viewBox={`0 0 ${W} ${CURVE_H}`}
            className="riscv-evo__curve"
            role="img"
            aria-label={`Cumulative ratified extensions, rising from ${series[0].cumulative} at the end of ${minYear} to ${top}. The steepest year is ${model.peak.year}, which added ${model.peak.added}.`}
          >
            {[0, Math.round(top / 2), top].map((v) => (
              <g key={v}>
                <line
                  className="riscv-evo__grid"
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={py(v)}
                  y2={py(v)}
                />
                <text className="riscv-evo__ylabel" x={PAD.left - 8} y={py(v) + 4}>
                  {v}
                </text>
              </g>
            ))}

            <defs>
              {/*
               * A real clipPath applied through the SVG *attribute*. WebKit does
               * not implement the CSS clip-path property on SVG elements, so the
               * stylesheet sweep animated the HTML dot layer and left the mass
               * fully drawn from the first frame -- the animation looked broken
               * on iOS while working in Chrome.
               *
               * The wipe rect is animated with a transform, which SVG supports
               * everywhere, instead of an animated clip-path.
               */}
              <clipPath id="riscv-evo-reveal" clipPathUnits="userSpaceOnUse">
                <rect className="riscv-evo__wipe" x={0} y={0} width={W} height={CURVE_H} />
              </clipPath>
            </defs>

            <g className="riscv-evo__mass" clipPath="url(#riscv-evo-reveal)">
              {bands.bands.map((band) => (
                <path
                  key={band.key}
                  className={lit && lit !== band.key ? 'is-dim' : undefined}
                  d={bandPath(band)}
                  fill={`var(--evo-c${band.colour})`}
                >
                  <title>{`${band.label}: ${band.cum[band.cum.length - 1]} ratified`}</title>
                </path>
              ))}
            </g>

            <path className="riscv-evo__line" d={line} clipPath="url(#riscv-evo-reveal)" />
          </svg>

          {/* Overlaid on the same box and the same scales, so a dot's height is
            read off the very axis the line is drawn against. */}
          <div className="riscv-evo__field">
            {scatter.events.map((e) => (
              <button
                type="button"
                key={e.id}
                // Always rendered; the sweeping clip on this layer decides
                // what is visible, so no per-dot state changes during the run.
                className={'riscv-evo__pt' + (lit && lit !== e.group ? ' is-dim' : '')}
                style={{
                  /*
                   * Percentages of the viewBox, not raw units. The SVG scales its
                   * viewBox to whatever box it is given -- 240 units into 230px
                   * here -- so pixel coordinates drift out of register with the
                   * line and dots near the top escaped the plot entirely. A
                   * percentage rides the same scaling the line does.
                   */
                  left: `${(((px(e.at) + e.dx) / W) * 100).toFixed(3)}%`,
                  top: `${((py(e.stackY) / CURVE_H) * 100).toFixed(3)}%`,
                  '--c': `var(--evo-c${e.colour})`,
                }}
                title={`${e.id}${e.short ? ` — ${e.short}` : ''}\n${e.family}\nratified ${monthLabel(e.at)}\n#${e.rank} of ${scatter.peakRank} ratified`}
                onMouseEnter={() => setLit(e.group)}
                onFocus={() => setLit(e.group)}
                onClick={() => onSelect && onSelect(e.id)}
              >
                <span className="sr-only">{`${e.id}, ${e.family}, ratified ${monthLabel(e.at)}`}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="riscv-evo__axis" aria-hidden="true">
          {series.map((s) => (
            <span
              key={s.year}
              className="riscv-evo__year"
              // Centred in its own year rather than on the boundary, so a label
              // reads as "this band of dots" instead of as a tick.
              style={{ '--x': at(s.year + 0.5) }}
            >
              {`'${String(s.year).slice(2)}`}
            </span>
          ))}
        </div>

        {/*
         * Off the axis on purpose. These are real catalogued extensions and belong
         * in the picture -- leaving them out charted a subset while presenting it
         * as the whole -- but the catalogue records no date for them, and placing
         * them anywhere on the timeline would invent one. So they sit below it,
         * behind a rule, labelled for what they are.
         */}
        <div className="riscv-evo__nodate">
          <span className="riscv-evo__nodatelabel">
            No ratification date recorded <b>{scatter.undated.length}</b>
            <span className="riscv-evo__hint">— real extensions, not placeable in time</span>
          </span>
          <span className="riscv-evo__nodatefield">
            {scatter.undated.map((e) => (
              <button
                type="button"
                key={e.id}
                className={
                  'riscv-evo__pt is-in is-loose' + (lit && lit !== e.group ? ' is-dim' : '')
                }
                style={{ '--c': `var(--evo-c${e.colour})` }}
                title={`${e.id}${e.short ? ` — ${e.short}` : ''}\n${e.family}\nno ratification date recorded`}
                onMouseEnter={() => setLit(e.group)}
                onFocus={() => setLit(e.group)}
                onClick={() => onSelect && onSelect(e.id)}
              >
                <span className="sr-only">{`${e.id}, ${e.family}, no ratification date`}</span>
              </button>
            ))}
          </span>
        </div>

        <ul className="riscv-evo__key">
          {scatter.legend.map((g) => (
            <li key={g.key}>
              <button
                type="button"
                className={'riscv-evo__keybtn' + (lit && lit !== g.key ? ' is-dim' : '')}
                style={{ '--c': `var(--evo-c${g.colour})` }}
                onMouseEnter={() => setLit(g.key)}
                onFocus={() => setLit(g.key)}
                onClick={() => setLit((k) => (k === g.key ? null : g.key))}
                aria-pressed={lit === g.key}
              >
                <i />
                {g.label}
                <b>{g.count}</b>
              </button>
            </li>
          ))}
        </ul>
      </figure>

      <p className="riscv-evo__foot">
        {/*
         * The only caveat that cannot be drawn: a partial year charted as a full
         * one overstates the slowdown.
         *
         * What the undated entries are is said once, on the band itself, where
         * the reader is looking at them. Repeating it here and in the dialog
         * subtitle stated one fact three times.
         */}
        {maxYear} is still running, so its figure is partial. The curve counts dated extensions
        only.
      </p>
    </section>
  );
}
