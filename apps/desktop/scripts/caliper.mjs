// Sub-pixel alignment, measured on the pixels macOS actually drew.
//
// WHY THIS EXISTS, AND WHY IT REPLACED scripts/ruler.mjs
//
// The ruler measured alignment by rendering index.html + styles.css in headless
// Playwright WebKit. On 2026-09-07 that gave a confidently wrong answer: it
// reported the search placeholder and the "Streams" tab label as pixel-identical
// while the shipping app plainly had the placeholder sitting a pixel low.
//
// Headless WebKit and the WKWebView we ship disagree by a WHOLE DEVICE PIXEL.
// Not layout, not fonts — computed boxes and canvas font metrics are byte for
// byte identical between the two. It is rasterizer rounding on a box that lands
// off the device grid: #search-input is 28.375px tall, so centring it in the 33px
// bar puts its content-box top at 10.5125px = 21.025 device px, and the two
// engines round that hair in opposite directions. Elements on clean integer
// geometry (.tab labels, .mode-btn icons) came out one device row HIGHER in the
// real app; the search field's contents did not move.
//
// So there is no such thing as a trustworthy headless number here, and this tool
// does not offer one. It drives the real app, captures the real window, and maps
// the real DOM onto the real pixels.
//
// TWO RULES IT IS BUILT AROUND, both learned from how the ruler failed:
//
//   1. DEVICE PIXELS ARE THE UNIT. The ruler reported CSS px ("ink bot 24.000"
//      for both elements) and a 1-device-px error read as perfect agreement,
//      because at dpr 2 the interesting differences live in the half-CSS-px that
//      its rounding threw away. Everything below is reported in device rows
//      first, CSS px second.
//
//   2. REFUSE, DON'T GUESS. The ruler answered for pixels it had never seen. If
//      anything here cannot be verified — the calibration markers are missing,
//      the implied scale disagrees with the DOM, the window is still animating —
//      this aborts instead of printing a number. A tool that is silently wrong
//      is worse than no tool, which is the whole lesson of the bug above.
//
// USAGE
//   pnpm caliper                                   # topbar, measure + crops
//   pnpm caliper --selftest                        # prove the mapping is right
//   pnpm caliper --try '#search-input{padding-top:5.7px}'   # A/B a fix, live
//   pnpm caliper --probe '#time-current' --scan 34 --target 'elapsed=#time-current'
//
// Output lands in .caliper/ (gitignored).

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePNG, encodePNG } from "../e2e/screenshots/png.mjs";
import { captureWindowPng } from "../e2e/screenshots/capture.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);
const multi = (name) =>
  argv.reduce((acc, v, i) => (v === `--${name}` ? [...acc, argv[i + 1]] : acc), []);

const CTRL = Number(process.env.PUDDING_DRIVE_PORT ?? 9011);
const OUT = path.resolve(projectRoot, flag("out", ".caliper"));
const ZOOM = Number(flag("zoom", 8));
const ATTACH = has("attach");
const SELFTEST = has("selftest");
const JSON_OUT = has("json");
const TRY_CSS = flag("try", null);
const TRY_FILE = flag("try-file", null);

// The element whose type sets the guides: everything in a row should sit on the
// baseline of that row's dominant text.
const PROBE = flag("probe", ".tab.active");
// Row height in CSS px, measured down from the probe's top. Keeps the scan on one
// row, and stops before decoration that is ink but is not type — the tabs carry
// an accent underline a few px below their baseline which would otherwise read as
// a descender on every measurement in the row.
const SCAN = Number(flag("scan", 28));

// A target is `label=selector`, optionally with a band `selector[x0:x1]` giving
// x offsets in CSS px from the element's left edge. The band exists because one
// element can paint two things that must be judged separately: #search-input
// carries the magnifier in its left padding and the placeholder after it.
//
// The selector may be prefixed `icon:` or `text:` (default text), because the two
// are judged by different numbers and mixing them up produces nonsense. Type has
// a baseline — a shelf where the letter bottoms land — and two runs of type agree
// when their shelves land on the same device row. An icon has no baseline; asking
// where its "baseline" is picks whatever row its heaviest stroke happened to fall
// on, which is why an early version of this table claimed the three mode icons
// disagreed with each other by 3 device px when they are in fact identical art.
// Icons are judged by where their ink sits against the type's cap band instead.
const TOPBAR_TARGETS = [
  'tab "Files"=.tab.active',
  'tab "Streams"=.tab:not(.active)',
  "magnifier=icon:#search-input[5:20]",
  "placeholder=#search-input[24:92]",
  "shuffle=icon:#mode-shuffle",
  "repeat=icon:#mode-repeat",
  "mini player=icon:#miniplayer-btn",
  "expand=icon:#expand-btn",
];
const targetSpecs = multi("target").length ? multi("target") : TOPBAR_TARGETS;

