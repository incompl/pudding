// Row windowing (virtual scrolling) for long, uniform-height lists: render only
// the rows in (or near) the viewport over a full-height spacer, so a list of tens
// of thousands of tracks costs a screenful of DOM nodes instead of one per row.
//
// Native scroll is preserved by construction. The container is a real block in the
// page's own scroll pane, sized to the full list height, so the scrollbar geometry,
// touchpad inertia, and scroll position are exactly what a fully-built list would
// produce — only the off-screen rows are absent. Rows must be uniform height (row i
// is placed at i * rowHeight); the caller guarantees that. Row height is measured
// once from a real row (so it tracks the app font size) and snapped to a whole
// device pixel, so row boundaries never straddle a subpixel and shimmer as the list
// scrolls.
//
// Smoothness rules the hot path: the mounted rows ride the native scroll (they're
// absolutely placed inside the container, which the browser translates on the GPU),
// so between remounts there is zero JS. The scroll listener only schedules a single
// requestAnimationFrame and reads scrollTop — no getBoundingClientRect on the hot
// path, so a trackpad's flood of scroll events can't force synchronous layout and
// stutter. The container's offset within the scroll pane is measured once (and on
// resize), since nothing above the list changes height while it scrolls.
//
// Used by the flat leaf track lists (Songs etc.) and the Browse folder tree (whose
// visible rows are flattened to a linear array, so a huge folder windows the same
// way). It deliberately does the plainest thing that works: rebuild the row block
// whenever the visible range changes, with per-row listeners re-created each time
// (cheap at a screenful of rows). No event delegation, no recycling pool.
//
// `count` may be a function so a caller whose length changes (the tree, when a
// folder expands/collapses) can call `update()` to resize + repaint in place —
// keeping the measured row height and scroll position, so there's no reflash.

export interface WindowedList {
  el: HTMLElement;
  // Re-read the count, resize the spacer, and force a repaint of the visible slice
  // without tearing down — for a list whose length changed (a tree folder toggled).
  update(): void;
  // Scroll the row at `index` to the top of the viewport, minus `margin` px (to
  // clear a sticky header sitting above the list). Waits for the first layout/
  // measure if it hasn't happened yet.
  scrollToIndex(index: number, margin?: number): void;
  // Scroll the row at `index` *just* into view if it isn't already (the windowed
  // equivalent of scrollIntoView({ block: "nearest" })) — a no-op when the row is
  // already fully visible, so it keeps e.g. a playing row on screen as it advances
  // without yanking the list on every step. `margin` reserves px at the top edge.
  revealIndex(index: number, margin?: number): void;
  // Paint the first row slice synchronously, now, instead of waiting for the first
  // animation frame. Call right after inserting `el` into a *visible* container so
  // the rows exist on the same tick the caller built them (no one-frame blank flash,
  // and DOM-driving code — tests, a click synthesized straight after a render — sees
  // the rows immediately). A no-op if the container isn't laid out yet; the normal
  // rAF path still fires as the fallback.
  flush(): void;
}

