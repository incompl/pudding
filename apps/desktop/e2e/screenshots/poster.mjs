// Mac App Store posters: marketing chrome around real captures.
//
// An App Store screenshot has to be exactly one of Apple's 16:10 sizes, and it
// carries the captions that say what the app is — the website images can't do
// that job. So this module composes, and nothing here resizes the app: the
// chrome (background, headline, shadows) is rendered in WebKit at the poster's
// size, and each scene's own native capture is laid into it at 1:1 device
// pixels. The app's raster reaches the store exactly as macOS drew it, which is
// also what keeps `screenshots:check` diffs meaningful.
//
// A poster is composed from one window or from several. A window is a whole app
// launch — that is what a scene is — so a multi-window poster is several
// captures placed by `poster.layout`; see the `store-sizes` scene.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { webkit } from '@playwright/test';
import { decodePNG, encodePNG } from './png.mjs';

// 1280 × 800 CSS px at the 2x the suite already requires is 2560 × 1600: an
// accepted App Store size, reached without a single resampled pixel.
export const FRAME = { width: 1280, height: 800 };
const SCALE = 2;

// Where a single-window capture sits inside the frame. A capture smaller than
// the box is centred in it rather than stretched. A poster that declares its own
// layout ignores this and positions every window itself.
const BOX = { x: 64, y: 120, width: 1152, height: 640 };

// The window a single-window poster captures at. It is deliberately narrower
// than BOX: a window stretched to the frame's full width is a letterbox no real
// window has, and this is the same 960 x 640 the documentation set uses (WINDOW
// in scenes.mjs), so the store shows the app in the shape every other image of
// it does. `placements` centres it, so what fills the space either side is the
// poster's own background rather than app pixels.
export const STORE_WINDOW = { width: 960, height: 640 };

// macOS rounds a window's corners and `screencapture -o` keeps that as alpha, so
// the poster's shadow shows through the notches and no fake corner is drawn. 16
// CSS px is the radius fitted to the alpha channel of a real capture (a circle
// through its edge at rows 0, 8, 16 and 24); re-measure if macOS changes it.
const CORNER_RADIUS = 16;

// The headline is centred in the band above the topmost window (see chromeHTML),
// so it can never run behind a window — but type is laid out by the browser, and
// a headline one word too long silently grows a line, which eats that band from
// both ends at once. This is the floor each of the two margins has to keep. 16px
// still admits a second line on the tightest band any poster has (the 120px of a
// single-window poster leaves 18px either side of two lines); a third fails.
const CAPTION_CLEARANCE = 16;

// Rendered chrome is sRGB; captures are tagged Display P3 (cICP 12/13/0/1). The
// two can't be blended as-is, and dropping the capture's profile would dull
// every accent in the image, so the chrome is converted into P3 and the output
// keeps the captures' own profile chunks. sRGB → Display P3, linear light:
const TO_P3 = [
  [0.822461969, 0.177538031, 0.0],
  [0.033194199, 0.966805801, 0.0],
  [0.017082631, 0.072397373, 0.910519996],
];
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
// Both spaces use the sRGB transfer curve, so only the primaries change.
const LINEAR = Array.from({ length: 256 }, (_, i) => toLinear(i / 255));
function chromeToP3(rgba) {
  const linear = LINEAR;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = linear[rgba[i]], g = linear[rgba[i + 1]], b = linear[rgba[i + 2]];
    for (let c = 0; c < 3; c++) {
      const [mr, mg, mb] = TO_P3[c];
      rgba[i + c] = Math.round(Math.min(1, Math.max(0, toGamma(mr * r + mg * g + mb * b))) * 255);
    }
  }
  return rgba;
}

// The colour chunks of a capture, carried onto the composed image so the store
// shows the app's colours in the space macOS captured them in.
function profileChunks(png) {
  const keep = new Set(['iCCP', 'cICP', 'sRGB', 'gAMA', 'cHRM']);
  const out = [];
  let off = 8;
  while (off < png.length) {
    const length = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (keep.has(type)) out.push(png.subarray(off, off + 12 + length));
    if (type === 'IDAT' || type === 'IEND') break;
    off += 12 + length;
  }
  return out;
}

// One profile for the whole poster, because one image can only carry one. Every
// window of a poster came off the same display through the same capture path, so
// they agree — and if a future one doesn't, blending them under a single profile
// would tint a window rather than fail, which is why this compares the bytes.
async function posterProfile(parts) {
  const chunks = await Promise.all(parts.map(async (part) => profileChunks(await readFile(part.file))));
  const [first, ...rest] = chunks;
  const key = (list) => list.map((chunk) => chunk.toString('base64')).join('|');
  const odd = rest.findIndex((list) => key(list) !== key(first));
  if (odd >= 0) {
    throw new Error(`${parts[odd + 1].panel} was captured in a different colour space than ${parts[0].panel}; ` +
      'a poster carries one profile, so these cannot be composed into one image.');
  }
  return first;
}