function parseTarget(spec) {
  const eq = spec.indexOf("=");
  if (eq === -1) throw new Error(`--target wants label=selector, got: ${spec}`);
  const label = spec.slice(0, eq);
  let selector = spec.slice(eq + 1);
  let band = null;
  let kind = "text";
  const k = selector.match(/^(icon|text):(.*)$/);
  if (k) {
    kind = k[1];
    selector = k[2];
  }
  const m = selector.match(/^(.*)\[(-?[\d.]+):(-?[\d.]+)\]$/);
  if (m) {
    selector = m[1];
    band = [Number(m[2]), Number(m[3])];
  }
  return { label, selector, band, kind };
}

// A refusal, as opposed to a crash — see "REFUSE, DON'T GUESS" above.
//
// It THROWS rather than exiting on the spot, and that matters: main()'s finally is
// what pulls the styles this tool injects back out of the running app, and
// process.exit() skips pending finally blocks. Exiting here would leave the app
// frozen (transitions and animations off), or — after an abort in the --try
// branch — still wearing the candidate rule, with nothing on screen to say so.
// Every refusal below is on a path that has already injected something.
class Refusal extends Error {}
const die = (msg) => {
  throw new Refusal(msg);
};

// --- the drive daemon ------------------------------------------------------
async function health() {
  try {
    const r = await fetch(`http://localhost:${CTRL}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return await r.json();
  } catch {
    return null;
  }
}
const healthy = async () => (await health())?.connected === true;

// A daemon answering with connected:false is the failure mode that wastes the most
// time, and it does not recover on its own. It means the webview is not dialled in
// — usually a previous daemon was killed and left its app, vite and tauri children
// running: the orphaned app still points at the old socket, and a fresh daemon then
// waits five minutes for a connection that can never arrive.
//
// So say so, precisely, instead of timing out. Launching over the top of the
// orphans does not work either, which is why this refuses rather than retrying.
function reportStaleStack() {
  // Match the EXECUTABLE, not the whole command line — a shell whose arguments
  // merely mention these paths (a pkill one-liner, or this very check) would
  // otherwise list itself and bury the real processes in noise.
  let procs = "";
  try {
    const raw = execFileSync("/bin/sh", ["-c", "ps -o pid=,command= -ax"], {
      encoding: "utf8",
    });
    procs = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => {
        const cmd = l.slice(l.indexOf(" ") + 1);
        const exe = cmd.split(/\s+/).slice(0, 2).join(" ");
        return /e2e\/drive\.mjs|target\/debug\/pudding|tauri\.js|vite\/bin\/vite\.js/.test(exe);
      })
      .map((l) => (l.length > 110 ? `${l.slice(0, 107)}...` : l))
      .join("\n");
  } catch {
    /* nothing matched */
  }
  die(
    `a drive daemon is listening on :${CTRL} but no webview is connected.\n` +
      "  This is almost always an orphaned dev stack from a killed daemon: the app is\n" +
      "  still running and still pointing at the old socket, so nothing will ever dial in.\n" +
      (procs ? `\n  Still running:\n${procs.split("\n").map((l) => `    ${l.trim()}`).join("\n")}\n` : "") +
      "\n  Clear it and re-run (plain SIGTERM is not always enough, hence -9):\n" +
      `    lsof -t -iTCP:${CTRL},${CTRL - 1},1420 -sTCP:LISTEN | xargs kill -9\n` +
      "    pkill -9 -f 'target/debug/pudding'; pkill -9 -f 'tauri.js dev'",
  );
}

async function bridge(cmd, args) {
  const r = await fetch(`http://localhost:${CTRL}/cmd`, {
    method: "POST",
    body: JSON.stringify({ cmd, args }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j && typeof j === "object" && "error" in j) throw new Error(`${cmd}: ${j.error}`);
  return j;
}

// Attach to a running app if there is one — repeat measurements should cost a
// couple of seconds, not a cold Rust build. Only launch when there is nothing to
// attach to, and never when --attach says the caller wants an existing session.
async function ensureApp() {
  const h = await health();
  if (h?.connected) return { launched: false };
  // A daemon that is up but unconnected will never heal; catch it before waiting.
  if (h) reportStaleStack();
  if (ATTACH) die(`no drive daemon answering on :${CTRL} (--attach given, so not launching one)`);
  console.log("no app attached — launching (node e2e/drive.mjs --dev)...");
  const child = spawn("node", ["e2e/drive.mjs", "--dev"], {
    cwd: projectRoot,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await healthy()) return { launched: true, pid: child.pid };
  }
  die("app did not connect within 5 minutes");
}

// --- PNG -------------------------------------------------------------------
// The project has no image dependency and does not want one. screencapture emits
// 8-bit RGBA, non-interlaced; Apple's iDOT chunk rides along but does not disturb
// the zlib stream (verified against PIL, byte-identical).
const lum = (png, x, y) => {
  const i = (png.width * y + x) * png.channels;
  return 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
};

// --- capture ---------------------------------------------------------------
// By window id, not by screen region. `screencapture -l` grabs the window's own
// content: it needs no focus stealing, is not disturbed by whatever is stacked on
// top of it, and arrives already cropped to the window. Region capture would need
// the window's position in a coordinate space that WKWebView reports unreliably
// (window.screenY came back as the display height during development).
function captureWindow(winId) {
  try {
    return decodePNG(captureWindowPng(winId));
  } catch (error) {
    die(error.message);
  }
}

// --- calibration -----------------------------------------------------------
// Two markers at known viewport points, then solve device = origin + scale * css.
//
// This is the difference between a mapping that is verified and one that is
// assumed. It costs one extra capture and it settles, per run and per machine,
// every question that would otherwise be a guess: whether `-l` frames the window
// or its content, where the titlebar sits, what the real backing scale is. The
// markers are pseudo-elements on <html> with position:fixed, so they add no node
// to the DOM and cannot perturb layout. They are removed before the real capture.
const FIDUCIAL_ID = "caliper-fiducial";
const FIDUCIAL_SIZE = 12;

// Markers are inset from the window's edges, not flush into its corners. The
// corners are the one place they cannot be trusted: macOS rounds the window there
// and the traffic lights sit over the top-left, so a corner marker comes back
// partly eaten (measured: 91 of 256 px) and its centroid is pulled off true.
// Inset far enough to clear all of that, and keep them diagonally opposite so
// they still span most of the window in both axes.
function fiducialCSS(view) {
  const inset = Math.max(20, Math.min(160, Math.floor(view.innerHeight / 4)));
  return {
    inset,
    css: `
html::before, html::after {
  content: "" !important;
  position: fixed !important;
  display: block !important;
  width: ${FIDUCIAL_SIZE}px !important;
  height: ${FIDUCIAL_SIZE}px !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
  margin: 0 !important;
  border: 0 !important;
  opacity: 1 !important;
  transform: none !important;
  clip-path: none !important;
}
html::before { left: 0 !important; top: ${inset}px !important; background: #ff00ff !important; }
html::after { right: 0 !important; bottom: ${inset}px !important; background: #00ffff !important; }
`,
  };
}

// Matched on hue signature, not colour distance. The capture carries a Display P3
// profile, so sRGB #00ffff arrives as (117, 251, 253) — a red channel 117 away
// from nominal, which any sane per-channel tolerance would reject. (It did: this
// is what made the first run fail.) Testing the shape of the colour instead
// survives any profile conversion, and still cannot collide with the app's
// palette of neutral greys and one muted green.
const MARKERS = {
  magenta: (r, g, b) => r > 150 && b > 150 && g < 130,
  cyan: (r, g, b) => g > 200 && b > 200 && r < 190,
};

// Bounding box, not centroid: for an unclipped rectangle the bbox centre is exact,
// and comparing the bbox's size against the size we asked for is what tells us the
// marker arrived whole.
function findMarker(png, test) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, n = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) * png.channels;
      if (!test(png.data[i], png.data[i + 1], png.data[i + 2])) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      n++;
    }
  }
  if (n < 4) return null;
  return {
    x: (minX + maxX + 1) / 2,
    y: (minY + maxY + 1) / 2,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    count: n,
  };
}

