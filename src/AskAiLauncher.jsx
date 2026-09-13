import React from 'react';

/*
 * The official RISC-V mark, byte-identical to the data-project-logo handed to
 * kapa in public/index.html, so the launcher and the modal header show the same
 * artwork. Inlined as a data URI for the same reason the favicon is: the build
 * has no copy plugin. The mark is not ours to redraw - do not substitute a
 * derivative, recolour it, or resample it.
 */
const RISCV_MARK =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%22-16%20-16%20109%20109%22%3E%3Crect%20x%3D%22-16%22%20y%3D%22-16%22%20width%3D%22109%22%20height%3D%22109%22%20rx%3D%2224%22%20fill%3D%22%232C356D%22%2F%3E%3Cpath%20d%3D%22M42.853%2023.963c0%2011.134-6.752%2021.253-19.904%2023.623l18.554%2021.928%201.678-2.354%2033.414-47.25V.005H22.273c13.828%201.35%2020.58%2012.818%2020.58%2023.958%22%20fill%3D%22%23F4B01B%22%2F%3E%3Cpath%20d%3D%22M52.292%2073.221l24.631-34.417V76.6h-27.1zM4.728%2037.455h12.818c9.44%200%2014.172-6.74%2014.172-13.492%200-6.758-4.732-13.165-14.172-13.165H0V76.6h32.738L4.728%2042.858v-5.403M189.29%2012.823h11.138v52.309h-11.139v-52.31m77.507%2040.863l-57.933-.033v11.48h58.37c4.383%200%208.107-1.696%2011.139-4.728%203.033-3.03%204.728-6.752%204.728-11.135s-1.695-8.09-4.728-11.14c-3.032-3.032-6.756-4.71-11.139-4.71l-42.462-.318a4.581%204.581%200%2001-4.547-4.547%204.582%204.582%200%20014.577-4.549l58.299-.042v-11.14h-58.373c-4.399%200-8.107%201.696-11.135%204.728-3.032%203.033-4.73%206.757-4.73%2011.14%200%204.381%201.698%208.09%204.73%2011.134%203.028%203.033%206.736%204.382%2011.135%204.382l42.414.002a4.549%204.549%200%20014.55%204.566%204.893%204.893%200%2001-4.895%204.91m47.677-40.862h48.255v11.14h-48.255c-4.037%200-7.416%201.332-10.465%204.382-3.033%203.032-4.381%206.407-4.381%2010.46%200%204.036%201.348%207.415%204.381%2010.464%203.05%203.028%206.428%204.383%2010.465%204.383h48.255l-.003%2011.48h-48.228c-7.085%200-13.176-2.716-18.249-7.774-5.057-5.061-7.416-11.138-7.416-18.224%200-7.082%202.359-13.164%207.416-18.22%205.073-5.387%2011.139-8.091%2018.225-8.091M181.199%2065.132L166.353%2044.54c4.036-.334%207.415-1.683%2010.119-4.716%203.032-3.045%204.727-6.753%204.727-11.134%200-4.383-1.695-8.107-4.727-11.14-3.033-3.032-6.757-4.728-11.14-4.728h-58.374v52.309h11.14V44.54h34.417l14.846%2020.59zM164.665%2033.83l-46.567-.083v-9.439l47.03-.095a4.6%204.6%200%20014.608%204.577%205.062%205.062%200%2001-5.07%205.04%22%20fill%3D%22%23ffffff%22%2F%3E%3Cpath%20d%3D%22M418.399%2065.132l-30.567-52.31h13.084l23.892%2041.503%2023.907-41.502h12.882l-30.381%2052.309m-61.732-31.055h21.93v10.13h-21.93v-10.13%22%20fill%3D%22%23F4B01B%22%2F%3E%3Cpath%20d%3D%22M473.564%2020.822h.88c1.03%200%201.861-.342%201.861-1.174%200-.734-.538-1.224-1.713-1.224-.49%200-.832.049-1.028.098zm-.05%204.553h-1.86v-8.028c.735-.146%201.763-.244%203.085-.244%201.517%200%202.202.244%202.79.587.44.343.782.979.782%201.762%200%20.882-.684%201.567-1.664%201.86v.098c.784.293%201.224.881%201.469%201.958.245%201.224.392%201.714.587%202.007h-2.007c-.244-.293-.39-1.028-.636-1.958-.147-.881-.636-1.273-1.664-1.273h-.881zm-4.943-4.21c0%203.574%202.642%206.413%206.265%206.413%203.525%200%206.119-2.84%206.119-6.363%200-3.574-2.594-6.462-6.167-6.462-3.575%200-6.217%202.888-6.217%206.413zm14.44%200c0%204.553-3.574%208.126-8.223%208.126-4.601%200-8.273-3.573-8.273-8.125%200-4.455%203.672-8.029%208.273-8.029%204.65%200%208.223%203.574%208.223%208.029%22%20fill%3D%22%23ffffff%22%2F%3E%3C%2Fsvg%3E';

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
          <img
            src={RISCV_MARK}
            alt=""
            width="30"
            height="30"
            className="ask-ai-btn__icon"
            draggable={false}
          />
          <span className="ask-ai-btn__label">Ask AI</span>
        </button>
      </div>
    </>
  );
};

export default AskAiLauncher;