// `over`, laid on `under` at a device-pixel offset. A capture is opaque
// everywhere but its antialiased rounded corners, so this is the app's own bytes
// wherever it is opaque and whatever is already there inside the notches.
function composite(under, over, left, top, name) {
  if (left < 0 || top < 0 || left + over.width > under.width || top + over.height > under.height) {
    throw new Error(`The ${over.width}×${over.height} capture of ${name} does not fit the poster at (${left}, ${top})`);
  }
  for (let y = 0; y < over.height; y++) {
    for (let x = 0; x < over.width; x++) {
      const s = (y * over.width + x) * over.channels;
      const d = ((top + y) * under.width + left + x) * 4;
      const alpha = over.channels === 4 ? over.data[s + 3] : 255;
      if (!alpha) continue;
      for (let c = 0; c < 3; c++) {
        under.data[d + c] = alpha === 255
          ? over.data[s + c]
          : Math.round((over.data[s + c] * alpha + under.data[d + c] * (255 - alpha)) / 255);
      }
      under.data[d + 3] = 255;
    }
  }
  return under;
}

// Where every window of one poster lands, in device pixels, in paint order.
// Without a layout the poster holds a single window and centres it in BOX; the
// offsets stay integers in device pixels either way, so no capture is ever
// resampled by a half-pixel placement.
function placements(scene, parts) {
  const layout = scene.poster.layout;
  if (!layout) {
    if (parts.length !== 1) {
      throw new Error(`${scene.id} has ${parts.length} windows but no poster layout to place them by`);
    }
    const [only] = parts;
    return [{
      ...only,
      left: BOX.x * SCALE + Math.round((BOX.width * SCALE - only.pixels.width) / 2),
      top: BOX.y * SCALE + Math.round((BOX.height * SCALE - only.pixels.height) / 2),
    }];
  }
  const placed = layout.map((spot) => {
    const part = parts.find((item) => item.panel === spot.panel);
    if (!part) throw new Error(`${scene.id}'s poster layout places a window "${spot.panel}" that the scene has no panel for`);
    return { ...part, left: spot.x * SCALE, top: spot.y * SCALE };
  });
  const missing = parts.filter((part) => !layout.some((spot) => spot.panel === part.panel));
  if (missing.length) {
    throw new Error(`${scene.id} captures ${missing.map((part) => part.panel).join(', ')} but its poster layout never places ${missing.length > 1 ? 'them' : 'it'}`);
  }
  return placed;
}