async function calibrate(winId, view) {
  const fid = fiducialCSS(view);
  await bridge("css", { id: FIDUCIAL_ID, text: fid.css });
  await new Promise((r) => setTimeout(r, 120));
  const png = captureWindow(winId);
  await bridge("css", { id: FIDUCIAL_ID, text: null });

  const tl = findMarker(png, MARKERS.magenta);
  const br = findMarker(png, MARKERS.cyan);
  if (!tl || !br) {
    die(
      "calibration markers not found in the capture.\n" +
        "  The window may be minimized, on another Space, or fully off-screen.\n" +
        "  Refusing to measure pixels whose position cannot be verified.",
    );
  }
  // Whole, or the centre is a lie. A marker that arrives short has been clipped or
  // painted over, which means the transform derived from it would be off by
  // exactly the kind of fraction this tool exists to catch.
  const want = FIDUCIAL_SIZE * view.dpr;
  for (const [name, m] of [["top-left", tl], ["bottom-right", br]]) {
    if (Math.abs(m.w - want) > 1 || Math.abs(m.h - want) > 1) {
      die(
        `the ${name} calibration marker came back ${m.w}x${m.h} device px, expected ` +
          `${want}x${want}.\n` +
          "  Something is covering it, so the capture cannot be mapped to the DOM.",
      );
    }
  }
  // Marker centres in CSS viewport coords.
  const c1 = { x: FIDUCIAL_SIZE / 2, y: fid.inset + FIDUCIAL_SIZE / 2 };
  const c2 = {
    x: view.innerWidth - FIDUCIAL_SIZE / 2,
    y: view.innerHeight - fid.inset - FIDUCIAL_SIZE / 2,
  };
  const sx = (br.x - tl.x) / (c2.x - c1.x);
  const sy = (br.y - tl.y) / (c2.y - c1.y);
  const ox = tl.x - sx * c1.x;
  const oy = tl.y - sy * c1.y;

  if (Math.abs(sx - view.dpr) > 0.02 || Math.abs(sy - view.dpr) > 0.02) {
    die(
      `implied scale (${sx.toFixed(3)} x ${sy.toFixed(3)}) disagrees with the DOM's ` +
        `devicePixelRatio (${view.dpr}).\n` +
        "  The display is probably running a scaled resolution, so what is on screen is\n" +
        "  a resampled version of what WebKit rasterized. Sub-pixel work tuned here would\n" +
        "  not describe what you see. Switch to a native (integer) scale and re-run.",
    );
  }
  return { ox, oy, sx, sy, png };
}

