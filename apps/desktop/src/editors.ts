// Editor surfaces: the generic inline-editor form builder, the right-pane editor
// face (track metadata + stream add/edit mount here), and the in-place inline
// rename (label → text input). The station-specific editors live in
// streams-view.ts; this module owns the shared machinery they build on.

import { invoke } from "@tauri-apps/api/core";
import { effect } from "@preact/signals-core";
import { h } from "./dom";
import type {
  InlineEditorOptions,
  FileEntry,
  ContextMenuItem,
} from "./types";
import {
  app,
  paneEditor,
  currentNodePath,
  dismissRightPanel,
  isNotDownloaded,
} from "./state";
import { paneEditorView, queueTitleEl } from "./dom-refs";
import { refreshLibrary } from "./library";
import { renameOpenPlaylist } from "./playlists";
import { curatedList } from "./queue";
import { applyTagUpdate } from "./track-facts";

export function buildInlineEditor(opts: InlineEditorOptions): HTMLFormElement {
  const form = h("form", { class: "inline-editor" });
  if (opts.heading) {
    form.appendChild(
      h("div", { class: "inline-editor-heading", text: opts.heading }),
    );
  }
  const inputs = new Map<string, HTMLInputElement>();
  // Browse buttons are wired after submitBtn/syncEnabled exist (a pick updates
  // the disabled state), so collect them during the build pass.
  const browsers: { input: HTMLInputElement; browse: () => Promise<string | null> }[] = [];
  for (const field of opts.fields) {
    const input = h("input", {
      attrs: { type: "text", placeholder: field.placeholder ?? false },
    });
    input.value = field.value ?? "";
    inputs.set(field.key, input);
    form.appendChild(
      h(
        "label",
        { class: "inline-editor-field" },
        h("span", { class: "inline-editor-label", text: field.label }),
        input,
        field.browse &&
          h("button", {
            class: "inline-editor-browse",
            attrs: { type: "button" },
            text: "Choose...",
          }),
      ),
    );
    if (field.browse) browsers.push({ input, browse: field.browse });
  }

  const cancelBtn = h("button", {
    class: "inline-editor-cancel",
    attrs: { type: "button" },
    text: "Cancel",
    on: { click: () => opts.onCancel() },
  });
  const submitBtn = h("button", {
    class: "inline-editor-submit",
    attrs: { type: "submit" },
    text: opts.submitLabel,
  });
  form.appendChild(
    h("div", { class: "inline-editor-actions" }, cancelBtn, submitBtn),
  );

  // Optional note below the buttons, shown only while `blocked` holds (e.g.
  // "Can't save while this track is playing"). It sits under the disabled Save
  // so it reads as the answer to "why didn't that work?". A lock glyph marks it
  // as an expected constraint rather than an error. Present in the DOM from the
  // start so toggling it doesn't reflow the actions row.
  let noteEl: HTMLElement | null = null;
  if (opts.blocked && opts.blockedNote) {
    noteEl = h(
      "div",
      { class: "inline-editor-note hidden" },
      h("span", { class: "inline-editor-note-icon" }),
      h("span", { text: opts.blockedNote }),
    );
    form.appendChild(noteEl);
  }

  const required = opts.fields.filter((f) => f.required).map((f) => f.key);
  const syncEnabled = (): void => {
    const blocked = opts.blocked?.() ?? false;
    submitBtn.disabled = blocked || required.some((key) => !inputs.get(key)!.value.trim());
    noteEl?.classList.toggle("hidden", !blocked);
  };
  for (const input of inputs.values()) input.addEventListener("input", syncEnabled);
  for (const { input, browse } of browsers) {
    const buttonRow = input.parentElement!.querySelector(".inline-editor-browse")!;
    buttonRow.addEventListener("click", async () => {
      const picked = await browse();
      if (picked != null) {
        input.value = picked;
        syncEnabled();
      }
    });
  }
  syncEnabled();

  // Keep the Save gate live: re-run syncEnabled whenever a signal read by
  // `blocked` changes. There's no teardown hook for the editor, so the effect
  // self-disposes once the form leaves the DOM (Save/Cancel re-render the row).
  // The first run happens before the caller mounts the form, so the disconnect
  // check is gated on `mounted` to avoid disposing before it's ever shown.
  if (opts.blocked) {
    let mounted = false;
    const stop = effect(() => {
      opts.blocked!(); // subscribe to whatever signals the predicate reads
      if (mounted && !form.isConnected) {
        stop();
        return;
      }
      syncEnabled();
    });
    mounted = true;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (submitBtn.disabled) return;
    const values: Record<string, string> = {};
    for (const [key, input] of inputs) values[key] = input.value.trim();
    void opts.onSubmit(values);
  });
  // Esc cancels from anywhere in the form (matching the rename affordance).
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      opts.onCancel();
    }
  });
  // Focus the first field once the form is in the DOM.
  queueMicrotask(() => inputs.values().next().value?.focus());
  return form;
}
// --- Right-pane editor face ---
//
// Editing a track's tags or a stream is a *right-pane mode*, not an inline row
// swap: the context menus that trigger it (tree, Songs/album/artist leaf lists,
// queue/playlist for tracks; the streams list for stations) build a form and open
// the editor face over whatever the pane was showing. Closing it clears the face
// signal and the pane falls back to the hero/list it was on — so you land back
// where you were, no saved "return to" state needed. A row swap couldn't work
// uniformly for tags: album/artist lists derive membership from the very tags
// being edited, so an in-place patch would strand an ejected track; here the edit
// is decoupled from any row and applyTagUpdate refreshes each surface after the
// write. Streams follow the same face for consistency.

