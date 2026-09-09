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

// Whether the drop is worth lighting the overlay for. A folder is the case with
// no extension to read, so "no extension" counts as droppable — which also means
// a `README` gets a hopeful highlight and then does nothing. That's the right way
// round: the alternative refuses folders whose name happens to contain a dot
// (`Bowie - Low (1977)` is fine, `Vol.2` is not), and silently rejecting a real
// music folder is a much worse failure than a moment of optimism about a text file.
function looksDroppable(path: string): boolean {
  return isAudioPath(path) || isPlaylistPath(path) || extensionOf(path) === "";
}

let dropOverlay: HTMLElement;

// Wire the window up as a drop target. Called once from init(); the listener
// lives for the life of the app, so its unlisten is deliberately dropped.
export async function initFileDrop(): Promise<void> {
  dropOverlay = document.getElementById("drop-overlay") as HTMLElement;
  await getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter") {
      // `over` fires continuously and carries no paths, so the accept/reject
      // decision is made once here, on enter, and simply held until the gesture
      // ends. Nothing to do on `over` at all.
      showOverlay(p.paths.some(looksDroppable));
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

async function handleDrop(paths: string[]): Promise<void> {
  const usable = paths.filter(looksDroppable);
  if (usable.length === 0) return;

  // A lone file is the Open With case exactly — same routing, same recents entry,
  // same lone-playback teardown — so hand it to the same function rather than a
  // parallel copy that could drift.
  if (usable.length === 1 && (isAudioPath(usable[0]) || isPlaylistPath(usable[0]))) {
    openAssociatedFile(usable[0]);
    return;
  }

  let tracks: SearchTrack[];
  try {
    tracks = await invoke<SearchTrack[]>("dropped_tracks", { paths: usable });
  } catch (e) {
    console.error("dropped_tracks failed", usable, e);
    return;
  }
  // An empty folder, or one with nothing playable in it. playQueue would bail on
  // its own, but bail here too so the intent is stated rather than inferred: a
  // fruitless drop must leave whatever is currently playing completely alone.
  if (tracks.length === 0) return;

  // One dropped folder keys its pool the same way Play folder does, so dropping a
  // folder you are already playing is recognized as the same pool rather than
  // opening a duplicate of it. A mixed/multi drop is a one-off, keyed by time.
  const single = usable.length === 1;
  playQueue(
    {
      kind: "folder",
      title: single ? basename(usable[0]) : "Dropped items",
      subtitle: trackCountSubtitle(tracks),
      tracks,
    },
    single ? `queue:folder:${usable[0]}` : `queue:drop:${Date.now()}`,
  );
}