// --- measurement -----------------------------------------------------------
// Ink is contrast against the row's own background, so this works in dark and
// light mode alike. The background is the median over the whole scan band, which
// is background almost everywhere in a row of chrome.
function bandBackground(png, map, view, y0, y1) {
  const vals = [];
  const ya = Math.max(0, Math.round(map.oy + y0 * map.sy));
  const yb = Math.min(png.height, Math.round(map.oy + y1 * map.sy));
  const xa = Math.max(0, Math.round(map.ox));
  const xb = Math.min(png.width, Math.round(map.ox + view.innerWidth * map.sx));
  for (let y = ya; y < yb; y += 1) for (let x = xa; x < xb; x += 3) vals.push(lum(png, x, y));
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

// Per-device-row ink for one column range.
//
// `base` is the number that matters most and the one the ruler never had: the
// last row still carrying half the run's peak ink — the shelf where the letter
// bottoms sit. Threshold-dependent extremes (inkTop/inkBot) wobble with
// antialiasing and with which letters a word happens to contain; the shelf does
// not, and comparing shelves is what exposed the placeholder being a device pixel
// low when every other measure said the two agreed.
function measure(png, map, x0css, x1css, y0css, y1css, bg) {
  const xa = Math.max(0, Math.round(map.ox + x0css * map.sx));
  const xb = Math.min(png.width, Math.round(map.ox + x1css * map.sx));
  const ya = Math.max(0, Math.round(map.oy + y0css * map.sy));
  const yb = Math.min(png.height, Math.round(map.oy + y1css * map.sy));
  if (xb <= xa || yb <= ya) return null;

  const rows = [];
  for (let y = ya; y < yb; y++) {
    let sum = 0, peak = 0;
    for (let x = xa; x < xb; x++) {
      const d = Math.abs(lum(png, x, y) - bg);
      sum += d;
      if (d > peak) peak = d;
    }
    rows.push({ dev: y, sum, peak });
  }
  const lit = rows.filter((r) => r.peak > 12);
  if (!lit.length) return null;

  const maxSum = Math.max(...rows.map((r) => r.sum));
  const strong = rows.filter((r) => r.sum > maxSum * 0.5);
  const faint = rows.filter((r) => r.sum > maxSum * 0.1);
  const top = lit[0].dev;
  const bot = lit[lit.length - 1].dev;
  let m = 0, w = 0;
  for (const r of rows) {
    if (r.dev < top || r.dev > bot) continue;
    m += r.sum * (r.dev + 0.5);
    w += r.sum;
  }
  return {
    // Device rows, relative to the window's top-left. The primary unit.
    top,
    bot,
    capTop: faint[0].dev,
    base: strong[strong.length - 1].dev,
    bbox: (top + bot + 1) / 2,
    mass: m / w,
    rows,
    // CSS px, for talking to the stylesheet.
    cssTop: (top - map.oy) / map.sy,
    cssBot: (bot + 1 - map.oy) / map.sy,
  };
}

// --- crops -----------------------------------------------------------------
// Nearest-neighbour magnification of REAL device pixels. Never a re-render at a
// higher scale: that would show geometry no machine rasterizes, and the picture
// would disagree with the table above it.
function renderPanel(png, map, x0css, x1css, y0dev, y1dev) {
  const xa = Math.max(0, Math.round(map.ox + x0css * map.sx));
  const xb = Math.min(png.width, Math.round(map.ox + x1css * map.sx));
  const W = (xb - xa) * ZOOM, H = (y1dev - y0dev) * ZOOM;
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (png.width * (y0dev + Math.floor(y / ZOOM)) + xa + Math.floor(x / ZOOM)) * png.channels;
      const di = (W * y + x) * 4;
      rgba[di] = png.data[si];
      rgba[di + 1] = png.data[si + 1];
      rgba[di + 2] = png.data[si + 2];
      rgba[di + 3] = 255;
    }
  }
  return { W, H, rgba };
}

