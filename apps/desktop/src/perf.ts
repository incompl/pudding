// Boot profiler — attributes the multi-second stall on first load (large
// library) to a specific startup phase.
//
// Two signals are collected together:
//   1. Phase timings: bootStep() wraps each major init step and records its wall
//      duration. Awaited IPC is "wait", not "freeze", so a long phase alone isn't
//      proof of jank — pair it with (2).
//   2. Main-thread stalls: a requestAnimationFrame watchdog measures the gap
//      between frames. When the main thread is blocked (JSON.parse of a big invoke
//      payload, row re-keying, DOM build/layout) rAF can't fire, so an oversized
//      gap reveals a freeze and roughly when it happened. (WKWebView — Tauri's
//      macOS webview — does NOT support the `longtask` PerformanceObserver, so the
//      rAF gap is the portable substitute.)
// The report maps each stall back to the phase running at its timestamp, so a
// freeze reads as e.g. "220ms stall during restore-session".
//
// Output is plain console.log lines (not console.table) so it survives copy/paste
// out of the Web Inspector — console.table renders as a blank line when serialized.
//
// Opt-in: set `localStorage.puddingBootPerf = "1"` (then reload) to arm the profiler.
// Off by default so a normal launch pays nothing — this is a diagnostic for the
// first-load freeze, kept wired up (the bootStep calls no-op when disabled) for the
// next time startup timing needs a look.

const ENABLED = (() => {
  try {
    return localStorage.getItem("puddingBootPerf") === "1";
  } catch {
    return false;
  }
})();

// Gaps larger than this between animation frames count as a main-thread stall
// (normal frames are ~16ms; anything this size means the thread couldn't paint).
const STALL_MS = 60;

type Phase = { label: string; start: number; end: number };
type Stall = { start: number; dur: number };

const t0 = performance.now();
const phases: Phase[] = [];
const stalls: Stall[] = [];
let watching = false;
let lastFrame = 0;

// Arm the frame watchdog. Call as early in init() as possible so freezes from the
// first paint are captured. Safe to call when disabled.
export function bootProfileStart(): void {
  if (!ENABLED || watching) return;
  watching = true;
  lastFrame = performance.now();
  const tick = (): void => {
    if (!watching) return;
    const now = performance.now();
    const gap = now - lastFrame;
    // A gap beyond a normal frame means the thread was blocked from `lastFrame`
    // until `now`; record the block ending at `now`.
    if (gap > STALL_MS) stalls.push({ start: lastFrame, dur: gap });
    lastFrame = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Time one awaited init step, recording its wall duration as a named phase.
export async function bootStep<T>(label: string, run: () => Promise<T> | T): Promise<T> {
  if (!ENABLED) return await run();
  const start = performance.now();
  try {
    return await run();
  } finally {
    phases.push({ label, start, end: performance.now() });
  }
}

// The phase whose interval contains t (fall back to the most recently started one,
// since async steps overlap and a stall can land in a gap between recorded phases).
function phaseAt(t: number): string {
  let best: Phase | null = null;
  for (const p of phases) {
    if (t >= p.start && t <= p.end) return p.label;
    if (t >= p.start && (!best || p.start > best.start)) best = p;
  }
  return best ? `after:${best.label}` : "startup";
}

const rel = (t: number): string => (t - t0).toFixed(0);

// Flush the report. Deferred a beat so post-init paint/layout freezes are included.
export function bootProfileReport(): void {
  if (!ENABLED) return;
  setTimeout(() => {
    watching = false;
    const total = performance.now() - t0;
    console.log(`[boot] ===== init took ${total.toFixed(0)}ms =====`);

    console.log("[boot] Phases (wall time — includes awaited IPC, not just main-thread work):");
    for (const p of phases.slice().sort((a, b) => a.start - b.start)) {
      console.log(
        `[boot]   ${p.label.padEnd(18)} ${(p.end - p.start).toFixed(0).padStart(6)}ms` +
          `   (at +${rel(p.start)}ms)`,
      );
    }

    const blocks = stalls.filter((b) => b.dur >= STALL_MS).sort((a, b) => b.dur - a.dur);
    const frozen = blocks.reduce((s, b) => s + b.dur, 0);
    if (blocks.length) {
      console.log(
        `[boot] Main-thread stalls: ${blocks.length} block(s), ${frozen.toFixed(0)}ms total frozen ` +
          `(largest first):`,
      );
      for (const b of blocks) {
        console.log(
          `[boot]   ${b.dur.toFixed(0).padStart(6)}ms stall at +${rel(b.start)}ms` +
            `   during ${phaseAt(b.start)}`,
        );
      }
    } else {
      console.log(
        "[boot] No main-thread stalls ≥" +
          STALL_MS +
          "ms detected — the time is awaited backend/IPC, not a UI freeze.",
      );
    }
  }, 250);
}