// Which editor the face is showing ("metadata" or "stream"), or null when it's
// closed. Only its presence drives the `.show-editor` face toggle; the kind lets
// the streams-writability effect close just the stream editor. The form itself is
// rebuilt on each open, so this needn't carry any per-edit state.


// Close the editor face, revealing whatever face was underneath. Idempotent.
export function closePaneEditor(): void {
  paneEditor.value = null;
  paneEditorView.replaceChildren();
}

// Mount `form` as the editor face and reveal it. `kind` tags which editor is up.
export function openPaneEditor(kind: "metadata" | "stream", form: HTMLElement): void {
  // The editor mounts as a face of the right pane, which a Settings/About panel
  // would otherwise cover — reveal the pane so the editor is visible.
  dismissRightPanel();
  paneEditorView.replaceChildren(form);
  paneEditor.value = kind;
}

// Open the metadata editor for `path`, prefilled from `seed` (its current tags,
// read fresh from disk — see editMetadataItem). Building the form here means one
// editor surface no matter which menu opened it. Save writes the tags, refreshes
// every surface that shows the track (applyTagUpdate), and closes; Cancel closes.
function openMetadataEditor(path: string, seed: FileEntry): void {
  // Empty or non-positive parses to null (clears the tag); disc/track are 1-based.
  const parsePositive = (s: string): number | null => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const editor = buildInlineEditor({
    fields: [
      { key: "title", label: "Title", value: seed.title ?? "", placeholder: seed.name },
      { key: "artist", label: "Artist", value: seed.artist ?? "" },
      { key: "album", label: "Album", value: seed.album ?? "" },
      { key: "albumArtist", label: "Album Artist", value: seed.albumArtist ?? "" },
      { key: "disc", label: "Disc", value: seed.disc?.toString() ?? "" },
      { key: "track", label: "Track", value: seed.track?.toString() ?? "" },
    ],
    submitLabel: "Save",
    heading: `Editing ${seed.name}`,
    // Saving rewrites the file in place — unsafe while the engine holds it open
    // (you can open this for the playing track, or playback may advance into it
    // while the editor is up). Gate Save on that, live.
    blocked: () => currentNodePath.value === path,
    blockedNote: "Can't save while this track is playing",
    onCancel: closePaneEditor,
    onSubmit: async (values) => {
      // Defensive re-check: the reactive gate keeps Save disabled while playing,
      // so this only trips on a same-tick race. Leave the form up rather than
      // rewriting the file under the decoder.
      if (currentNodePath.value === path) return;
      let res: FileEntry;
      try {
        res = await invoke<FileEntry>("write_tags", {
          path,
          title: values.title || null,
          artist: values.artist || null,
          albumArtist: values.albumArtist || null,
          album: values.album || null,
          disc: parsePositive(values.disc),
          track: parsePositive(values.track),
        });
      } catch (e) {
        console.error("write_tags failed", e);
        return; // leave the form up so the user can correct and retry
      }
      applyTagUpdate(path, res);
      closePaneEditor();
    },
  });
  openPaneEditor("metadata", editor);
}