// Guides are drawn at the BOTTOM edge of their device row, so a baseline rule
// sits where the baseline is rather than a row above it.
function drawGuides(buf, W, H, rowOffset, y0dev, guides) {
  for (const g of guides) {
    const y = rowOffset + (g.dev - y0dev) * ZOOM + ZOOM - 1;
    if (y < rowOffset || y >= rowOffset + H) continue;
    for (let x = 0; x < W; x++) {
      const di = (W * y + x) * 4;
      buf[di] = g.color[0];
      buf[di + 1] = g.color[1];
      buf[di + 2] = g.color[2];
      buf[di + 3] = 255;
    }
  }
}

function cropSheet(png, map, x0css, x1css, y0dev, y1dev, guides, file) {
  const p = renderPanel(png, map, x0css, x1css, y0dev, y1dev);
  drawGuides(p.rgba, p.W, p.H, 0, y0dev, guides);
  fs.writeFileSync(file, encodePNG(p.W, p.H, p.rgba));
  return file;
}

// Several regions of the SAME rows, stacked, with one rule running through all of
// them. This is the view that settles an argument: two runs of type side by side
// against a shared baseline, where a one-device-pixel difference is impossible to
// talk yourself out of.
function stackSheet(png, map, panels, y0dev, y1dev, guides, file) {
  const rendered = panels.map((p) => renderPanel(png, map, p.x0, p.x1, y0dev, y1dev));
  const GAP = 10;
  const W = Math.max(...rendered.map((r) => r.W));
  const H = rendered.reduce((a, r) => a + r.H, 0) + GAP * (rendered.length - 1);
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < out.length; i += 4) out[i + 3] = 255;
  let y = 0;
  for (const r of rendered) {
    for (let row = 0; row < r.H; row++) {
      r.rgba.copy(out, ((y + row) * W) * 4, row * r.W * 4, (row + 1) * r.W * 4);
    }
    drawGuides(out, W, r.H, y, y0dev, guides);
    y += r.H + GAP;
  }
  fs.writeFileSync(file, encodePNG(W, H, out));
  return file;
}

// --- run -------------------------------------------------------------------
const FREEZE_ID = "caliper-freeze";
const FREEZE_CSS = `
*, *::before, *::after {
  transition: none !important;
  animation: none !important;
}
* { caret-color: transparent !important; }
`;
const TRY_ID = "caliper-try";

