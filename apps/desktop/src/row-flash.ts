// The one-shot accent wash that says "here it is" on a revealed row — the search
// "go to track" landing, and the now-playing title's reveal of its playing context.
//
// The rows that get flashed live in windowed lists, which rebuild their mounted
// slice from scratch whenever the visible range changes (see windowed-list). So a
// class stuck on the row node the moment it's revealed dies with that node: the
// scroll that brought the row into view *is* a range change, and the repaint a
// frame later replaces the flashing element with a fresh one. That's why the wash
// used to blink for a frame instead of fading out over its 900ms.
//
// So the flash lives here, in the model, as a path + a start time, and rows apply
// it at build time (applyRowFlash) like every other per-row state — the same trick
// `.selected` / `.playing` use to survive a remount. A row that mounts mid-wash
// joins it already in progress via a negative animation-delay, so the animation
// runs on wall-clock time across any number of remounts rather than restarting.

// Keep in sync with the row-flash keyframes' duration in styles.css.
const FLASH_MS = 900;

let flashPath: string | null = null;
let flashStart = 0;

// Arm the wash for `path`. Call it *before* the list that holds the row is built
// (or scrolled), so the row picks it up as it mounts. Only one row flashes at a
// time — a newer reveal supersedes an older one.
export function startRowFlash(path: string): void {
  flashPath = path;
  flashStart = performance.now();
}

// Paint the wash on a row being built (or on an already-mounted row a reveal just
// scrolled to). A no-op unless this row is the armed one and the animation still
// has time left to run, so it's safe to call for every row of every list.
export function applyRowFlash(el: HTMLElement, path: string): void {
  if (path !== flashPath || el.classList.contains("flash")) return;
  const elapsed = performance.now() - flashStart;
  if (elapsed >= FLASH_MS) {
    flashPath = null;
    return;
  }
  // Join the wash in progress: a remount picks up where the last node left off
  // instead of restarting the fade from full accent.
  el.style.animationDelay = `${-elapsed}ms`;
  el.classList.add("flash");
  el.addEventListener(
    "animationend",
    () => {
      el.classList.remove("flash");
      el.style.animationDelay = "";
      // Disarm on the first row that runs the wash to completion, so a later
      // remount of the same path (scrolling back to it) doesn't re-flash.
      if (flashPath === path) flashPath = null;
    },
    { once: true },
  );
}
