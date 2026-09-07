import { invoke } from "@tauri-apps/api/core";

import { app } from "./state";
import type { RecentItem, RecentKind } from "./types";

// Persisted store key + cap for the Open Recent list. The list is mixed —
// playlists and loose audio files share it, distinguished by `kind` (the native
// submenu draws a different glyph per kind), so the cap covers both.
export const KEY_RECENT_ITEMS = "recentPlaylists";
const RECENT_ITEMS_MAX = 12;

// Only *opening* fills this list: ⌘O, a Finder double-click / "Open With", an
// Open Recent row, and creating a playlist (New / Save Queue as Playlist — you
// end up with that document open). Browsing or playing something already in the
// library deliberately does not — the library is how you reach those, and
// letting it write here would push real openings off the bottom of a short list.
export function addRecentItem(path: string, name: string, kind: RecentKind): void {
  app.recentItems = [
    { path, name, kind },
    ...app.recentItems.filter((r) => r.path !== path),
  ].slice(0, RECENT_ITEMS_MAX);
  void persistRecentItems();
  syncRecentItemsMenu();
}

// Drop an entry whose file turned out to be gone. Both open paths call this from
// their read-failure branch, so a dead row prunes itself the first time it's
// clicked rather than lingering forever.
export function removeRecentItem(path: string): void {
  app.recentItems = app.recentItems.filter((r) => r.path !== path);
  void persistRecentItems();
  syncRecentItemsMenu();
}

// Patch an entry *in place* if it's on the list, leaving its position alone —
// for renames and moves, which change what an existing entry should say without
// being an opening. A no-op when the path was never opened.
export function updateRecentItem(path: string, patch: Partial<RecentItem>): void {
  if (!app.recentItems.some((r) => r.path === path)) return;
  app.recentItems = app.recentItems.map((r) => (r.path === path ? { ...r, ...patch } : r));
  void persistRecentItems();
  syncRecentItemsMenu();
}

export async function persistRecentItems(): Promise<void> {
  await app.store.set(KEY_RECENT_ITEMS, app.recentItems);
  await app.store.save();
}

export function syncRecentItemsMenu(): void {
  void invoke("set_recent_items", { items: app.recentItems });
}

// Hydrate from the store. Entries written before the list held tracks have no
// `kind`; they were all playlists, so default them rather than dropping them.
export function hydrateRecentItems(stored: RecentItem[] | null | undefined): void {
  app.recentItems = (stored ?? []).map((r) => ({ ...r, kind: r.kind ?? "playlist" }));
}

// --- Native row glyphs ---
// AppKit draws the Open Recent rows, not the DOM, so the native menu needs its two
// glyphs as bitmaps. Rather than redraw them in Rust — a second copy of an icon,
// free to drift from the one on screen — rasterize the app's own CSS mask glyphs
// here, where they already live, and hand them over once at boot. The backend
// marks the result a template image, so AppKit tints it with the row's text color
// exactly as `background-color` tints the mask in the tree.
const ICON_PX = 32; // 16pt at 2x — the only scale macOS draws menus at

async function rasterizeGlyph(cssVar: string): Promise<string> {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  const url = raw.replace(/^url\(["']?/, "").replace(/["']?\)$/, "");
  // These glyphs carry a viewBox and no width/height, and WebKit refuses to draw
  // an <img> SVG with no intrinsic size. Patch one in — on the percent-encoded
  // form, so the data URL never has to round-trip through a decode.
  const sized = url.replace("%3Csvg ", `%3Csvg width='${ICON_PX}' height='${ICON_PX}' `);
  const img = new Image();
  img.src = sized;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = ICON_PX;
  canvas.height = ICON_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context");
  ctx.drawImage(img, 0, 0, ICON_PX, ICON_PX);
  // PNG rather than raw pixels: NSImage decodes it natively on the other side.
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

// Awaited once at boot, before the first syncRecentItemsMenu, so the very first
// draw of the submenu already has its icons. A failure here costs the icons and
// nothing else, so it logs rather than throwing.
export async function primeRecentIcons(): Promise<void> {
  try {
    const [playlist, track] = await Promise.all([
      rasterizeGlyph("--playlist-icon"),
      rasterizeGlyph("--eighth-note-icon"),
    ]);
    await invoke("set_recent_icons", { playlist, track });
  } catch (e) {
    console.error("could not rasterize the Open Recent glyphs", e);
  }
}