async function collect(winId, view, targets) {
  const map = await calibrate(winId, view);

  // Two captures, and they must agree. Anything still moving — a transition that
  // outlived the freeze, the visualizer's rAF loop, a marquee — makes every
  // number below a coin flip, so it is a hard stop rather than a footnote.
  const a = captureWindow(winId);
  const b = captureWindow(winId);
  if (!a.data.equals(b.data)) {
    die(
      "two consecutive captures differ — something on screen is still moving.\n" +
        "  Stop playback (the visualizer and marquee both animate) and re-run.",
    );
  }
  const png = a;

  const probeRect = view.elements[PROBE]?.rect;
  if (!probeRect) die(`probe selector not found in the app: ${PROBE}`);
  const y0 = probeRect.top;
  const y1 = probeRect.top + SCAN;
  const bg = bandBackground(png, map, view, y0, y1);

  const results = [];
  for (const t of targets) {
    const info = view.elements[t.selector];
    if (!info) continue; // hidden in this state; one list can span states
    const r = info.rect;
    if (r.width === 0 || r.height === 0) continue;
    // A target from another row would be measured against the wrong guides.
    if (r.top >= y1 || r.top + r.height <= y0) {
      console.warn(`  (skipped ${t.label}: outside the probe's row)`);
      continue;
    }
    const x0 = t.band ? r.left + t.band[0] : r.left;
    const x1 = t.band ? r.left + t.band[1] : r.left + r.width;
    const m = measure(png, map, x0, x1, y0, y1, bg);
    if (!m) {
      console.warn(`  (skipped ${t.label}: no ink found in its box)`);
      continue;
    }
    results.push({ ...t, ...m, x0, x1 });
  }
  if (!results.length) die("no targets produced ink — nothing to measure");
  return { png, map, bg, results, y0, y1 };
}

// How far each target sits from where the row's type says it should, in device px.
// Type is compared baseline to baseline (an integer — rows either match or they
// do not). An icon is compared to the cap band's centre, and because a lopsided
// glyph reads where its weight is rather than where its box is, that comparison
// uses the ink's intensity centroid: the search magnifier measures centred by
// bounding box and still looks high, and the eye follows the mass.
// The icon tolerance is 0.75 device px, and that number is not a fudge. An icon
// whose ink is an even number of device px can only ever come to rest on a whole
// or half device row, so a residual around 0.5 is the grid, not a defect, and no
// amount of nudging removes it — only changing the ink's height does. Flagging it
// would mean flagging three identical mode icons as disagreeing when they measure
// 0.47 / 0.54 / 0.50. Past 0.75 the error is a whole-pixel one and worth fixing.
function offset(r, probe, bandCentre) {
  return r.kind === "icon"
    ? { value: r.mass - bandCentre, unit: "centre", tol: 0.75 }
    : { value: r.base - probe.base, unit: "baseline", tol: 0 };
}