// Walk up from a connected element to the nearest scrolling ancestor, so the
// window can read the right scrollTop/clientHeight without the caller naming it.
// (display:contents wrappers report overflow:visible and are skipped correctly.)
function findScrollParent(el: HTMLElement): HTMLElement {
  let p = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
    p = p.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

// Returns a handle whose `el` the caller inserts into the DOM. It self-tears-down
// (drops its scroll and resize listeners) the first time it's painted while
// detached — i.e. once the caller has navigated away and dropped it from the tree —
// so there's no explicit destroy() to thread through the nav machinery.
export function windowedList(opts: {
  count: number | (() => number);
  overscan?: number;
  // Builds row `index` fresh, including any state it reads at build time (e.g. the
  // selected highlight). Called on every (re)mount as the window scrolls.
  renderRow: (index: number) => HTMLElement;
}): WindowedList {
  const { renderRow } = opts;
  const getCount = typeof opts.count === "function" ? opts.count : () => opts.count as number;
  const overscan = opts.overscan ?? 6;

  const container = document.createElement("div");
  container.style.position = "relative";
  container.style.width = "100%";
  // Don't let scroll anchoring nudge scrollTop by a pixel when we swap the mounted
  // rows mid-scroll — that nudge is exactly the jitter windowing must avoid.
  container.style.overflowAnchor = "none";

  let scrollParent: HTMLElement | null = null;
  let rowHeight = 0;
  // The container's top in the scroll pane's content coordinates (scrollTop space).
  // Stable while the list scrolls (nothing above it changes height), so it's cached
  // and only refreshed on measure/resize — keeping the scroll hot path layout-free.
  let listOffset = 0;
  let offsetMeasured = false;
  let mountedFirst = -1;
  let mountedLast = -1;
  let retries = 0;
  let frame = 0;

  // Measure the uniform row height once, from a real (hidden) probe row, then snap
  // it up to a whole pixel so every slot lands on a device pixel. Needs the
  // container to be connected and laid out; returns false (to retry) until then.
  function ensureRowHeight(): boolean {
    if (rowHeight > 0) return true;
    if (getCount() === 0 || !container.isConnected) return false;
    const probe = renderRow(0);
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    container.appendChild(probe);
    const measured = probe.getBoundingClientRect().height;
    probe.remove();
    if (measured <= 0) return false;
    // Ceil so a fractional natural height never clips; every slot is this exact
    // integer, and rows are pinned to it (see paint) so nothing drifts over 10k rows.
    rowHeight = Math.ceil(measured);
    container.style.height = `${getCount() * rowHeight}px`;
    return true;
  }

  // Recompute the container's offset within the scroll pane. Cheap-but-syncs-layout,
  // so it runs only off the hot path (first paint, resize).
  function measureOffset(): void {
    const parent = scrollParent!;
    listOffset =
      container.getBoundingClientRect().top -
      parent.getBoundingClientRect().top +
      parent.scrollTop;
  }

  function visibleRange(): [number, number] {
    const parent = scrollParent!;
    const count = getCount();
    // How far the list's top is scrolled above the viewport's top edge — read from
    // scrollTop alone (no layout flush) against the cached offset.
    const above = parent.scrollTop - listOffset;
    const first = Math.max(0, Math.floor(above / rowHeight) - overscan);
    const last = Math.min(
      count - 1,
      Math.ceil((above + parent.clientHeight) / rowHeight) + overscan,
    );
    return [first, last];
  }

  function paint(): void {
    frame = 0;
    // Detached: navigated away. Stop listening and let the node be collected.
    if (!container.isConnected) {
      teardown();
      return;
    }
    const parent = resolveScrollParent();
    if (!ensureRowHeight()) {
      // Connected but not laid out yet — try again next frame, bounded so a list
      // that never gets a box (0 height) doesn't spin forever.
      if (retries++ < 10) requestAnimationFrame(paint);
      return;
    }
    // Connected but currently hidden (an ancestor is display:none — e.g. the list
    // face is swapped out for the now-playing hero). The scroll pane has no box, so
    // visibleRange would read clientHeight 0 and compute an empty slice, blanking
    // the list. Bail WITHOUT touching the mounted rows or range, so flipping the
    // face back shows the last-good slice intact. The ResizeObserver re-schedules a
    // paint when the box returns (display:none → laid out fires a resize).
    if (parent.clientHeight === 0) return;
    // Measure the list's offset once it's laid out (and after a resize), off the
    // scroll hot path — visibleRange then reads only scrollTop against it.
    if (!offsetMeasured) {
      measureOffset();
      offsetMeasured = true;
    }
    const [first, last] = visibleRange();
    if (first === mountedFirst && last === mountedLast) return;
    mountedFirst = first;
    mountedLast = last;
    container.replaceChildren();
    for (let i = first; i <= last; i++) {
      const row = renderRow(i);
      row.style.position = "absolute";
      row.style.top = `${i * rowHeight}px`;
      row.style.left = "0";
      row.style.right = "0";
      // Pin the row to the exact slot height so its box lands on device pixels
      // (crisp boundaries, no subpixel shimmer while scrolling). border-box so
      // this height *is* the border-box: otherwise a row with vertical padding
      // (content-box default) overflows its slot and overlaps the next row, whose
      // semi-transparent hover/selection fill then blends into a stray band.
      row.style.boxSizing = "border-box";
      row.style.height = `${rowHeight}px`;
      container.appendChild(row);
    }
  }

  // Coalesce the scroll-event flood into one recompute per frame; the hot path never
  // flushes layout, so native scroll stays smooth.
  function schedule(): void {
    if (frame === 0) frame = requestAnimationFrame(paint);
  }

  // A resize can change how many rows fit and shift the list's offset, so remeasure
  // before repainting.
  function onResize(): void {
    if (!container.isConnected) {
      teardown();
      return;
    }
    // Force a re-measure of the offset (paint does it) — a resize can shift it.
    offsetMeasured = false;
    schedule();
  }

  function teardown(): void {
    if (frame !== 0) cancelAnimationFrame(frame);
    if (scrollParent) scrollParent.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", onResize);
    ro.disconnect();
  }

  // Re-drives paint when the scroll pane gains or loses its box — notably the
  // display:none → laid-out transition when the list face is swapped back in for the
  // now-playing hero. paint() bails while hidden (preserving the mounted slice), so
  // this is what brings it back once the box returns; it also covers a resize that
  // shifts the offset. Observes the scroll pane, NOT our own container: paint writes
  // container.style.height, which would otherwise feed back as a resize and loop.
  const ro = new ResizeObserver(() => {
    if (!container.isConnected) {
      teardown();
      return;
    }
    offsetMeasured = false;
    schedule();
  });

  // Resolve the scrolling ancestor once (needs the container connected), wiring its
  // scroll listener and the resize observer together so both attach exactly once.
  function resolveScrollParent(): HTMLElement {
    if (!scrollParent) {
      scrollParent = findScrollParent(container);
      scrollParent.addEventListener("scroll", schedule, { passive: true });
      ro.observe(scrollParent);
    }
    return scrollParent;
  }

  // The count changed (a tree folder expanded/collapsed): resize the spacer to the
  // new height and force a repaint of the visible slice. Keeps rowHeight and the
  // scroll position, so the rows above the toggle don't move and there's no reflash.
  function update(): void {
    if (!container.isConnected) return;
    if (rowHeight > 0) container.style.height = `${getCount() * rowHeight}px`;
    mountedFirst = -1;
    mountedLast = -1;
    schedule();
  }

  // Scroll row `index` to the top (minus `margin` for a sticky header). The window
  // may not have measured yet (first paint is a frame away), so retry until it has.
  function scrollToIndex(index: number, margin = 0): void {
    let tries = 0;
    const go = (): void => {
      if (!container.isConnected) return;
      const parent = resolveScrollParent();
      if (!ensureRowHeight()) {
        if (tries++ < 30) requestAnimationFrame(go);
        return;
      }
      // Hidden (no box): the scroll would run against a 0-height pane. Skip it —
      // renderQueue re-issues the reveal when the list face flips back into view.
      if (parent.clientHeight === 0) return;
      if (!offsetMeasured) {
        measureOffset();
        offsetMeasured = true;
      }
      parent.scrollTop = Math.max(0, listOffset + index * rowHeight - margin);
      schedule();
    };
    requestAnimationFrame(go);
  }

  // Bring row `index` just into view (block:nearest): scroll up only if it sits
  // above the viewport, down only if it sits below, and do nothing when it's
  // already visible. Same ready-gating as scrollToIndex.
  function revealIndex(index: number, margin = 0): void {
    let tries = 0;
    const go = (): void => {
      if (!container.isConnected) return;
      const parent = resolveScrollParent();
      if (!ensureRowHeight()) {
        if (tries++ < 30) requestAnimationFrame(go);
        return;
      }
      // Hidden (no box): a reveal against a 0-height pane would corrupt scrollTop.
      // Skip it — renderQueue re-issues the reveal when the face flips back.
      if (parent.clientHeight === 0) return;
      if (!offsetMeasured) {
        measureOffset();
        offsetMeasured = true;
      }
      const rowTop = listOffset + index * rowHeight;
      const rowBottom = rowTop + rowHeight;
      if (rowTop < parent.scrollTop + margin) {
        parent.scrollTop = Math.max(0, rowTop - margin);
        schedule();
      } else if (rowBottom > parent.scrollTop + parent.clientHeight) {
        parent.scrollTop = rowBottom - parent.clientHeight;
        schedule();
      }
    };
    requestAnimationFrame(go);
  }

  // Wire the scroll listener (once) and paint. Run on the first animation frame, and
  // optionally synchronously via flush() the moment the caller has inserted a visible
  // container — paint() measures the row height by forcing layout, so it mounts rows
  // there and then rather than a frame later.
  function start(): void {
    if (container.isConnected) resolveScrollParent();
    paint();
  }

  window.addEventListener("resize", onResize);
  // The container isn't in the DOM yet (the caller inserts what we return), so the
  // first paint waits a frame for layout unless flush() primes it first.
  requestAnimationFrame(start);

  return { el: container, update, scrollToIndex, revealIndex, flush: start };
}