// The single "Edit metadata..." context-menu verb, shared by every track surface.
// Reads the file's tags fresh from disk before opening — a view carries only a
// partial row (a SearchTrack from Songs/album/artist lists has no album-artist or
// disc), so seeding the editor from the row would let a save write those fields
// back empty and wipe them. read_file_tags returns the whole tag set.
//
// Greyed out while the file is still cloud-only. `read_file_tags` is synchronous
// and reads the whole file, so on a dataless file it would materialize it — a
// download, on the UI thread, with the window frozen for its duration and no way
// to cancel. Playing such a track is the one action that downloads it (audio.rs
// parks a worker thread on the fetch); once it lands, the row's "(Not
// downloaded)" clears and this comes back with it.
// The verb's actual work, callable on its own: read the tags fresh, then open
// the editor on them. Separate from the menu item so the e2e/screenshot bridge
// can reach the editor face, which no native context menu can open for it.
export async function editTags(path: string): Promise<void> {
  let seed: FileEntry;
  try {
    seed = await invoke<FileEntry>("read_file_tags", { path });
  } catch (e) {
    console.error("read_file_tags failed", e);
    return;
  }
  openMetadataEditor(path, seed);
}

export function editMetadataItem(track: { path: string; notDownloaded?: boolean }): ContextMenuItem {
  return {
    label: "Edit metadata...",
    disabled: isNotDownloaded(track),
    action: () => editTags(track.path),
  };
}

// --- Inline rename editing ---
// Turns a label in place into a text input: the label's current content is hidden
// and an input takes its slot. Commits on Enter or blur, cancels on Escape. This
// replaces the old modal prompt so renaming the open playlist stays on its header
// title rather than interrupting with a dialog.
export function editInline(
  host: HTMLElement,
  initial: string,
  onCommit: (value: string) => void,
): void {
  // Guard against a second click (on the host, the pencil, or the input itself)
  // reopening an edit that's already in progress.
  if (host.querySelector(":scope > .inline-edit")) return;
  app.inlineEditing = true;
  // Lock the row to its current height for the duration of the edit. The input's
  // line box can be a hair shorter than the label it replaces (their line-heights
  // differ across contexts); if the row shrinks while the panel is scrolled to its
  // bottom, the browser clamps scrollTop down and the list appears to creep up.
  // Pinning the height keeps swapping in the input from changing content height.
  const prevMinHeight = host.style.minHeight;
  const prevBoxSizing = host.style.boxSizing;
  const lockHeight = host.getBoundingClientRect().height;
  host.style.boxSizing = "border-box";
  host.style.minHeight = `${lockHeight}px`;
  const hidden = Array.from(host.children) as HTMLElement[];
  for (const el of hidden) el.style.display = "none";
  const input = h("input", {
    class: "inline-edit",
    attrs: { type: "text", autocomplete: "off" },
  });
  input.value = initial;
  input.spellcheck = false;
  host.appendChild(input);
  // preventScroll: focusing an element otherwise scrolls it into view. Harmless on
  // the header (already visible, outside any scroller), but in a long, scrolled
  // tree it yanks the panel to the row — one of the two causes of the old
  // "scroll on edit" bug (the other being a full renderTree; see renameTreePlaylist).
  input.focus({ preventScroll: true });
  input.select();
  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    app.inlineEditing = false;
    const value = input.value;
    input.remove();
    host.style.minHeight = prevMinHeight;
    host.style.boxSizing = prevBoxSizing;
    for (const el of hidden) el.style.display = "";
    if (commit) onCommit(value);
    // Flush any watcher refresh that arrived while the edit was open (e.g. the
    // scan from a prior rename's write). Runs after onCommit so this rename's own
    // write is included in the single rebuild.
    if (app.refreshDeferredWhileEditing) {
      app.refreshDeferredWhileEditing = false;
      void refreshLibrary();
    }
  };
  input.addEventListener("keydown", (e) => {
    // Keep Enter/Escape (and any typing) from reaching the tree/global handlers.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  // The input sits inside a row/label whose click plays; swallow those so
  // interacting with the field never triggers playback or a re-edit.
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}

// Start renaming the open playlist from its header — clicking the title text or
// the pencil both land here. A no-op unless a real playlist is open.
export function startTitleEdit(): void {
  const list = curatedList();
  if (!list?.sourcePath) return;
  const host = queueTitleEl.parentElement;
  if (!host) return;
  editInline(host, list.title, (value) => void renameOpenPlaylist(value));
}
