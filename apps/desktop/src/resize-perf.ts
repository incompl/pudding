// Resize profiler — turns "resizing feels slow" into a per-drag ledger: which
// reaction to the resize ate the frame, how many frames were dropped, and how
// much of the freeze nothing in JS accounts for.
//
// A window resize is a *burst*: WKWebView fires `resize` (and ResizeObserver)
// many times a second while the mouse is down, and every listener runs
// synchronously inside that event. So the thing to measure is never one call,
// it's the whole drag:
//   1. Reactions: resizeProbe() wraps a resize listener and records its
//      synchronous wall time per burst, by label. A layout read inside a
//      listener (scrollWidth, getBoundingClientRect) forces a style+layout
//      flush, so a probe's time includes the layout it provoked — which is
//      exactly what we want to see.
//   2. IPC: resizeAsync() records the round-trip of a command fired from a
//      resize listener. set_miniplayer_checked lands on the Rust main thread,
//      which is also the thread AppKit is resizing the window on, so a
//      ballooning round trip is itself the finding.
//   3. Dropped frames: a requestAnimationFrame watchdog measures the gap
//      between frames across the burst. Blocked time that the probes don't add
//      up to is layout, paint, compositing or native-side work, and the report
//      says so rather than leaving it implied.
//
// One drag produces one report, flushed once the resize settles (no events for
// SETTLE_MS) — not 300 interleaved lines.
//
// Output goes to the console *and* through tauri-plugin-log to the app log file
// (~/Library/Logs/com.incompl.pudding/Pudding.log), because a resize can't be
// watched in the Web Inspector while the mouse owns the window: the log file is
// the only place the report can be read after the fact.
//
// On by default in a dev build; in a release build set
// `localStorage.puddingResizePerf = "1"` and reload. While disabled every probe
// is a pass-through that costs one branch, so the call sites stay wired up for
// the next time resize timing needs a look (same deal as perf.ts for boot).

import { info } from "@tauri-apps/plugin-log";

const ENABLED = (() => {
  try {
    // `import.meta.env` is Vite's; it's undefined when a unit test imports a
    // module that pulls this one in under plain node, hence the optional read.
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) return true;
    return localStorage.getItem("puddingResizePerf") === "1";
  } catch {
    return false;
  }
})();

// Quiet period that ends a drag. Longer than the 400ms size-persist debounce so
// the persist write (and its isMaximized IPC) lands inside the burst it belongs
// to instead of opening a second, one-event burst.
const SETTLE_MS = 600;

// A frame gap beyond two 60Hz frames means at least one frame was dropped.
const FRAME_BUDGET_MS = 32;

// WKWebView clamps performance.now() to 1ms (an anti-fingerprinting measure),
// so a single sub-millisecond probe reads 0.0 or 1.0 — never 0.4. The rounding
// is unbiased (a 0.4ms span lands on a tick 40% of the time), so per-burst
// TOTALS over dozens of calls are sound; a single call's max is not. Read the
// totals column, not the max, for anything cheap.
type Tally = { n: number; total: number; max: number };

const sync = new Map<string, Tally>();
const asyncIpc = new Map<string, Tally>();
const counts = new Map<string, number>();

let burstStart = 0;
let events = 0;
let frames = 0;
let blocked = 0;
let longestGap = 0;
let lastFrame = 0;
let watching = false;
let settle: ReturnType<typeof setTimeout> | undefined;

function tally(into: Map<string, Tally>, label: string, ms: number): void {
  const t = into.get(label) ?? { n: 0, total: 0, max: 0 };
  t.n++;
  t.total += ms;
  if (ms > t.max) t.max = ms;
  into.set(label, t);
}

// A burst is opened ONLY by a real window resize event. This matters: the
// windowed lists repaint from a ResizeObserver and from rAF on the scroll hot
// path too, so letting any probe open a burst reported every scroll as a
// phantom drag ("0 resize events") and buried the real ones.
function openBurst(): void {
  if (burstStart !== 0) return;
  burstStart = performance.now();
  frames = 0;
  blocked = 0;
  longestGap = 0;
  events = 0;
  sync.clear();
  asyncIpc.clear();
  counts.clear();
  startWatchdog();
}

// Keep the open burst alive. Reactions that land after the last resize event
// (a rAF paint, an IPC reply) extend it, so they're attributed to the drag that
// caused them — but they can't conjure one.
function extend(): void {
  if (burstStart === 0) return;
  clearTimeout(settle);
  settle = setTimeout(report, SETTLE_MS);
}

// One watchdog loop per burst. The generation token matters because report()
// can stop the loop while a tick is already queued: without it, the next burst
// started a second loop alongside the stale one and the two double-counted
// frames (or the stale one swallowed the new burst's first frames and the
// report claimed 0 painted).
let generation = 0;

