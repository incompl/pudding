// Capture the real WKWebView raster, shared by the screenshot suite and caliper.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodePNG, encodePNG } from './png.mjs';

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

export async function captureStable(windowId, file, beforeCapture) {
  let previous;
  for (let attempt = 0; attempt < 12; attempt++) {
    await beforeCapture();
    const bytes = captureWindowPng(windowId);
    const pixels = decodePNG(bytes);
    if (previous && samePixels(previous, pixels)) {
      await writeFile(file, bytes);
      return pixels;
    }
    previous = pixels;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Window did not settle: consecutive native captures differ. Check playback or animations.');
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
