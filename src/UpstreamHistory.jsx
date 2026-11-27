import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import historyIndex from './upstream-history-index.json';
import { focusableWithin, nextFocus } from './focusTrap.js';
import {
  bundleRelease,
  groupFor,
  hasHistory as indexHasHistory,
  historyQuestion,
  month,
  placeDates,
  progressionAxis,
  span,
  timelineItems,
} from './upstreamHistory.js';

/*
 * How an extension got into Linux (#649), opened from the details panel's
 * Linux chip. The index (a few numbers per extension) ships with the bundle;
 * the full history, with its AI summary, is a separate chunk loaded the first
 * time a dialog opens, so the bundle does not grow with the data.
 * ?history=linux, beside ?ext=, opens the dialog.
 */
export const HISTORY_PARAM = 'history';
export const hasHistory = (id) => indexHasHistory(historyIndex, id);
let fullData = null;
const loadHistory = () =>
  (fullData ??= import(/* webpackChunkName: "upstream-history" */ './upstream-history.json').then(
    (m) => m.default ?? m,
  ));

const MONO = "'JetBrains Mono', monospace";

/*
 * What the Ask AI chip should ask while a history dialog is open: a small
 * store, because the chip lives in the page and the dialog deep in the
 * details panel. The dialog sets it for the extension it shows and clears it
 * when it closes; risc_v_visualizer.jsx reads it with useHistoryAskContext().
 */
let askContext = null;
const askListeners = new Set();
function setAskContext(next) {
  askContext = next;
  askListeners.forEach((listener) => listener(next));
}
export function useHistoryAskContext() {
  const [context, setContext] = React.useState(askContext);
  React.useEffect(() => {
    askListeners.add(setContext);
    setContext(askContext);
    return () => askListeners.delete(setContext);
  }, []);
  return context;
}

/** Keys typed into a field, or into the Ask AI widget (its own shadow root), are not the dialog's. */
function keyBelongsElsewhere(e) {
  const target = e.composedPath?.()[0] ?? e.target;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)) return true;
  if (target?.closest?.('[contenteditable]:not([contenteditable="false"])')) return true;
  const kapa = document.getElementById('kapa-widget-container');
  return Boolean(kapa && (e.target === kapa || kapa.contains(e.target)));
}
const SECTION = 'text-[11px] uppercase tracking-widest font-semibold mb-2';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The line under the toolchain rows, with the button that opens the dialog. */
export function HistorySummary({ id, onOpen }) {
  const h = historyIndex[id];
  if (!h) return null;
  let text;
  if (h.listed)
    text = `In the kernel's extension list since Linux ${h.listed.release}, added there with ${h.listed.others} others in one commit; the work that made it supported is older and not collected yet.`;
  else if (h.parts)
    text = `Detected through ${h.parts.map((p) => (historyIndex[p]?.release ? `${p} (${historyIndex[p].release})` : p)).join(', ')}`;
  else
    text = `First Linux patch ${month(h.firstPatch)} · ${plural(h.versions, 'version')} · ${h.replies} review replies${h.landedWith.length ? ` · landed with ${h.landedWith.join(', ')}` : ''}`;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] mt-1.5">
      <span
        className="w-10 text-[10px] uppercase tracking-widest font-semibold"
        style={{ color: 'var(--riscv-text-3)' }}
      >
        Path
      </span>
      <span className="min-w-0" style={{ color: 'var(--riscv-text-2)' }}>
        {text}
      </span>
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          className="font-semibold underline underline-offset-2"
          style={{ color: 'var(--riscv-violet)' }}
        >
          View history
        </button>
      )}
    </div>
  );
}

const readUrl = () => {
  try {
    return new URLSearchParams(window.location.search).get(HISTORY_PARAM) === 'linux';
  } catch {
    return false;
  }
};
function writeUrl(open) {
  try {
    const url = new URL(window.location.href);
    if (open) url.searchParams.set(HISTORY_PARAM, 'linux');
    else url.searchParams.delete(HISTORY_PARAM);
    if (url.href !== window.location.href)
      window.history.replaceState(window.history.state, '', url);
  } catch {
    /* no history API (a sandbox): the dialog still works, unlinked */
  }
}