function startWatchdog(): void {
  const mine = ++generation;
  watching = true;
  lastFrame = performance.now();
  const tick = (): void => {
    if (!watching || mine !== generation) return;
    const now = performance.now();
    const gap = now - lastFrame;
    frames++;
    if (gap > FRAME_BUDGET_MS) {
      blocked += gap;
      if (gap > longestGap) longestGap = gap;
    }
    lastFrame = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Wrap a resize listener so each call's synchronous time is attributed to the
// drag it ran in. Returns the function unchanged when the profiler is off.
export function resizeProbe<A extends unknown[]>(
  label: string,
  fn: (...args: A) => void,
): (...args: A) => void {
  if (!ENABLED) return fn;
  return (...args: A) => {
    if (burstStart === 0) return fn(...args);
    extend();
    const start = performance.now();
    try {
      fn(...args);
    } finally {
      tally(sync, label, performance.now() - start);
    }
  };
}

// Time an async call made from a resize reaction (an `invoke`): the interesting
// number is the round trip, not the microseconds spent handing it off.
export function resizeAsync<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!ENABLED || burstStart === 0) return run();
  extend();
  const start = performance.now();
  const done = (): void => tally(asyncIpc, label, performance.now() - start);
  return run().then(
    (v) => {
      done();
      return v;
    },
    (e) => {
      done();
      throw e;
    },
  );
}

// Add to a running total for the burst — for volumes rather than durations, e.g.
// how many rows the windowed lists rebuilt across one drag.
export function resizeCount(label: string, n: number): void {
  if (!ENABLED || burstStart === 0) return;
  counts.set(label, (counts.get(label) ?? 0) + n);
}

// Count the raw resize events, independent of which listeners happen to be
// probed. Capture phase so the count is taken before any reaction runs. Call
// once from init; a no-op when disabled.
export function armResizeProfiler(): void {
  if (!ENABLED) return;
  // Announce into the log file on arming. Two jobs: it timestamps which page
  // load the following reports belong to, and it proves the log channel works
  // at all — if a drag produces no report, this line says whether the profiler
  // was even live, which the console can't tell us after the fact.
  void info("[resize] profiler armed").catch(() => {});
  window.addEventListener(
    "resize",
    () => {
      openBurst();
      extend();
      events++;
    },
    { capture: true },
  );
}

const ms = (n: number): string => n.toFixed(1);

function report(): void {
  const dur = performance.now() - burstStart;
  watching = false;
  burstStart = 0;

  const syncTotal = [...sync.values()].reduce((s, t) => s + t.total, 0);
  const lines: string[] = [];
  lines.push(
    `===== drag: ${(dur / 1000).toFixed(2)}s, ${events} resize events ` +
      `(${(events / (dur / 1000)).toFixed(0)}/s), viewport ${window.innerWidth}x` +
      `${window.innerHeight} @${window.devicePixelRatio}x =====`,
  );

  if (sync.size) {
    lines.push("Reactions (synchronous JS, layout it forces included):");
    for (const [label, t] of [...sync].sort((a, b) => b[1].total - a[1].total)) {
      lines.push(
        `  ${label.padEnd(24)} ${ms(t.total).padStart(8)}ms total  ` +
          `${t.n.toString().padStart(4)} calls  ${ms(t.max).padStart(7)}ms max  ` +
          `${ms(t.total / t.n).padStart(6)}ms avg`,
      );
    }
    lines.push(`  ${"(sum)".padEnd(24)} ${ms(syncTotal).padStart(8)}ms`);
  }

  if (asyncIpc.size) {
    lines.push("IPC fired from a resize reaction (round trip to the Rust main thread):");
    for (const [label, t] of [...asyncIpc].sort((a, b) => b[1].max - a[1].max)) {
      lines.push(
        `  ${label.padEnd(24)} ${t.n.toString().padStart(4)} calls  ` +
          `${ms(t.max).padStart(8)}ms slowest  ${ms(t.total / t.n).padStart(7)}ms avg`,
      );
    }
  }

  if (counts.size) {
    lines.push("Volumes over the drag:");
    for (const [label, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${label.padEnd(24)} ${n}`);
    }
  }

  const fps = frames / (dur / 1000);
  lines.push(
    `Frames: ${frames} painted in ${(dur / 1000).toFixed(2)}s (~${fps.toFixed(0)} fps), ` +
      `${ms(blocked)}ms in gaps over ${FRAME_BUDGET_MS}ms, longest ${ms(longestGap)}ms`,
  );
  const unaccounted = blocked - syncTotal;
  if (blocked > 0) {
    lines.push(
      unaccounted > blocked * 0.2
        ? `Unaccounted: ${ms(Math.max(0, unaccounted))}ms of the blocked time is in no probe — ` +
            `style/layout/paint, or the native side resizing the window.`
        : `Accounted: the probed reactions explain ${((syncTotal / blocked) * 100).toFixed(0)}% ` +
            `of the blocked time.`,
    );
  }

  for (const l of lines) console.log(`[resize] ${l}`);
  // One IPC for the whole report, and into the log file where it can be read
  // after the drag. Failure here must never break the app it's measuring.
  void info(["[resize]", ...lines].join("\n")).catch(() => {});
}