function report(run, label) {
  const probe = run.results.find((r) => r.selector === PROBE && r.kind === "text");
  if (!probe) die(`the probe (${PROBE}) produced no type to set the guides from`);
  // The band the row's type occupies: cap top down to baseline, inclusive.
  const bandCentre = (probe.capTop + probe.base + 1) / 2;

  if (label) console.log(`\n${label}`);
  console.log(
    `  guides from ${probe.label}: cap row ${probe.capTop}, baseline row ${probe.base}, ` +
      `band centre ${bandCentre.toFixed(1)}  (device rows from the window's top)`,
  );
  console.log(
    `\n  ${"target".padEnd(15)}${"kind".padEnd(6)}${"ink".padEnd(10)}${"base".padEnd(6)}` +
      `${"mass".padEnd(8)}${"off".padEnd(9)}${"css px".padEnd(17)}`,
  );
  const off = [];
  for (const r of run.results) {
    const o = offset(r, probe, bandCentre);
    const bad = Math.abs(o.value) > o.tol;
    if (bad && r !== probe) off.push({ r, o });
    const shown = o.unit === "baseline" ? (o.value > 0 ? `+${o.value}` : `${o.value}`) : o.value.toFixed(2);
    console.log(
      `  ${r.label.padEnd(15)}${r.kind.padEnd(6)}${`${r.top}..${r.bot}`.padEnd(10)}` +
        `${String(r.base).padEnd(6)}${r.mass.toFixed(2).padEnd(8)}` +
        `${(r === probe ? "probe" : shown).padEnd(9)}` +
        `${`${r.cssTop.toFixed(3)}..${r.cssBot.toFixed(3)}`.padEnd(17)}` +
        `${r === probe || !bad ? "" : o.value > 0 ? "low" : "high"}`,
    );
  }
  console.log(
    off.length
      ? `\n  off the row's type: ` +
          off
            .map(
              ({ r, o }) =>
                `${r.label} ${o.value > 0 ? "+" : ""}${o.unit === "baseline" ? o.value : o.value.toFixed(2)} (${o.unit})`,
            )
            .join(", ")
      : "\n  everything sits on the row's type.",
  );
  return { probe, bandCentre };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await ensureApp();

  const winId = await bridge("invoke", { name: "window_number" });
  if (!winId) {
    die(
      "the app did not return a window id.\n" +
        "  window_number is gated on PUDDING_E2E_PORT, which the drive daemon sets —\n" +
        "  so this usually means the app was started by hand rather than by e2e/drive.mjs.",
    );
  }

  const targets = targetSpecs.map(parseTarget);
  const selectors = [...new Set([PROBE, ...targets.map((t) => t.selector)])];

  await bridge("css", { id: FREEZE_ID, text: FREEZE_CSS });
  await new Promise((r) => setTimeout(r, 200));

  try {
    const view = await bridge("layout", { selectors });
    console.log(
      `window ${winId} — viewport ${view.innerWidth}x${view.innerHeight} at dpr ${view.dpr}, ` +
        `crops magnified ${ZOOM}x`,
    );

    if (SELFTEST) return await selftest(winId, view);

    const before = await collect(winId, view, targets);
    const { probe, bandCentre } = report(before, TRY_CSS || TRY_FILE ? "BEFORE" : null);

    const guides = [
      { dev: probe.capTop, color: [255, 60, 60] },
      { dev: probe.base, color: [255, 60, 60] },
    ];
    const pad = 6;
    const yTop = Math.min(...before.results.map((r) => r.top)) - pad;
    const yBot = Math.max(...before.results.map((r) => r.bot)) + pad;
    const files = [
      cropSheet(
        before.png, before.map,
        Math.min(...before.results.map((r) => r.x0)),
        Math.max(...before.results.map((r) => r.x1)),
        yTop, yBot, guides, path.join(OUT, "row.png"),
      ),
    ];
    // Whatever is off gets stacked under the probe against a shared rule. Nothing
    // off means nothing to argue about, so that sheet is not written.
    const strays = before.results.filter((r) => {
      if (r === probe) return false;
      const o = offset(r, probe, bandCentre);
      return Math.abs(o.value) > o.tol;
    });
    if (strays.length) {
      files.push(
        stackSheet(
          before.png, before.map,
          [probe, ...strays].map((r) => ({ x0: r.x0, x1: r.x1 })),
          yTop, yBot, guides, path.join(OUT, "compare.png"),
        ),
      );
      console.log(
        `  compare.png stacks ${[probe, ...strays].map((r) => r.label).join(" / ")} on one rule`,
      );
    }

    if (TRY_CSS || TRY_FILE) {
      const text = TRY_FILE ? fs.readFileSync(path.resolve(TRY_FILE), "utf8") : TRY_CSS;
      await bridge("css", { id: TRY_ID, text });
      await new Promise((r) => setTimeout(r, 200));
      const view2 = await bridge("layout", { selectors });
      const after = await collect(winId, view2, targets);
      const { probe: probe2 } = report(after, "AFTER");
      files.push(
        cropSheet(
          after.png, after.map,
          Math.min(...after.results.map((r) => r.x0)),
          Math.max(...after.results.map((r) => r.x1)),
          Math.min(...after.results.map((r) => r.top)) - pad,
          Math.max(...after.results.map((r) => r.bot)) + pad,
          [
            { dev: probe2.capTop, color: [255, 60, 60] },
            { dev: probe2.base, color: [255, 60, 60] },
          ],
          path.join(OUT, "row-after.png"),
        ),
      );
      // Icons by centroid, type by baseline — the same split offset() makes, and
      // for the same reason. An icon has no baseline, so differencing `base` reports
      // whichever row its heaviest stroke happened to land on: noise, and exactly
      // the mistake that once made three identical mode icons look 3 device px
      // apart. A type move is a whole row or nothing; an icon move is fractional.
      console.log("\n  change (device rows, + = moved down):");
      for (const r of after.results) {
        const was = before.results.find((x) => x.label === r.label);
        if (!was) continue;
        const d = r.kind === "icon" ? r.mass - was.mass : r.base - was.base;
        const shown = r.kind === "icon" ? d.toFixed(2) : String(d);
        console.log(`    ${r.label.padEnd(15)}${r.kind.padEnd(6)}${d > 0 ? "+" : ""}${shown}`);
      }
    }

    console.log(`\ncrops:\n${files.map((f) => `  ${path.relative(projectRoot, f)}`).join("\n")}`);
    if (JSON_OUT) {
      const f = path.join(OUT, "measure.json");
      fs.writeFileSync(
        f,
        JSON.stringify(
          before.results.map(({ rows, ...r }) => r),
          null,
          2,
        ),
      );
      console.log(`  ${path.relative(projectRoot, f)}`);
    }
  } finally {
    // Leave the app exactly as found, even on an abort.
    await bridge("css", { id: TRY_ID, text: null }).catch(() => {});
    await bridge("css", { id: FREEZE_ID, text: null }).catch(() => {});
    await bridge("css", { id: FIDUCIAL_ID, text: null }).catch(() => {});
  }
}

