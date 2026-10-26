import React from 'react';

/*
 * The Ask AI glyph: a speech bubble with two sparkles, drawn from the artwork
 * supplied for the launcher (navy #0E3061, orange #F68728). The chip behind it
 * is the navy tile and the label under it is the wording, so "Ask AI" stays
 * live text that zooms, translates and reads out like the rest of the page.
 *
 * Inline SVG rather than the supplied PNG: it stays sharp at any zoom, adds no
 * request, and the build has no copy plugin for a file in public/ anyway.
 * The kapa modal header shows the same glyph on a navy tile
 * (data-project-logo in public/index.html); change both together.
 */
const SPARKLE = (cx, cy, r) => {
  const k = r * 0.2;
  return (
    `M${cx} ${cy - r}Q${cx + k} ${cy - k} ${cx + r} ${cy}` +
    `Q${cx + k} ${cy + k} ${cx} ${cy + r}Q${cx - k} ${cy + k} ${cx - r} ${cy}` +
    `Q${cx - k} ${cy - k} ${cx} ${cy - r}Z`
  );
};

function AskAiGlyph() {
  return (
    <svg
      className="ask-ai-btn__icon"
      viewBox="0 0 56 48"
      width="38"
      height="33"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="#ffffff" stroke="#ffffff" strokeWidth="1.2" strokeLinejoin="round">
        <rect x="1" y="17" width="41" height="25" rx="10" />
        <path d="M3.5 35 1.2 46.8 13 41Z" />
      </g>
      <g fill="#0E3061">
        <circle cx="11.5" cy="29.5" r="3.3" />
        <circle cx="21.5" cy="29.5" r="3.3" />
        <circle cx="31.5" cy="29.5" r="3.3" />
      </g>
      <path fill="#F68728" d={SPARKLE(39.6, 9.3, 8.8) + SPARKLE(49.9, 18.6, 5.9)} />
    </svg>
  );
}

const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
const LS_KEY = 'riscv-ai-corner';

/*
 * kapa publishes window.Kapa in two steps: the bundle first installs a Proxy
 * over a stub, then registers open/close/render/... onto it. Truthiness of
 * window.Kapa therefore does NOT mean window.Kapa.open exists - a click landing
 * between the two throws "window.Kapa.open is not a function". Probe the method
 * itself, and gate rendering on it so a blocked or failed script leaves no
 * button rather than one that silently does nothing when clicked.
 */

function kapaOpenReady() {
  return typeof window.Kapa?.open === 'function';
}

function cornerStyle(corner) {
  const m = 24; // margin from screen edge (px)
  switch (corner) {
    case 'top-left':
      return { top: m, left: m };
    case 'top-right':
      return { top: m, right: m };
    case 'bottom-left':
      return { bottom: m, left: m };
    default:
      return { bottom: m, right: m }; // bottom-right
  }
}

function nearestCorner(x, y) {
  const h = x < window.innerWidth / 2 ? 'left' : 'right';
  const v = y < window.innerHeight / 2 ? 'top' : 'bottom';
  return `${v}-${h}`;
}