function chromeHTML({ headline }, frames, band) {
  return `<!doctype html><meta charset="utf-8"><title>poster</title><style>
  html, body { margin: 0; padding: 0; }
  body {
    width: ${FRAME.width}px; height: ${FRAME.height}px; overflow: hidden;
    /* The same floor as the website's content band (the .site-content rule in
       apps/website/src/styles/global.css): dark enough to read as the app's own
       dark theme, light enough that a dark capture still separates from it.
       Note this whole style block is a template literal — no backticks. */
    background: #0f1311; color: #f1f1f1;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* Two soft washes in the app's own pistachio accent (--accent #b5d17a,
     --accent-dim #7e9152), so the poster reads as the same product as the
     windows sitting on it. */
  .wash {
    position: absolute; inset: 0;
    background:
      radial-gradient(1100px 520px at 10% -12%, rgba(181, 209, 122, 0.20), transparent 70%),
      radial-gradient(900px 620px at 108% 118%, rgba(126, 145, 82, 0.20), transparent 70%);
  }
  /* The caption owns the whole band above the topmost window and centres its
     line box in it, rather than hanging from a fixed top. That is what keeps the
     margin above the headline equal to the one below it on every poster in the
     set, whichever height the layout leaves: a single-window poster's band is
     BOX.y and the multi-window ones are taller (150, 158), and hard-coding one
     top balanced the tall bands and left the short one lopsided. Centring the
     line box, not the ink, is deliberate — half-leading is symmetric, so the
     headline sits in the same place whether or not its copy has a descender. */
  .caption {
    position: absolute; left: ${BOX.x}px; top: 0; height: ${band}px;
    width: ${FRAME.width - BOX.x * 2}px;
    display: flex; align-items: center;
  }
  /* Keep new copy near the length of what is there: a line more shrinks both of
     the band's margins, and the measurement below rules on them. */
  h1 { margin: 0; font-size: 38px; line-height: 1.1; font-weight: 640; letter-spacing: -0.015em; max-width: 1000px; }
  /* Transparent: an outer box-shadow is painted only outside the border box's
     rounded rectangle, so this contributes the shadow and nothing else — the
     captures supply every pixel of the windows themselves. */
  .frame {
    position: absolute; background: transparent;
    border-radius: ${CORNER_RADIUS}px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.62), 0 3px 10px rgba(0, 0, 0, 0.45);
  }
</style>
<div class="wash"></div>
<div class="caption"><h1>${escapeHTML(headline)}</h1></div>
${frames.map((frame) => `<div class="frame" style="left: ${frame.left}px; top: ${frame.top}px; ` +
  `width: ${frame.width}px; height: ${frame.height}px;"></div>`).join('\n')}`;
}

const escapeHTML = (text) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// WebKit renders the chrome, so the poster's type is laid out by the same engine
// as the app's. It never renders the app itself: a browser's idea of this app's
// pixels is exactly what this suite exists not to publish.
async function screenshotPage(page, html, size) {
  await page.setViewportSize(size);
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  return decodePNG(await page.screenshot({ type: 'png' }));
}

// Playwright's WebKit writes sRGB. If a future build starts writing the display's
// P3 instead, every chrome pixel would be converted twice and the posters would
// come out oversaturated — cheaper to catch on a 1×1 probe than in review.
async function assertSRGB(page) {
  const probe = await screenshotPage(page, '<body style="margin:0;background:rgb(181,209,122)">', { width: 1, height: 1 });
  const [r, g, b] = probe.data;
  if (r !== 181 || g !== 209 || b !== 122) {
    throw new Error(`The poster renderer is no longer writing sRGB: asked for 181,209,122 and got ${r},${g},${b}. ` +
      'Check its colour space before trusting the sRGB → Display P3 conversion in poster.mjs.');
  }
}

// One browser for every poster in the run. Each item is `{ scene, parts }`,
// where a part is one captured window: `{ panel, file, pixels }`. The return
// value is what each poster scene publishes, keyed by scene id.
export async function renderPosters(items, runDir) {
  const browser = await webkit.launch();
  const results = new Map();
  try {
    const page = await browser.newPage({ deviceScaleFactor: SCALE });
    await assertSRGB(page);
    for (const { scene, parts } of items) {
      const windows = placements(scene, parts);
      const frames = windows.map(({ left, top, pixels }) => ({
        left: left / SCALE, top: top / SCALE,
        width: pixels.width / SCALE, height: pixels.height / SCALE,
      }));
      const band = Math.min(...frames.map((frame) => frame.top));
      const html = chromeHTML(scene.poster, frames, band);
      const chrome = await screenshotPage(page, html, FRAME);
      if (chrome.width !== FRAME.width * SCALE || chrome.height !== FRAME.height * SCALE) {
        throw new Error(`Poster chrome came out ${chrome.width}×${chrome.height}; expected ${FRAME.width * SCALE}×${FRAME.height * SCALE}`);
      }
      // Measured, not assumed: the caption is the one part of a poster a browser
      // lays out, so how much room its type actually took is the one thing the
      // layout above cannot know. Centring makes the two margins equal, so this
      // reports the pair and fails on the band, not on a collision.
      const headline = await page.evaluate(() => {
        const box = document.querySelector('h1').getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      });
      const margins = [headline.top, band - headline.bottom];
      if (Math.min(...margins) < CAPTION_CLEARANCE) {
        throw new Error(`${scene.id}'s headline leaves ${margins[0].toFixed(1)}px above it and ` +
          `${margins[1].toFixed(1)}px below it in a ${band}px band: less than the ${CAPTION_CLEARANCE}px ` +
          'each margin has to keep. Shorten the copy or lower the windows.');
      }
      let composed = { ...chrome, data: chromeToP3(chrome.data) };
      for (const window of windows) {
        composed = composite(composed, window.pixels, window.left, window.top, window.panel);
      }
      // No alpha channel: Apple's screenshot specification forbids one outright,
      // and every pixel here is opaque by construction anyway (see composite).
      const bytes = encodePNG(composed.width, composed.height, composed.data,
        await posterProfile(parts), { rgb: true });
      // The checks that matter most are the ones App Store Connect would make
      // instead — it rejects the upload outright, long after this run would have
      // reported success.
      const out = decodePNG(bytes);
      if (out.width !== 2560 || out.height !== 1600) {
        throw new Error(`Poster ${scene.id} is ${out.width}×${out.height}, not an accepted App Store size`);
      }
      if (out.channels !== 3) {
        throw new Error(`Poster ${scene.id} came out with ${out.channels} channels; the App Store takes no alpha channel`);
      }
      const target = path.join(runDir, `${scene.id}-poster.png`);
      await writeFile(target, bytes);
      results.set(scene.id, { file: target, pixels: out });
    }
  } finally {
    await browser.close();
  }
  return results;
}