/** Open state for one extension's dialog, kept in the address bar. */
export function useHistoryDialog(id) {
  const [open, setOpen] = React.useState(() => hasHistory(id) && readUrl());
  const first = React.useRef(true);
  React.useEffect(() => {
    // Another extension starts closed, unless the link that opened the page asked.
    if (first.current) {
      first.current = false;
      return;
    }
    setOpen(false);
  }, [id]);
  React.useEffect(() => {
    writeUrl(open && hasHistory(id));
  }, [open, id]);
  // Closing the panel unmounts this; the address bar should stop asking for the dialog.
  React.useEffect(() => () => writeUrl(false), []);
  return [open, setOpen];
}

function GroupNav({ group, at, prev, next, onPick }) {
  const step = (target, dir) => (
    <button
      type="button"
      onClick={() => target && onPick(target)}
      disabled={!target}
      aria-label={target ? `${dir === 'prev' ? 'Previous' : 'Next'}: ${target}` : undefined}
      className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-[12px] font-mono font-semibold disabled:cursor-default"
      // The explorer's gold, so the way on stands out; an end of the group is a dashed outline.
      style={
        target
          ? {
              background: 'var(--riscv-gold)',
              borderColor: 'var(--riscv-gold)',
              color: 'var(--riscv-bg)',
            }
          : {
              borderColor: 'var(--riscv-border-2)',
              borderStyle: 'dashed',
              color: 'var(--riscv-text-3)',
            }
      }
    >
      {dir === 'prev' ? `‹ ${target ?? 'Previous'}` : `${target ?? 'Next'} ›`}
    </button>
  );
  return (
    <nav
      aria-label={group.label}
      className="flex flex-wrap items-center justify-between gap-2 px-5 py-2"
      style={{
        borderBottom: '1px solid var(--riscv-border)',
        background: 'var(--riscv-surface-2)',
      }}
    >
      {step(prev, 'prev')}
      <span className="text-[12px] tabular-nums" style={{ color: 'var(--riscv-text-3)' }}>
        {group.label}: {at + 1} of {group.items.length}
        <span className="hidden sm:inline"> · use ← → to step</span>
      </span>
      {step(next, 'next')}
    </nav>
  );
}