// --- selftest --------------------------------------------------------------
// Checks the CSS->device mapping against a landmark whose truth is known from
// the DOM independently of any pixel measurement: the active tab's accent
// underline is 2 CSS px tall and exactly as wide as the tab's box. If the
// transform were wrong, neither number would come out right.
async function selftest(winId, view) {
  const accent = [0xb5, 0xd1, 0x7a];
  const map = await calibrate(winId, view);
  const png = captureWindow(winId);
  const tab = view.elements[".tab.active"]?.rect;
  if (!tab) die("selftest needs a .tab.active in the current view");

  const isAccent = (i) =>
    Math.abs(png.data[i] - accent[0]) < 40 &&
    Math.abs(png.data[i + 1] - accent[1]) < 40 &&
    Math.abs(png.data[i + 2] - accent[2]) < 40;

  // The active tab's LABEL is accent-coloured too, so "any accent pixel" spans
  // half the window. The underline is the accent thing that runs solidly across
  // the tab's whole width — find it by that property, then measure it.
  const xa = Math.round(map.ox + tab.left * map.sx);
  const xb = Math.round(map.ox + (tab.left + tab.width) * map.sx);
  const yEnd = Math.min(png.height, Math.round(map.oy + (tab.top + tab.height + 6) * map.sy));
  const solid = [];
  for (let y = Math.max(0, Math.round(map.oy)); y < yEnd; y++) {
    let n = 0;
    for (let x = Math.max(0, xa); x < Math.min(png.width, xb); x++) {
      if (isAccent((png.width * y + x) * png.channels)) n++;
    }
    if (n >= (xb - xa) * 0.9) solid.push(y);
  }
  if (!solid.length) die("selftest: no accent underline found under the active tab");

  let minX = Infinity, maxX = -Infinity;
  for (const y of solid) {
    for (let x = 0; x < png.width; x++) {
      if (!isAccent((png.width * y + x) * png.channels)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  const contiguous = solid[solid.length - 1] - solid[0] + 1 === solid.length;
  const hCss = solid.length / map.sy;
  const leftCss = (minX - map.ox) / map.sx;
  const rightCss = (maxX + 1 - map.ox) / map.sx;
  const checks = [
    ["underline is one solid band", contiguous ? 1 : 0, 1, 0],
    ["underline height", hCss, 2, 0.01],
    ["underline left == tab left", leftCss, tab.left, 0.51],
    ["underline right == tab right", rightCss, tab.left + tab.width, 0.51],
  ];
  console.log("\nselftest — mapping vs DOM-known landmark:");
  let bad = 0;
  for (const [name, got, want, tol] of checks) {
    const ok = Math.abs(got - want) <= tol;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(30)} got ${got.toFixed(3)}  want ${want.toFixed(3)}`);
  }
  const a = captureWindow(winId), b = captureWindow(winId);
  const stable = a.data.equals(b.data);
  if (!stable) bad++;
  console.log(`  ${stable ? "ok  " : "FAIL"} ${"capture is stable".padEnd(30)}`);
  console.log(bad ? `\n${bad} check(s) failed — do not trust measurements.` : "\nmapping verified.");
  if (bad) process.exitCode = 1;
}

main().catch((e) => {
  // A Refusal is a considered answer, so it prints as its message. Anything else
  // is a bug in this script and prints as a stack.
  console.error(`\ncaliper: ${e instanceof Refusal ? e.message : (e.stack ?? String(e))}\n`);
  process.exitCode = 1;
});
