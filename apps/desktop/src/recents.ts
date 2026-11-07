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
export function addRecentItem(
  path: string,
  name: string,
  kind: RecentKind,
  bookmark?: string,
): void {
  app.recentItems = [
    { path, name, kind, ...(bookmark ? { bookmark } : {}) },
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

export interface RecentAccess {
  path: string;
  // Null means this platform has no security-scoped bookmarks; ordinary paths
  // remain the right representation there.
  bookmark: string | null;
}

// Prepare an item for opening without ever touching it at hydrate time. New
// opens freeze the picker/Finder/drop grant first; old rows resolve their stored
// grant. Both commands run before filesystem reads, so the backend and the audio
// thread receive the same live authorization rather than a path that only looks
// valid.
//
// A stored blob is a *cache* of a grant, not the identity of the file, so a blob
// that no longer resolves must not be reported as a file that is no longer there.
// Blobs die for reasons that have nothing to do with the track: they are keyed to
// the signing identity (so every dev rebuild orphans the whole list), and a
// FileProvider volume — iCloud Drive, Dropbox, Proton Drive, anything under
// ~/Library/CloudStorage — invalidates every bookmark into it when its domain is
// re-created, which the provider does on its own schedule. The symptom was a file
// that plays from the tree and from Finder but refuses to open from a drop or from
// Open Recent, with "it may have moved" over a track that had not moved at all.
//
// So a dead blob falls through to the same path a never-opened file takes: mint a
// fresh one from the path. That is not a workaround for the sandbox but the honest
// order of trust — the grant we can take *now* outranks the one we wrote down. It
// also cannot paper over a real absence: minting a bookmark for a file that is
// gone (or that the sandbox will not extend to) fails in its own right, and the
// caller still gets the error it would have shown anyway.
export async function accessRecentItem(path: string): Promise<RecentAccess> {
  const existing = app.recentItems.find((item) => item.path === path);
  if (existing?.bookmark) {
    const resolved = await resolveStoredGrant(existing.bookmark);
    if (resolved) return persistAccess(existing, resolved);
  }

  const minted = await invoke<string | null>("bookmark_recent_item", { path });
  if (!minted) return { path, bookmark: null };
  const resolved = await invoke<RecentAccess & { bookmark: string }>("resolve_recent_item", {
    bookmark: minted,
  });
  return existing ? persistAccess(existing, resolved) : resolved;
}

// Resolve a blob we wrote down earlier, or null if it is no longer good for
// anything. Null rather than a throw: the caller has a path and can re-derive, so
// this is a cache miss, not a failure — the one case where swallowing the error is
// right, which is why it is swallowed here and nowhere else in this file.
async function resolveStoredGrant(
  bookmark: string,
): Promise<(RecentAccess & { bookmark: string }) | null> {
  try {
    return await invoke<RecentAccess & { bookmark: string }>("resolve_recent_item", { bookmark });
  } catch (e) {
    console.warn("stored grant for a recent item no longer resolves; re-deriving it", e);
    return null;
  }
}

// Write back whatever resolution learned: a path the bookmark followed to its new
// home, or a blob that was refreshed (which a re-mint always is). Keeps the row's
// position — reopening is not a new opening.
function persistAccess(
  existing: RecentItem,
  resolved: RecentAccess & { bookmark: string },
): RecentAccess {
  if (resolved.path !== existing.path || resolved.bookmark !== existing.bookmark) {
    updateRecentItem(existing.path, { path: resolved.path, bookmark: resolved.bookmark });
  }
  return resolved;
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
