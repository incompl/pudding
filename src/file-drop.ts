// OS file drop: what happens when the user drags music out of Finder and onto
// the window.
//
// Distinct from drag-drop.ts, which is the *internal* pointer-based drag for
// curation (reorder a list row, insert tree tracks into the open playlist). This
// module handles the native side — Tauri's own drag-drop handler, which the
// window already had enabled (`dragDropEnabled` defaults to true) and which is
// precisely why the curation drag had to be built on pointer events: the native
// handler swallows HTML5 dragstart/drop inside the webview. So there is no
// conflict between the two; they never see the same gesture.
//
// The gesture routes exactly the way an OS "Open With" does (openAssociatedFile),
// and for the same reason — a file dropped on the player and a file opened with
// the player are the same request:
//
//   one audio file      → lone playback, like Open With
//   one .m3u/.m3u8      → open it for browsing, like Open With
//   a folder, or        → flatten to a queue and play it. A folder is more than
//   several items         one track, so it becomes the thing that holds more
//                         than one track; playing it matches the single-file
//                         case, where the drop is audible immediately.
//
// The flatten is a backend walk (`dropped_tracks`), not `folder_tracks`: a drop
// can carry any folder on the disk, including one outside every library root —
// which the library index has never heard of.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { SearchTrack } from "./types";
import { openAssociatedFile, playQueue, trackCountSubtitle } from "./main";

// Mirrors AUDIO_EXTS in src-tauri/src/lib.rs. Duplicated rather than fetched
// because it is only used to route the drop *before* the backend is asked: an
// audio file goes straight to lone playback with no round trip at all. A drift
// between the two lists costs a needless round trip, never a wrong answer — the
// backend re-filters what it walks.
const AUDIO_EXTS = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "aiff", "aif"];

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function isAudioPath(path: string): boolean {
  return AUDIO_EXTS.includes(extensionOf(path));
}

function isPlaylistPath(path: string): boolean {
  const ext = extensionOf(path);
  return ext === "m3u" || ext === "m3u8";
}

// Extensions that name a *file*, confidently enough to turn the overlay off for
// them. Only ever consulted to decide what the overlay promises, never to decide
// what gets dropped — see handleDrop.
//
// A blocklist rather than an allowlist because of which way the two mistakes cut.
// The thing we must never miss is a folder, and a folder's name, when it has a dot
// in it at all, ends in something like `2` (`Vol.2`), `eno` (`Bowie feat. Eno`) or
// `1977)` — never in `txt`. So listing what is definitely a file leaves folders
// alone, while listing what might be a folder cannot be done at all. Anything not
// named here — every extensionless name, every dotted folder, every audio format
// the list below has not heard of — still lights the overlay.
const FILE_EXTS = new Set([
  // documents
  "txt", "md", "rtf", "pdf", "doc", "docx", "pages", "odt",
  "xls", "xlsx", "numbers", "csv", "ppt", "pptx", "key",
  // images
  "png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "svg", "tiff", "tif", "bmp", "ico",
  // video
  "mp4", "mov", "m4v", "avi", "mkv", "webm", "mpg", "mpeg", "wmv",
  // archives and disk images
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "dmg", "iso", "pkg",
  // code and config
  "json", "xml", "yml", "yaml", "toml", "html", "htm", "css", "js", "ts", "py", "rs", "sh",
]);

// What the overlay should promise for this drag. Yes to anything that could be a
// folder, which is anything not named above: a name cannot prove something *is* a
// folder, and there is nothing but the name to go on — under the App Sandbox the
// dropped paths only become ours to stat on `drop`, not on hover.
function looksPlayable(path: string): boolean {
  return !FILE_EXTS.has(extensionOf(path));
}

let dropOverlay: HTMLElement;

// Wire the window up as a drop target. Called once from init(); the listener
// lives for the life of the app, so its unlisten is deliberately dropped.
export async function initFileDrop(): Promise<void> {
  dropOverlay = document.getElementById("drop-overlay") as HTMLElement;
  await getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter") {
      // `over` fires continuously and carries no paths, so the decision is made
      // once here, on enter, and simply held until the gesture ends. Nothing to do
      // on `over` at all.
      showOverlay(p.paths.some(looksPlayable));
    } else if (p.type === "drop") {
      showOverlay(false);
      void handleDrop(p.paths);
    } else if (p.type === "leave") {
      showOverlay(false);
    }
  });
}

function showOverlay(visible: boolean): void {
  dropOverlay.classList.toggle("hidden", !visible);
}

// Everything dropped goes to the backend as it came — including the paths the
// overlay just declined to light up for. `dropped_tracks` is the only layer that
// can tell a folder from a file (it stats each path, walks the directories, and
// keeps only audio), so a name-based filter here could only throw away paths it
// would have known exactly what to do with.
//
// Which is what keeps `looksPlayable` honest: it decides what the overlay claims,
// never what happens. A folder actually named `Notes.txt` gets no highlight and
// then plays anyway.
async function handleDrop(paths: string[]): Promise<void> {
  if (paths.length === 0) return;

  // A lone file is the Open With case exactly — same routing, same recents entry,
  // same lone-playback teardown — so hand it to the same function rather than a
  // parallel copy that could drift. Name-based on purpose: it saves the round trip
  // on the commonest drop there is, and guessing wrong costs an open that fails and
  // self-heals rather than a silent no-op.
  if (paths.length === 1 && (isAudioPath(paths[0]) || isPlaylistPath(paths[0]))) {
    openAssociatedFile(paths[0]);
    return;
  }

  let tracks: SearchTrack[];
  try {
    tracks = await invoke<SearchTrack[]>("dropped_tracks", { paths });
  } catch (e) {
    console.error("dropped_tracks failed", paths, e);
    return;
  }
  // An empty folder, one with nothing playable in it, or a drop that was never
  // music at all. playQueue would bail on its own, but bail here too so the intent
  // is stated rather than inferred: a fruitless drop must leave whatever is
  // currently playing completely alone.
  if (tracks.length === 0) return;

  // One dropped folder keys its pool the same way Play folder does, so dropping a
  // folder you are already playing is recognized as the same pool rather than
  // opening a duplicate of it. A mixed/multi drop is a one-off, keyed by time.
  const single = paths.length === 1;
  playQueue(
    {
      kind: "folder",
      title: single ? basename(paths[0]) : "Dropped items",
      subtitle: trackCountSubtitle(tracks),
      tracks,
    },
    single ? `queue:folder:${paths[0]}` : `queue:drop:${Date.now()}`,
  );
}
