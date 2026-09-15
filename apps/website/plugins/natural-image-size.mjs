import { closeSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Screenshots are captured at deviceScaleFactor 2, so a 1920px-wide PNG is
 * really 960 CSS px of app. Astro emits the pixel dimensions as width/height
 * and CSS can't halve those on its own, so cap each Markdown image at its
 * natural size here. Images still shrink to fit a narrow column; they just
 * never upscale past the size the app was captured at.
 */
export const naturalImageSize = {
  name: 'natural-image-size',
  element: {
    filter: ['img'],
    visit(node, ctx) {
      const src = node.properties?.src;
      if (typeof src !== 'string' || !src.toLowerCase().endsWith('.png')) return;
      if (!ctx.fileURL) return;
      const width = pngWidth(resolve(dirname(fileURLToPath(ctx.fileURL)), src));
      if (!width) return;
      // Only the natural size, as a custom property: the stylesheet folds it
      // into a max-width alongside 100%, so this can never widen a container.
      const cap = `--natural-width: ${width / 2}px`;
      const style = node.properties.style;
      ctx.setProperty(node, 'style', style ? `${style}; ${cap}` : cap);
    },
  },
};

/** Width from a PNG's IHDR chunk: 8-byte signature, length, type, then width. */
function pngWidth(path) {
  let fd;
  try {
    const header = Buffer.alloc(24);
    fd = openSync(path, 'r');
    if (readSync(fd, header, 0, 24, 0) < 24) return null;
    if (header.toString('ascii', 12, 16) !== 'IHDR') return null;
    return header.readUInt32BE(16);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
