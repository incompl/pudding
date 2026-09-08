// Hover-to-read for truncated table text.
//
// Every row in the table views is a single line, so text too wide for its track
// ellipsizes and the rest is simply gone — which is exactly what happens to the
// long titles, the compilation artists, and the deep paths a `Location` column is
// there to show in the first place. A clipped cell answers a hover with its full
// text; an unclipped one stays silent.
//
// Three decisions:
//
//   1. The native `title` tooltip, not a styled bubble of our own. It is what the
//      app's buttons already use, it is the OS's tooltip (system delay, system
//      ground, never clipped by the pane or the window edge), and it costs no
//      element, no positioning, and no repaint on lists that rebuild their rows on
//      every scroll tick.
//   2. Set on hover, not at build time. A `title` on every cell pops a tooltip over
//      text the reader can already see. Only a *clipped* cell has anything to
//      reveal, and whether a cell is clipped depends on the pane's width, the
//      column set, and which side of the fold the pane is on — none of which are
//      known when a row is built, all of which are free to measure on the one cell
//      under the pointer. WebKit reads the tooltip off the DOM after dispatching
//      the mouse event, so the title set here is already in place for the hover
//      that revealed it.
//   3. One delegated listener per pane, not one per cell. The windowed lists throw
//      their rows away and rebuild them as they scroll (see windowed-list.ts); a
//      listener on the list root outlives every row that passes under it.
//
// Nothing here knows what a column is. It asks the layout what got clipped and
// reads back what the row already says, which is what keeps it honest across both
// layouts: the folded row's two-field cap is a CSS rule, so what this offers is
// whatever CSS actually left on screen.

// The two things that can clip in these lists, innermost first:
//
//   FIELD — one cell in column mode: a leaf list's or queue's column, or a drill
//           row's (Artists / Albums) half. Each clips inside its own track.
//   LINE  — the row's whole text, folded back into one `title · artist` line below
//           the 28rem breakpoint. There the cells are inline and clip nothing
//           themselves; the line around them is what ellipsizes.
const FIELD = ".col-cell, .nav-primary, .nav-secondary";
const LINE = ".nav-cell, .queue-text";

// Both metrics are integers, and sub-pixel text metrics routinely leave scrollWidth
// a hair over clientWidth on a cell that is not actually clipping, so a pixel of
// slack keeps a tooltip from repeating text the reader can already read in full.
// Inline elements report 0 for both — which is right, not a gap: folded, a cell
// clips nothing and its line is asked instead.
function isClipped(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1;
}

// What the element says, as the reader would have read it. A cell is bare text; a
// folded line is its cells, and the middots that separate them on screen are CSS
// ::before content, so they are re-inserted here. Cells the fold dropped (the third
// field onward, display:none) measure zero and are left out: the tooltip completes
// the line the row is showing, it doesn't smuggle in fields the row deliberately
// isn't.
function readText(el: HTMLElement): string {
  const parts = Array.from(el.children) as HTMLElement[];
  if (parts.length === 0) return (el.textContent ?? "").trim();
  return parts
    .filter((p) => p.offsetWidth > 0)
    .map((p) => (p.textContent ?? "").trim())
    .filter((s) => s !== "")
    .join(" · ");
}

// Put the title on, or take a stale one off — a cell that was clipped before the
// pane was widened (or before a column was unticked) drops its tooltip the next
// time the pointer crosses it. Returns whether this element now owns the tooltip.
function refresh(el: HTMLElement, text: string): boolean {
  if (text !== "" && isClipped(el)) {
    if (el.getAttribute("title") !== text) el.setAttribute("title", text);
    return true;
  }
  if (el.hasAttribute("title")) el.removeAttribute("title");
  return false;
}

function onOver(target: HTMLElement | null): void {
  if (!target || typeof target.closest !== "function") return;
  const field = target.closest<HTMLElement>(FIELD);
  const line = target.closest<HTMLElement>(LINE);
  // Innermost first, and only one tooltip per row: in column mode a field clips
  // inside a line that doesn't, and folded it is the other way round. Asking the
  // field first means the two layouts need no flag between them — whichever is
  // doing the clipping is the one that answers.
  const claimed = field !== null && refresh(field, readText(field));
  if (!line || line === field) return;
  if (claimed) {
    if (line.hasAttribute("title")) line.removeAttribute("title");
  } else {
    refresh(line, readText(line));
  }
}

// Listener per root, not per call: the panes re-render freely, and re-arming a live
// root on every render would stack duplicate listeners on it.
const wired = new WeakSet<HTMLElement>();

// Give a list root hover-to-read for whatever inside it is clipping. Call it on a
// container that outlives its rows (`#library-nav`, `#queue-list`), not on a list
// the pane rebuilds.
export function attachOverflowTitles(root: HTMLElement): void {
  if (wired.has(root)) return;
  wired.add(root);
  root.addEventListener("mouseover", (e) => onOver(e.target as HTMLElement | null));
}