const AskAiLauncher = ({ context = null }) => {
  const [corner, setCorner] = React.useState(() => {
    try {
      const saved = window.localStorage.getItem(LS_KEY);
      if (CORNERS.includes(saved)) return saved;
    } catch {
      // localStorage can throw when cookies are blocked; fall through.
    }
    return 'bottom-right';
  });

  const [dragging, setDragging] = React.useState(false);
  const [dragPos, setDragPos] = React.useState(null);
  const [kapaReady, setKapaReady] = React.useState(kapaOpenReady);
  const [buzzing, setBuzzing] = React.useState(false);

  /*
   * Buzz once when the launcher becomes contextual, so a reader who has just
   * opened an extension notices the assistant can now answer about it.
   *
   * Keyed on the query rather than a boolean, so moving from Zba to Zbb buzzes
   * again: that is a new thing to ask about. Clearing the selection does not
   * buzz, because there is nothing to draw attention to.
   *
   * Cleared on a timer rather than animationend: animationend never fires under
   * prefers-reduced-motion, where the animation is suppressed, and the class
   * would then stay on forever holding its accent border.
   */
  React.useEffect(() => {
    // Clearing the selection must also clear the class. Returning early without
    // resetting left the chip stuck mid-buzz — holding its accent border and
    // refusing to animate again — whenever the context went away inside the
    // 700ms window.
    if (!context?.query) {
      setBuzzing(false);
      return undefined;
    }
    /*
     * Drop the class before re-adding it. Going Zba -> Zbb while the previous
     * buzz is still running leaves ask-ai-btn--buzz continuously applied, and a
     * CSS animation only restarts when the class is actually removed and put
     * back. Without the frame in between, the second selection silently does
     * not buzz.
     */
    setBuzzing(false);
    let timeoutId;
    const frameId = requestAnimationFrame(() => {
      setBuzzing(true);
      timeoutId = setTimeout(() => setBuzzing(false), 700);
    });
    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(timeoutId);
    };
  }, [context?.query]);

  const dragStartRef = React.useRef(null);

  React.useEffect(() => {
    if (kapaOpenReady()) {
      setKapaReady(true);
      return undefined;
    }
    /*
     * Give up after MAX_POLLS. An unbounded interval runs forever whenever the
     * script never arrives - an ad blocker, a CSP rule, an offline tab - which
     * leaks a timer in the browser and, worse, hangs `npm test`: render-smoke
     * mounts the real bundle in jsdom with runScripts 'outside-only', so kapa
     * never executes, the timer never stops and the test file never exits.
     */
    const MAX_POLLS = 60; // 60 x 250ms = 15s, generous for an async CDN script
    let polls = 0;
    const id = setInterval(() => {
      if (kapaOpenReady()) {
        setKapaReady(true);
        clearInterval(id);
      } else if (++polls >= MAX_POLLS) {
        clearInterval(id);
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  const openKapa = React.useCallback(() => {
    if (!kapaOpenReady()) return;
    // `query` pre-fills kapa's box and `submit` sends it, so a reader who
    // clicked "Ask AI" with Zba open gets the answer rather than a form to
    // press enter on. Without a selection there is nothing to ask, so the
    // modal opens empty and waits.
    // Whether to send is the caller's decision: an extension or instruction is
    // a clean single question worth asking outright, while the builder opens a
    // sentence for the reader to finish.
    const args = context?.query
      ? { mode: 'ai', query: context.query, submit: Boolean(context.submit) }
      : { mode: 'ai' };

    /*
     * Plain open, no lifecycle games.
     *
     * An unmount()/render() cycle on every click was tried, to force a fresh
     * conversation. It coincided with kapa answering "We noticed unusual
     * activity. Please try asking your question again." — its bot protection.
     * That is unsurprising in hindsight: tearing down and recreating the widget
     * on every press also tears down the reCAPTCHA context it is protected by,
     * and rapid remount-then-submit is exactly what automated abuse looks like.
     *
     * Fresh conversations are not worth breaking the assistant for. kapa
     * exposes no supported reset (docs list only open/close/render/unmount and
     * setSourceGroupIDs); asking them for one is the route, not remounting.
     */
    window.Kapa.open(args);
  }, [context]);

  const onPointerDown = React.useCallback((e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Measure once per drag so the ghost keeps centring on the cursor even if
    // the chip is resized in CSS.
    const rect = e.currentTarget.getBoundingClientRect();
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      halfW: rect.width / 2,
      halfH: rect.height / 2,
      moved: false,
    };
  }, []);

  const onPointerMove = React.useCallback((e) => {
    const ds = dragStartRef.current;
    if (!ds) return;
    const dx = Math.abs(e.clientX - ds.startX);
    const dy = Math.abs(e.clientY - ds.startY);
    if (!ds.moved && dx < 6 && dy < 6) return;
    ds.moved = true;
    setDragging(true);
    setDragPos({ x: e.clientX, y: e.clientY, halfW: ds.halfW, halfH: ds.halfH });
  }, []);

  const onPointerUp = React.useCallback(
    (e) => {
      const ds = dragStartRef.current;
      dragStartRef.current = null;
      if (!ds) return;
      if (ds.moved) {
        const snapped = nearestCorner(e.clientX, e.clientY);
        setCorner(snapped);
        try {
          window.localStorage.setItem(LS_KEY, snapped);
        } catch {
          // Persisting the corner is best-effort.
        }
      } else {
        openKapa();
      }
      // Drop straight out of drag state. The corner change remounts the chip
      // (see key={corner}) which replays the settle animation; deferring this
      // on a timer only stranded a callback that could fire mid-next-drag.
      setDragging(false);
      setDragPos(null);
    },
    [openKapa],
  );

  const posStyle = dragPos
    ? {
        position: 'fixed',
        left: dragPos.x - dragPos.halfW,
        top: dragPos.y - dragPos.halfH,
        right: 'auto',
        bottom: 'auto',
        zIndex: 10001,
      }
    : { position: 'fixed', zIndex: 10000, ...cornerStyle(corner) };

  if (!kapaReady) return null;

  return (
    <>
      {dragging && dragPos && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 9999, pointerEvents: 'none' }}
          aria-hidden="true"
        >
          {CORNERS.map((c) => {
            const active = c === nearestCorner(dragPos.x, dragPos.y);
            return (
              <div
                key={c}
                className={`ask-ai-snap-hint${active ? ' ask-ai-snap-hint--active' : ''}`}
                style={{ position: 'absolute', ...cornerStyle(c) }}
              />
            );
          })}
        </div>
      )}

      <div
        key={corner}
        className={`ask-ai-launcher${dragging ? ' ask-ai-launcher--dragging' : ''}`}
        style={posStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragStartRef.current = null;
          setDragging(false);
          setDragPos(null);
        }}
      >
        <button
          className={`ask-ai-btn${dragging ? ' ask-ai-btn--dragging' : ''}${
            buzzing && !dragging ? ' ask-ai-btn--buzz' : ''
          }`}
          aria-label="Ask AI Assistant"
          title="Ask AI — Click to open, drag to move"
          onClick={(e) => e.stopPropagation()}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openKapa();
            }
          }}
        >
          <AskAiGlyph />
          <span className="ask-ai-btn__label">Ask AI</span>
        </button>
      </div>
    </>
  );
};

export default AskAiLauncher;