export function HistoryDialog({ id, onClose }) {
  // The extension the dialog shows: the panel's, or one reached from it.
  const [current, setCurrent] = React.useState(id);
  // The element that opened the dialog, read before any effect moves focus,
  // so closing returns there (the Linux chip or the View history button).
  const [opener] = React.useState(() =>
    typeof document === 'undefined' ? null : document.activeElement,
  );
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const dialogRef = React.useRef(null);
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const group = groupFor(historyIndex, id, current);
  const at = group ? group.items.indexOf(current) : -1;
  const prev = group && at > 0 ? group.items[at - 1] : null;
  const next = group && at < group.items.length - 1 ? group.items[at + 1] : null;

  React.useEffect(() => {
    let live = true;
    loadHistory()
      .then((all) => live && setData(all))
      .catch((e) => live && setError(String(e?.message ?? e)));
    return () => {
      live = false;
    };
  }, []);
  React.useEffect(() => {
    dialogRef.current?.focus();
    setAskContext({ query: historyQuestion(historyIndex, current), submit: true });
  }, [current]);
  React.useEffect(() => () => setAskContext(null), []);

  React.useEffect(() => {
    const restore = opener;
    dialogRef.current?.focus();
    const onKey = (e) => {
      if (keyBelongsElsewhere(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.metaKey) {
        e.preventDefault();
        // From the state itself, not the last render: keys pressed faster
        // than React renders would otherwise all step from the same place.
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        setCurrent((shown) => {
          const g = groupFor(historyIndex, id, shown);
          const i = g ? g.items.indexOf(shown) + delta : -1;
          return g && i >= 0 && i < g.items.length ? g.items[i] : shown;
        });
        return;
      }
      if (e.key !== 'Tab') return;
      const target = nextFocus(
        focusableWithin(dialogRef.current),
        document.activeElement,
        e.shiftKey,
      );
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (restore && typeof restore.focus === 'function') restore.focus();
    };
  }, []);

  const lanes = group ? group.items : [current];
  // Into document.body: the details panel is transformed, which would pin a
  // fixed overlay inside it to the panel instead of the window.
  return createPortal(
    <div className="fixed inset-0 z-[60] text-[13px]">
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(7,7,14,0.8)', backdropFilter: 'blur(6px)' }}
        onClick={onClose}
        role="presentation"
      />
      <div
        className="absolute inset-0 p-3 md:p-8 flex items-start justify-center overflow-y-auto"
        // This layer covers the backdrop, so a click outside the card lands here.
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        role="presentation"
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="history-title"
          tabIndex={-1}
          className="animate-scale-in riscv-card w-full max-w-4xl"
          style={{ borderRadius: 16, boxShadow: '0 0 60px rgba(0,0,0,0.6)' }}
        >
          <div
            className="flex items-center justify-between gap-3 px-5 py-3"
            style={{ borderBottom: '1px solid var(--riscv-border-2)' }}
          >
            <h2
              id="history-title"
              className="text-[14px] font-bold flex flex-wrap items-baseline gap-2"
            >
              {current !== id && (
                <>
                  <button
                    type="button"
                    onClick={() => setCurrent(id)}
                    className="text-[12px] font-normal underline underline-offset-2"
                    style={{ color: 'var(--riscv-text-2)' }}
                  >
                    {id}
                  </button>
                  <span style={{ color: 'var(--riscv-text-3)' }}>›</span>
                </>
              )}
              <span className="font-mono" style={{ color: 'var(--riscv-gold)' }}>
                {current}
              </span>
              <span style={{ color: 'var(--riscv-text-2)' }}>Upstream history · Linux</span>
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close history"
              className="p-1.5 rounded"
              style={{ color: 'var(--riscv-text-2)' }}
            >
              <X size={16} />
            </button>
          </div>
          {group && <GroupNav group={group} at={at} prev={prev} next={next} onPick={setCurrent} />}
          <div className="p-5">
            {error && (
              <p style={{ color: 'var(--riscv-danger)' }}>Could not load the history: {error}</p>
            )}
            {!error && !data && <p style={{ color: 'var(--riscv-text-3)' }}>Loading…</p>}
            {data && (
              <Progression
                ids={lanes.filter((x) => data.extensions[x])}
                current={current}
                data={data}
                onPick={setCurrent}
              />
            )}
            {data && historyIndex[current]?.parts && (
              <BundleBody id={current} parts={historyIndex[current].parts} onPick={setCurrent} />
            )}
            {data && data.extensions[current] && (
              <HistoryBody
                h={data.series[data.extensions[current].series]}
                landedWith={data.extensions[current].landedWith}
                onPick={setCurrent}
              />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Swatch({ style, cls = 'w-4 h-2 rounded', children }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={`inline-block ${cls}`} style={style} />
      {children}
    </span>
  );
}

/*
 * The progression on one time axis, a lane per series: the whole path from
 * first patch to release (grey, a dot for each earlier attempt), the series
 * that landed from its first posting to when it was applied (gold, a tick per
 * version), applied (violet) and released (green), with dates under them.
 */
function Progression({ ids, current, data, onPick }) {
  const bySeries = new Map();
  for (const x of ids) {
    const key = data.extensions[x].series;
    if (!bySeries.has(key)) bySeries.set(key, []);
    bySeries.get(key).push(x);
  }
  const lanes = [...bySeries.entries()].map(([key, members]) => ({
    s: data.series[key],
    members,
    id: members.includes(current) ? current : members[0],
    label:
      members.length > 3
        ? `${members.slice(0, 3).join(', ')} +${members.length - 3}`
        : members.join(', '),
  }));
  if (!lanes.length) return null;
  const W = 1000;
  const laneH = 60;
  const top = 26;
  const H = top + lanes.length * laneH + 4;
  const axis = progressionAxis(
    lanes.map((l) => l.s.firstPatch),
    lanes.map((l) => l.s.release.date),
    { width: W },
  );
  const { x, xt } = axis;
  const pickable = lanes.length > 1;
  return (
    <section className="mb-5">
      <h3 className={SECTION} style={{ color: 'var(--riscv-text-3)' }}>
        Progression
      </h3>
      <div
        className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] mb-2"
        style={{ color: 'var(--riscv-text-2)' }}
        aria-hidden="true"
      >
        <Swatch
          style={{ background: 'var(--riscv-text-3)', opacity: 0.55 }}
          cls="w-4 h-1.5 rounded"
        >
          Whole path, earlier attempts as dots
        </Swatch>
        <Swatch style={{ background: 'var(--riscv-gold)' }}>
          Series that landed, a tick per version
        </Swatch>
        <Swatch style={{ background: 'var(--riscv-violet)' }} cls="w-1 h-3">
          Applied
        </Swatch>
        <Swatch style={{ background: 'var(--riscv-success)' }} cls="w-2 h-2 rounded-sm">
          Linux release
        </Swatch>
      </div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full h-auto"
          style={{ minWidth: 560 }}
          role="img"
          aria-label={lanes
            .map(
              (l) =>
                `${l.members.join(', ')}: first patch ${l.s.firstPatch}, applied ${l.s.commit.applied}, Linux ${l.s.release.version}`,
            )
            .join('; ')}
        >
          {axis.ticks.map((k) => (
            <g key={k.t}>
              <line
                x1={xt(k.t)}
                x2={xt(k.t)}
                y1={top - 6}
                y2={H - 2}
                stroke="var(--riscv-border)"
                strokeWidth="1"
                strokeDasharray={k.major ? undefined : '2 4'}
              />
              {k.label && (
                <text
                  x={xt(k.t) + 4}
                  y={top - 10}
                  fontSize="11"
                  fill="var(--riscv-text-3)"
                  fontFamily={MONO}
                >
                  {k.label}
                </text>
              )}
            </g>
          ))}
          {lanes.map((l, i) => (
            <Lane
              key={l.id}
              lane={l}
              cy={top + i * laneH + 22}
              laneH={laneH}
              width={W}
              x={x}
              selected={pickable && l.members.includes(current)}
              onPick={pickable ? () => onPick(l.id) : null}
            />
          ))}
        </svg>
      </div>
    </section>
  );
}

function Lane({ lane, cy, laneH, width, x, selected, onPick }) {
  const s = lane.s;
  const landed = s.versions[0].date;
  const dates = placeDates([
    {
      at: x(s.release.date),
      text: month(s.release.date),
      fill: 'var(--riscv-success)',
      anchor: 'middle',
    },
    {
      at: x(s.commit.applied),
      text: month(s.commit.applied),
      fill: 'var(--riscv-violet)',
      anchor: 'middle',
    },
    {
      at: x(s.firstPatch),
      text: month(s.firstPatch),
      fill: 'var(--riscv-text-2)',
      anchor: 'start',
    },
    ...(landed !== s.firstPatch
      ? [{ at: x(landed), text: month(landed), fill: 'var(--riscv-gold)', anchor: 'middle' }]
      : []),
  ]);
  return (
    <g onClick={onPick ?? undefined} style={{ cursor: onPick ? 'pointer' : 'default' }}>
      <title>{`${lane.members.join(', ')}: ${s.title}`}</title>
      <rect
        x="0"
        y={cy - 19}
        width={width}
        height={laneH - 8}
        rx="8"
        fill={selected ? 'var(--riscv-gold-dim)' : 'transparent'}
      />
      <text
        x="12"
        y={cy + 4}
        fontSize="13"
        fontWeight="600"
        fill="var(--riscv-gold)"
        fontFamily={MONO}
      >
        {lane.label}
      </text>
      <rect
        x={x(s.firstPatch)}
        y={cy - 4}
        width={Math.max(2, x(s.release.date) - x(s.firstPatch))}
        height="8"
        rx="4"
        fill="var(--riscv-text-3)"
        opacity="0.55"
      />
      <circle cx={x(s.firstPatch)} cy={cy} r="4.5" fill="var(--riscv-text-2)">
        <title>{`First patch: ${s.firstPatch}`}</title>
      </circle>
      {s.earlier.map((e) => (
        <circle key={`${e.date}${e.title}`} cx={x(e.date)} cy={cy} r="3" fill="var(--riscv-text-3)">
          <title>{`${e.date} ${e.title} (${e.authors.join(', ')})`}</title>
        </circle>
      ))}
      <rect
        x={x(landed)}
        y={cy - 6}
        width={Math.max(4, x(s.commit.applied) - x(landed))}
        height="12"
        rx="4"
        fill="var(--riscv-gold)"
      >
        <title>{`${s.title}: ${landed} to ${s.commit.applied}`}</title>
      </rect>
      {s.versions.map((v) => (
        <rect
          key={`${v.version}${v.date}${v.author}`}
          x={x(v.date) - 0.75}
          y={cy - 6}
          width="1.5"
          height="12"
          fill="var(--riscv-bg)"
          opacity="0.85"
        >
          <title>{`${v.version} · ${v.date} · ${v.author}`}</title>
        </rect>
      ))}
      <rect
        x={x(s.commit.applied) - 1.5}
        y={cy - 11}
        width="3"
        height="22"
        fill="var(--riscv-violet)"
      />
      <rect
        x={x(s.release.date) - 4.5}
        y={cy - 4.5}
        width="9"
        height="9"
        rx="2"
        fill="var(--riscv-success)"
      />
      <text
        x={x(s.release.date) + 9}
        y={cy + 4}
        fontSize="11"
        fill="var(--riscv-text-2)"
        fontFamily={MONO}
      >
        {s.release.version}
      </text>
      {dates.map((d) => (
        <text
          key={`${d.text}${d.fill}`}
          x={d.at}
          y={cy + 22}
          fontSize="10"
          textAnchor={d.anchor}
          fill={d.fill}
          fontFamily={MONO}
        >
          {d.text}
        </text>
      ))}
    </g>
  );
}

function Stat({ value, label }) {
  return (
    <div
      className="rounded-lg px-3 py-2 border"
      style={{ background: 'var(--riscv-surface-2)', borderColor: 'var(--riscv-border)' }}
    >
      <div className="text-[17px] font-bold tabular-nums" style={{ color: 'var(--riscv-text)' }}>
        {value}
      </div>
      <div className="text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
        {label}
      </div>
    </div>
  );
}

const DOT = {
  earlier: { borderColor: 'var(--riscv-text-3)', background: 'var(--riscv-panel)' },
  landed: { borderColor: 'var(--riscv-gold)', background: 'var(--riscv-gold)' },
  applied: { borderColor: 'var(--riscv-violet)', background: 'var(--riscv-violet)' },
  release: {
    borderColor: 'var(--riscv-success)',
    background: 'var(--riscv-success)',
    borderRadius: 3,
  },
};

function TimelineRow({ it }) {
  return (
    <li className="relative pl-6 pb-2.5">
      <span
        className="absolute left-0.5 top-1 w-3 h-3 rounded-full border-2"
        style={DOT[it.kind]}
        aria-hidden="true"
      />
      <span
        className="font-mono text-[11px] mr-2 tabular-nums"
        style={{ color: 'var(--riscv-text-3)' }}
      >
        {it.date}
      </span>
      {it.href ? (
        <a
          href={it.href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono font-semibold underline underline-offset-2"
          style={{ color: 'var(--riscv-text)' }}
        >
          {it.text}
        </a>
      ) : (
        <span
          className={it.kind === 'earlier' ? '' : 'font-semibold'}
          style={{ color: it.kind === 'earlier' ? 'var(--riscv-text-2)' : 'var(--riscv-text)' }}
        >
          {it.text}
        </span>
      )}
      {it.sub && (
        <span className="text-[12px]" style={{ color: 'var(--riscv-text-3)' }}>
          {' '}
          · {it.sub}
        </span>
      )}
    </li>
  );
}

function Timeline({ h }) {
  const [all, setAll] = React.useState(false);
  const items = timelineItems(h);
  const landed = items.filter((i) => i.kind === 'landed');
  const hide = !all && landed.length > 8 ? new Set(landed.slice(3, -3)) : new Set();
  const rows = [];
  let shownToggle = false;
  let shownHeader = false;
  items.forEach((it, i) => {
    if (it.kind === 'landed' && !shownHeader) {
      shownHeader = true;
      if (i > 0)
        rows.push(
          <li
            key="hdr"
            className="text-[11px] -mt-1 mb-2 pl-6"
            style={{ color: 'var(--riscv-text-3)' }}
          >
            The series that landed: {h.title}
          </li>,
        );
    }
    if (hide.has(it)) {
      if (!shownToggle) {
        shownToggle = true;
        rows.push(
          <li key="more" className="pl-6 mb-2">
            <button
              type="button"
              onClick={() => setAll(true)}
              className="text-[12px] px-2 py-0.5 rounded border border-dashed"
              style={{ color: 'var(--riscv-text-2)', borderColor: 'var(--riscv-border-2)' }}
            >
              Show {hide.size} more versions
            </button>
          </li>,
        );
      }
      return;
    }
    rows.push(<TimelineRow key={`${it.kind}-${it.date}-${it.text}-${i}`} it={it} />);
  });
  return (
    <ol className="relative list-none m-0 p-0">
      <span
        className="absolute left-[7px] top-1.5 bottom-1.5 w-0.5"
        style={{ background: 'var(--riscv-border-2)' }}
        aria-hidden="true"
      />
      {rows}
    </ol>
  );
}

function People({ p, committer }) {
  const rows = [
    ['Author', [p.author]],
    ['Co-developed', p.coDevelopedBy],
    ['Series by', p.seriesAuthors.filter((a) => a !== p.author)],
    ['Reviewed', p.reviewedBy],
    ['Acked', p.ackedBy],
    ['Tested', p.testedBy],
    ['Applied by', [committer]],
  ].filter(([, list]) => list && list.length);
  return (
    <dl className="grid gap-1.5 m-0">
      {rows.map(([label, list]) => (
        <div
          key={label}
          className="grid gap-2"
          style={{ gridTemplateColumns: '96px minmax(0,1fr)' }}
        >
          <dt
            className="text-[10px] uppercase tracking-wider pt-1"
            style={{ color: 'var(--riscv-text-3)' }}
          >
            {label}
          </dt>
          <dd className="m-0 flex flex-wrap gap-1">
            {list.map((name) => (
              <span
                key={name}
                className="text-[12px] px-2 rounded-full border"
                style={{ borderColor: 'var(--riscv-border-2)', color: 'var(--riscv-text)' }}
              >
                {name}
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Citations({ list, byN }) {
  return (
    <sup>
      {list.split(',').map((n, i) => {
        const s = byN.get(Number(n.trim()));
        return (
          <React.Fragment key={n}>
            {i ? ',' : ''}
            {s ? (
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`${s.date} · ${s.from}`}
                className="font-mono"
                style={{ color: 'var(--riscv-violet)' }}
              >
                {n.trim()}
              </a>
            ) : (
              n.trim()
            )}
          </React.Fragment>
        );
      })}
    </sup>
  );
}

/** The summary text with [n] citations turned into links to the messages. */
function Summary({ ai, review }) {
  if (!ai)
    return (
      <p className="m-0 text-[12px]" style={{ color: 'var(--riscv-text-3)' }}>
        No summary of the review discussion yet; each version in the timeline links to its thread.
      </p>
    );
  const byN = new Map(ai.sources.map((s) => [s.n, s]));
  const parts = [];
  const re = /\[([\d,\s]+)\]|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(ai.summary))) {
    if (m.index > last) parts.push(ai.summary.slice(last, m.index));
    parts.push(
      m[2] ? (
        <code
          key={`c${m.index}`}
          className="font-mono text-[12px] px-1 rounded"
          style={{ background: 'var(--riscv-surface-2)' }}
        >
          {m[2]}
        </code>
      ) : (
        <Citations key={`s${m.index}`} list={m[1]} byN={byN} />
      ),
    );
    last = re.lastIndex;
  }
  parts.push(ai.summary.slice(last));
  return (
    <div
      className="rounded-xl border p-4"
      style={{ borderColor: 'var(--riscv-violet)', background: 'var(--riscv-violet-dim)' }}
    >
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] mb-2"
        style={{ color: 'var(--riscv-text-2)' }}
      >
        <span
          className="font-bold uppercase tracking-wider px-1.5 rounded border"
          style={{ color: 'var(--riscv-violet)', borderColor: 'var(--riscv-violet)' }}
        >
          AI summary
        </span>
        <span>
          Review discussion, {review.replies} replies from {review.people} people · {ai.generated}
        </span>
      </div>
      <p className="m-0 text-[13px] leading-relaxed" style={{ color: 'var(--riscv-text)' }}>
        {parts}
      </p>
      <details className="mt-2 text-[12px]" style={{ color: 'var(--riscv-text-3)' }}>
        <summary className="cursor-pointer">{byN.size} cited messages</summary>
        <ol className="list-none p-0 mt-1.5 grid gap-0.5">
          {ai.sources.map((s) => (
            <li key={s.n}>
              [{s.n}] {s.date} · {s.from} ·{' '}
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
                style={{ color: 'var(--riscv-text-2)' }}
              >
                lore
              </a>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function PickButton({ id, onPick }) {
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      className="font-mono text-[12px] px-2 py-0.5 rounded border hover:underline"
      style={{ color: 'var(--riscv-gold)', borderColor: 'var(--riscv-border-2)' }}
    >
      {id}
    </button>
  );
}

function BundlePart({ p, onPick }) {
  const h = historyIndex[p];
  const known = h && !h.listed && !h.parts;
  return (
    <div
      className="grid gap-x-4 gap-y-1 items-center rounded-lg border px-3 py-2"
      style={{
        gridTemplateColumns: 'minmax(64px, auto) minmax(0, 1fr) auto',
        borderColor: 'var(--riscv-border)',
        background: 'var(--riscv-surface-2)',
      }}
    >
      <span className="font-mono font-semibold" style={{ color: 'var(--riscv-gold)' }}>
        {p}
      </span>
      <span style={{ color: 'var(--riscv-text-2)' }}>
        {known
          ? `Linux ${h.release} · first patch ${month(h.firstPatch)} · ${plural(h.versions, 'version')} · ${h.replies} review replies${h.landedWith.length ? ` · landed with ${h.landedWith.join(', ')}` : ''}`
          : 'No history collected yet'}
      </span>
      {known ? (
        <button
          type="button"
          onClick={() => onPick(p)}
          className="font-semibold underline underline-offset-2 text-[12px]"
          style={{ color: 'var(--riscv-violet)' }}
        >
          View history
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/** A bundle has no history of its own: each part's, side by side. */
function BundleBody({ id, parts, onPick }) {
  const complete = bundleRelease(historyIndex, parts);
  return (
    <div className="grid gap-4">
      <p className="m-0" style={{ color: 'var(--riscv-text-2)' }}>
        Linux has no entry for {id} itself. It detects {id} through its parts, so {id} is available
        once all of them are{complete ? `: Linux ${complete}` : ''}.
      </p>
      <div className="grid gap-2">
        {parts.map((p) => (
          <BundlePart key={p} p={p} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

function HistoryBody({ h, landedWith, onPick }) {
  const landed = h.versions[0].date;
  return (
    <div className="grid gap-5">
      {landedWith.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" style={{ color: 'var(--riscv-text-2)' }}>
          <span>Landed in the same commit as</span>
          {landedWith.map((x) => (
            <PickButton key={x} id={x} onPick={onPick} />
          ))}
          <span className="text-[12px]" style={{ color: 'var(--riscv-text-3)' }}>
            They share this history.
          </span>
        </div>
      )}
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
      >
        <Stat value={`Linux ${h.release.version}`} label={`released ${h.release.date}`} />
        <Stat value={span(h.firstPatch, h.release.date)} label="first patch to release" />
        <Stat
          value={span(landed, h.commit.applied)}
          label="landed series, first posting to applied"
        />
        <Stat
          value={h.versions.length}
          label={
            h.partial
              ? 'versions found; the archive lacks the rest'
              : 'versions found of the landed series'
          }
        />
        <Stat value={h.review.replies} label={`review replies, ${h.review.people} people`} />
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <section className="min-w-0">
          <h3 className={SECTION} style={{ color: 'var(--riscv-text-3)' }}>
            Timeline
          </h3>
          <Timeline h={h} />
        </section>
        <section className="min-w-0 grid gap-5 content-start">
          <div>
            <h3 className={SECTION} style={{ color: 'var(--riscv-text-3)' }}>
              People
            </h3>
            <People p={h.people} committer={h.commit.committer} />
          </div>
          <Summary ai={h.ai} review={h.review} />
        </section>
      </div>
      <p className="m-0 text-[11px]" style={{ color: 'var(--riscv-text-3)' }}>
        Dates, people and counts come from git and the linux-riscv archive. The summary is written
        by an AI model from the review messages; each number links to the message it rests on.
      </p>
    </div>
  );
}
