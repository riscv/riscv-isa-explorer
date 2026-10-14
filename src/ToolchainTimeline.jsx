import React from 'react';
import toolchainData from './toolchain-support.json';
import { marchToken, toolchainTimeline } from './toolchainSupport.js';

/**
 * ToolchainTimeline — when each extension reached Clang, GCC, binutils, QEMU
 * and Linux, drawn under the ratification chart in the Evolution dialog.
 *
 * One stepped line per tool: a step is a release, its height the number of
 * catalogue extensions that release knew. Stepped, never smoothed, because
 * support changes only on a release day. The dashed grey line is how many of
 * the same extensions had been ratified by then, so the gap between a tool's
 * line and it is that tool's lag.
 *
 * Inline SVG measured to its real width, as ExtensionEvolution does, for the
 * same reasons: no charting dependency, and no smeared text from a stretched
 * viewBox.
 */

const PAD = { top: 14, right: 12, bottom: 8, left: 38 };
const H = 220;

/* Equal-luminance hues from the Evolution palette, ~4.1:1 on both grounds. */
const COLOUR = { llvm: 4, gcc: 0, binutils: 8, qemu: 2, linux: 1 };

/* "2024-05-07" as a fractional year. */
const yearOf = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return y + (m - 1) / 12 + (d - 1) / 365;
};

const listed = (tokens) =>
  tokens.length > 8
    ? `${tokens.slice(0, 8).join(', ')} and ${tokens.length - 8} more`
    : tokens.join(', ');

export default function ToolchainTimeline({ catalog, today = new Date() }) {
  const ratifiedByToken = React.useMemo(
    () =>
      new Map(
        Object.values(catalog || {})
          .flat()
          .filter((e) => e?.ratification_date)
          .map((e) => [marchToken(e.id), String(e.ratification_date).slice(0, 7)]),
      ),
    [catalog],
  );
  const model = React.useMemo(
    () => toolchainTimeline(toolchainData, ratifiedByToken),
    [ratifiedByToken],
  );
  const [lit, setLit] = React.useState(null);

  const boxRef = React.useRef(null);
  const [boxW, setBoxW] = React.useState(0);
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
  }, []);

  if (!model.from) return null;

  const X0 = Math.floor(yearOf(model.from));
  const X1 = Math.floor(yearOf(model.to)) + 1;
  // Each line holds its newest level up to today, never into the future.
  const now = Math.min(X1, today.getFullYear() + (today.getMonth() + today.getDate() / 31) / 12);
  const W = boxW || 680;
  const top =
    Math.ceil(
      Math.max(
        ...model.tools.flatMap((t) => t.points.map((p) => p.count)),
        ...model.ratified.map((r) => r.count),
      ) / 20,
    ) * 20;
  const px = (t) => PAD.left + ((t - X0) / (X1 - X0)) * (W - PAD.left - PAD.right);
  const py = (v) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);

  const steps = (points, value) => {
    let d = '';
    points.forEach((p, i) => {
      const x = px(yearOf(p.date)).toFixed(2);
      const y = py(value(p)).toFixed(2);
      d += i ? ` H ${x} V ${y}` : `M ${x} ${y}`;
    });
    return `${d} H ${px(now).toFixed(2)}`;
  };

  const years = Array.from({ length: X1 - X0 }, (_, i) => X0 + i);
  const newest = model.tools.map((t) => `${t.name} ${t.points.at(-1).count}`).join(', ');
  const ratifiedNow = model.ratified.at(-1)?.count ?? 0;

  return (
    // Inside .riscv-evo for its palette and type, which are scoped there.
    <section className="riscv-evo riscv-tl">
      <figure className="riscv-evo__fig" ref={boxRef} onMouseLeave={() => setLit(null)}>
        <figcaption>
          Extensions each tool knows, by release
          <span className="riscv-evo__hint">
            a step is a release; the dashed line is how many of them had been ratified
          </span>
        </figcaption>

        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="riscv-evo__curve riscv-tl__chart"
          role="img"
          aria-label={`Extensions known per tool over time. Newest releases: ${newest}, against ${ratifiedNow} ratified.`}
        >
          {[0, top / 2, top].map((v) => (
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
          {years.slice(1).map((y) => (
            <line
              key={y}
              className="riscv-tl__tick"
              x1={px(y)}
              x2={px(y)}
              y1={PAD.top}
              y2={H - PAD.bottom}
            />
          ))}

          <path className="riscv-tl__ref" d={steps(model.ratified, (r) => r.count)}>
            <title>{`Ratified: ${ratifiedNow} of these extensions`}</title>
          </path>

          {model.tools.map((tool) => (
            <g
              key={tool.key}
              className={'riscv-tl__tool' + (lit && lit !== tool.key ? ' is-dim' : '')}
              style={{ '--c': `var(--evo-c${COLOUR[tool.key] ?? 0})` }}
              onMouseEnter={() => setLit(tool.key)}
            >
              <path className="riscv-tl__line" d={steps(tool.points, (p) => p.count)} />
              {tool.points.map((p) => (
                <circle
                  key={p.version}
                  className={'riscv-tl__pt' + (p.floor ? ' is-floor' : '')}
                  cx={px(yearOf(p.date))}
                  cy={py(p.count)}
                  r={p.floor ? 3.5 : 3}
                >
                  <title>
                    {p.floor
                      ? `${tool.name} ${p.version} (${p.date}): ${p.count} known. The first release scanned, so this counts everything it already had.`
                      : `${tool.name} ${p.version} (${p.date}): ${p.count} known` +
                        (p.added.length
                          ? `, ${p.added.length} new: ${listed(p.added)}`
                          : ', nothing new')}
                  </title>
                </circle>
              ))}
            </g>
          ))}
        </svg>

        <div className="riscv-evo__axis" aria-hidden="true">
          {years.map((y) => (
            <span
              key={y}
              className="riscv-evo__year"
              style={{ '--x': px(y + 0.5) / W, '--inset': '0px' }}
            >
              {`'${String(y).slice(2)}`}
            </span>
          ))}
        </div>

        <ul className="riscv-evo__key">
          {model.tools.map((tool) => (
            <li key={tool.key}>
              <button
                type="button"
                className={'riscv-evo__keybtn' + (lit && lit !== tool.key ? ' is-dim' : '')}
                style={{ '--c': `var(--evo-c${COLOUR[tool.key] ?? 0})` }}
                onMouseEnter={() => setLit(tool.key)}
                onFocus={() => setLit(tool.key)}
                onClick={() => setLit((k) => (k === tool.key ? null : tool.key))}
                aria-pressed={lit === tool.key}
              >
                <i />
                {tool.name}
                <b>{tool.points.at(-1).count}</b>
              </button>
            </li>
          ))}
          <li>
            <span className="riscv-evo__keybtn riscv-tl__refkey">
              <i />
              Ratified
              <b>{ratifiedNow}</b>
            </span>
          </li>
        </ul>

        <p className="riscv-evo__foot">
          Knowing an extension means accepting it in <code>-march</code> (Clang, GCC), assembling it
          (binutils), emulating it (QEMU) or detecting it (Linux), not generating code for it. Each
          line starts at the first release scanned (
          {model.tools.map((t, i) => `${i ? ', ' : ''}${t.name} ${t.points[0].version}`)}), which
          counts everything that release already had, so its first step is a floor rather than a
          jump.
        </p>
      </figure>
    </section>
  );
}
