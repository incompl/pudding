// Capture the real WKWebView raster, shared by the screenshot suite and caliper.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodePNG, encodePNG } from './png.mjs';

// Reaches ordinary properties only. An animation whose keyframes target a
// registered custom property (@property) runs on through this in WKWebView, and
// through an !important override of the property's value as well — so a rule
// animating one is unfreezable from here, and belongs in the stylesheet as an
// animation of the real property instead (see #live-indicator).
export const FREEZE_CSS = `
*, *::before, *::after { transition: none !important; animation: none !important; }
* { caret-color: transparent !important; }
`;

export function captureWindowPng(windowId) {
  if (!Number.isInteger(windowId) || windowId <= 0) throw new Error('Invalid native window ID');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pudding-capture-'));
  const file = path.join(dir, 'window.png');
  try {
    execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(windowId), file], {
      stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000,
    });
    return readFileSync(file);
  } catch (error) {
    throw new Error(`Native window capture failed: ${String(error.stderr ?? error.message)}\n` +
      'Run in a logged-in macOS graphical session. Enable Screen & System Audio Recording ' +
      'for the terminal/host app in System Settings, then relaunch that host.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function samePixels(a, b) {
  return a.width === b.width && a.height === b.height &&
    a.channels === b.channels && a.data.equals(b.data);
}

// Where two same-sized captures disagree, in device pixels: how many, and the
// box enclosing them. A caller that can't settle gets this rather than a bare
// "something moved" — the box is usually enough to name the element on its own.
export function diffRegion(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return null;
  const { width, height, channels } = a;
  let count = 0, left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    for (let x = 0; x < width; x++) {
      const i = row + x * channels;
      if (a.data.compare(b.data, i, i + channels, i, i + channels) === 0) continue;
      count++;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return count ? { count, left, top, right, bottom,
    width: right - left + 1, height: bottom - top + 1 } : null;
}

// A settled window is one that captures identically twice in a row. When it
// never does, the pair that disagreed and their difference go next to the run's
// other artifacts: an animation this suite forgot to freeze is far easier to
// recognize in the pink mask than to deduce from the recipe.
export async function captureStable(windowId, file, beforeCapture, opts = {}) {
  let previous;
  for (let attempt = 0; attempt < 12; attempt++) {
    await beforeCapture();
    const bytes = captureWindowPng(windowId);
    const pixels = decodePNG(bytes);
    if (previous && samePixels(previous, pixels)) {
      await writeFile(file, bytes);
      return pixels;
    }
    previous = { ...pixels, bytes };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const last = captureWindowPng(windowId);
  const lastPixels = decodePNG(last);
  const region = diffRegion(previous, lastPixels);
  let where = '';
  if (opts.diagnostics) {
    await writeFile(`${opts.diagnostics}-a.png`, previous.bytes);
    await writeFile(`${opts.diagnostics}-b.png`, last);
    await writeFile(`${opts.diagnostics}-diff.png`, differencePNG(previous, lastPixels));
    where = `\nUnsettled frames: ${opts.diagnostics}-{a,b,diff}.png`;
  }
  // Reported in CSS pixels, the units the recipe and the stylesheet are written
  // in; the capture itself is 2x.
  const box = region
    ? `${region.count} device px differ, within ${region.width}\u00d7${region.height} at ` +
      `(${region.left / 2}, ${region.top / 2})\u2013(${(region.right + 1) / 2}, ${(region.bottom + 1) / 2}) CSS px`
    : 'the captures disagree on size';
  const live = opts.stillRunning?.() ?? [];
  const blame = live.length
    ? `Still animating at the shutter: ${live.join('; ')}.`
    : 'Nothing was animating at the shutter, so this is not a CSS animation or transition.';
  throw new Error(`Window did not settle: consecutive native captures differ. ${box}. ` +
    `${blame}${where}`);
}

// A diagnostic image only; captures themselves retain their native color profile.
export function differencePNG(a, b) {
  const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = x < a.width && x < b.width && y < a.height && y < b.height;
    const ai = (y * a.width + x) * a.channels, bi = (y * b.width + x) * b.channels;
    const equal = inside && a.channels === b.channels &&
      a.data.subarray(ai, ai + a.channels).equals(b.data.subarray(bi, bi + b.channels));
    const i = (y * width + x) * 4;
    rgba.set(equal ? [24, 24, 24, 255] : [255, 64, 150, 255], i);
  }
  return encodePNG(width, height, rgba);
}
