// Editor surfaces: the generic inline-editor form builder, the right-pane editor
// face (track metadata + stream add/edit mount here), and the in-place inline
// rename (label → text input). The station-specific editors live in
// streams-view.ts; this module owns the shared machinery they build on.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { effect } from "@preact/signals-core";
import { h } from "./dom";
import type {
  InlineEditorOptions,
  InlineEditorArtwork,
  ArtworkEdit,
  ArtworkPick,
  EditorTags,
  FieldValidator,
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

// The artwork well: a preview of the file's picture, a Choose... that swaps in a
// picked image, and a Remove that takes it out. Three states and no more (see
// ArtworkEdit) — a save that didn't touch the well leaves the file's picture
// untouched, which is what keeps tag edits from re-writing every cover in a
// library. Undo is Cancel: Remove always means remove, even after a Choose, so
// the two buttons never change meaning under the pointer.
function buildArtworkField(opts: InlineEditorArtwork): {
  row: HTMLElement;
  state: () => ArtworkEdit;
} {
  let edit: ArtworkEdit = { kind: "keep" };
  const img = h("img", { class: "artwork-well-image", attrs: { alt: "" } });
  const placeholder = h("span", { class: "artwork-well-empty", text: "No artwork" });
  const well = h("div", { class: "artwork-well" }, img, placeholder);
  const removeBtn = h("button", {
    class: "inline-editor-browse",
    attrs: { type: "button" },
    text: "Remove",
  });
  // Errors from the picker (an unsupported file, one too large to embed) land
  // here rather than in an alert: the well is where the mistake was made, and the
  // message clears the moment a good pick replaces it.
  const errorEl = h("div", { class: "artwork-well-error hidden" });

  // The chosen image's preview, held apart from `edit` (which carries only the
  // path the backend needs) so a re-render doesn't re-read the file.
  let picked: string | null = null;
  const shown = (): string | null => {
    if (edit.kind === "remove") return null;
    if (edit.kind === "set") return picked;
    return opts.current;
  };
  const render = (): void => {
    const src = shown();
    img.hidden = src == null;
    placeholder.hidden = src != null;
    if (src) img.src = src;
    // Nothing to remove when the well is already empty; the button would be a
    // no-op dressed as an action.
    removeBtn.hidden = src == null;
  };

  const chooseBtn = h("button", {
    class: "inline-editor-browse",
    attrs: { type: "button" },
    text: "Choose...",
    on: {
      click: async () => {
        const pick: ArtworkPick | null = await opts.choose();
        if (pick == null) return; // dialog dismissed
        if (!pick.ok) {
          errorEl.textContent = pick.message;
          errorEl.classList.remove("hidden");
          return;
        }
        errorEl.classList.add("hidden");
        picked = pick.dataUrl;
        edit = { kind: "set", path: pick.path };
        render();
      },
    },
  });
  removeBtn.addEventListener("click", () => {
    errorEl.classList.add("hidden");
    edit = { kind: "remove" };
    render();
  });
  render();

  const row = h(
    "div",
    { class: "inline-editor-field inline-editor-artwork" },
    h("span", { class: "inline-editor-label", text: opts.label }),
    well,
    h("div", { class: "artwork-well-actions" }, chooseBtn, removeBtn, errorEl),
  );
  return { row, state: () => edit };
}

export function buildInlineEditor(opts: InlineEditorOptions): HTMLFormElement {
  const form = h("form", { class: "inline-editor" });
  if (opts.heading) {
    form.appendChild(
      h("div", { class: "inline-editor-heading", text: opts.heading }),
    );
  }
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  // Browse buttons are wired after submitBtn/syncEnabled exist (a pick updates
  // the disabled state), so collect them during the build pass.
  const browsers: {
    input: HTMLInputElement | HTMLTextAreaElement;
    browse: () => Promise<string | null>;
  }[] = [];
  // Validation is tracked per *row*, not per input: a row can hold two fields (a
  // number and its total) and has one line beneath it to explain either.
  const rows: {
    error: HTMLElement;
    checks: { input: HTMLInputElement | HTMLTextAreaElement; validate: FieldValidator }[];
  }[] = [];
  // The artwork well, if this form has one. Built first so it sits above the
  // fields: it is the file's face, and the fields read as captions under it.
  const artwork = opts.artwork ? buildArtworkField(opts.artwork) : null;
  if (artwork) form.appendChild(artwork.row);
  const mkInput = (
    value: string | undefined,
    opt: { numeric?: boolean; multiline?: boolean; placeholder?: string } = {},
  ): HTMLInputElement | HTMLTextAreaElement => {
    const input = opt.multiline
      ? h("textarea", { attrs: { rows: 2, placeholder: opt.placeholder ?? false } })
      : h("input", {
          class: opt.numeric ? "inline-editor-number" : undefined,
          attrs: { type: "text", placeholder: opt.placeholder ?? false },
        });
    input.value = value ?? "";
    return input;
  };
  for (const field of opts.fields) {
    const input = mkInput(field.value, {
      numeric: field.numeric,
      multiline: field.multiline,
      placeholder: field.placeholder,
    });
    inputs.set(field.key, input);
    const checks = field.validate ? [{ input, validate: field.validate }] : [];
    // "Track [3] of [12]": a second input for the total, sharing the row and the
    // label. Registered like any other field, so submit collects it by its key.
    let totalInput: HTMLInputElement | HTMLTextAreaElement | null = null;
    if (field.total) {
      totalInput = mkInput(field.total.value, { numeric: true });
      inputs.set(field.total.key, totalInput);
      if (field.total.validate) {
        checks.push({ input: totalInput, validate: field.total.validate });
      }
    }
    const row = h(
      "label",
      { class: "inline-editor-field" },
      h("span", { class: "inline-editor-label", text: field.label }),
      input,
      totalInput && h("span", { class: "inline-editor-of", text: "of" }),
      totalInput,
      field.browse &&
        h("button", {
          class: "inline-editor-browse",
          attrs: { type: "button" },
          text: "Choose...",
        }),
    );
    // A row that can be wrong carries its own line to say so, directly beneath
    // it and indented to the input — the message belongs to the field that
    // produced it, not to the form. Rows that can't be wrong stay bare.
    if (checks.length > 0) {
      const error = h("div", { class: "inline-editor-field-error hidden" });
      rows.push({ error, checks });
      form.appendChild(h("div", { class: "inline-editor-row" }, row, error));
    } else {
      form.appendChild(row);
    }
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

  // The note below the buttons, saying why Save didn't take. It sits under Save
  // so it reads as the answer to "why didn't that work?", and carries two kinds
  // of message: the standing reason Save is disabled (`blockedNote`, e.g. "Can't
  // save while this track is playing"), marked with a padlock because it is an
  // expected constraint, and the reason a submit that did run came back refused,
  // which wears no lock and takes the danger colour. Present in the DOM from the
  // start so toggling it doesn't reflow the actions row.
  const noteIcon = h("span", { class: "inline-editor-note-icon" });
  const noteText = h("span");
  const noteEl = h("div", { class: "inline-editor-note hidden" }, noteIcon, noteText);
  form.appendChild(noteEl);
  // Set by a submit that came back with a reason; cleared when the next one starts.
  let refusal: string | null = null;

  const required = opts.fields.filter((f) => f.required).map((f) => f.key);
  // Show each row its own first failure, and report whether any row has one.
  const syncFieldErrors = (): boolean => {
    let anyInvalid = false;
    for (const { error, checks } of rows) {
      let message: string | null = null;
      for (const { input, validate } of checks) {
        message = validate(input.value.trim());
        if (message) break;
      }
      error.textContent = message ?? "";
      error.classList.toggle("hidden", message == null);
      anyInvalid ||= message != null;
    }
    return anyInvalid;
  };
  const syncEnabled = (): void => {
    const blocked = opts.blocked?.() ?? false;
    const invalid = syncFieldErrors();
    submitBtn.disabled =
      blocked || invalid || required.some((key) => !inputs.get(key)!.value.trim());
    // What's left for the note under the buttons is the two reasons no single
    // field can explain: the standing block (nothing you type changes it, so it
    // keeps the padlock) and the refusal the last submit came back with. A bad
    // value is not among them — that message lives under its own row.
    let note: string | null = null;
    let blockedNote = false;
    if (blocked && opts.blockedNote) {
      note = opts.blockedNote;
      blockedNote = true;
    } else if (refusal) {
      note = refusal;
    }
    noteEl.classList.toggle("hidden", note == null);
    noteEl.classList.toggle("is-refusal", note != null && !blockedNote);
    noteIcon.hidden = !blockedNote;
    noteText.textContent = note ?? "";
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
    // This attempt gets a clean slate; whatever it comes back with is the note.
    refusal = null;
    syncEnabled();
    void (async () => {
      const message = await opts.onSubmit(values, artwork?.state() ?? { kind: "keep" });
      if (typeof message === "string" && message) {
        refusal = message;
        syncEnabled();
      }
    })();
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

// Pick an image for the artwork well. The backend validates the file the same way
// the save will (lofty sniffs the format from the bytes) and hands back a data URL
// to preview, so a file that previews here is a file that will embed — and its
// refusal is already a sentence, shown as-is under the well.
async function chooseArtwork(): Promise<ArtworkPick | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    // The formats a tag can carry. Nothing else, because the picker offering a
    // .webp only to have the well reject it would be the dialog's fault, not the
    // user's.
    filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif"] }],
  });
  if (typeof selected !== "string") return null;
  try {
    const dataUrl = await invoke<string>("read_artwork_file", { path: selected });
    return { ok: true, path: selected, dataUrl };
  } catch (e) {
    console.error("read_artwork_file failed", selected, e);
    return { ok: false, message: typeof e === "string" ? e : "Couldn't read that image." };
  }
}

// Open the metadata editor for `path`, prefilled from `seed` (its current tags,
// read fresh from disk — see editMetadataItem). Building the form here means one
// editor surface no matter which menu opened it. Save writes the tags, refreshes
// every surface that shows the track (applyTagUpdate), and closes; Cancel closes.
function openMetadataEditor(path: string, seed: EditorTags): void {
  // Empty or non-positive parses to null (clears the tag); disc/track are 1-based.
  const parsePositive = (s: string): number | null => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const num = (v: number | null): string => (v != null && v > 0 ? String(v) : "");
  // A number field holds digits and nothing else. Without this, parseInt quietly
  // reads "12abc" as 12 and "abc" as null — which is the instruction to *clear*
  // the tag, so a typo would delete a track number rather than be rejected.
  const digitsOnly = (label: string): FieldValidator => (v) =>
    v === "" || /^\d+$/.test(v) ? null : `${label} must be a number`;
  // Four digits is the format's rule, not Pudding's: ID3v2.4 keeps the year in
  // TDRC and MP4 in ©day, both ISO-8601 dates, and lofty reads a year back out of
  // neither unless it has four digits. A "123" would be written to the file and
  // then be invisible — to this editor, to the Year column, and to every other
  // player. Refusing it up front is the only way the field can tell the truth.
  const fourDigitYear: FieldValidator = (v) =>
    v === "" || /^\d{4}$/.test(v) ? null : "Year must be four digits";
  const editor = buildInlineEditor({
    artwork: {
      label: "Artwork",
      current: seed.artwork,
      choose: chooseArtwork,
    },
    fields: [
      { key: "title", label: "Title", value: seed.title ?? "", placeholder: seed.name },
      { key: "artist", label: "Artist", value: seed.artist ?? "" },
      { key: "album", label: "Album", value: seed.album ?? "" },
      { key: "albumArtist", label: "Album Artist", value: seed.albumArtist ?? "" },
      { key: "genre", label: "Genre", value: seed.genre ?? "" },
      {
        key: "year",
        label: "Year",
        value: num(seed.year),
        numeric: true,
        validate: fourDigitYear,
      },
      {
        key: "disc",
        label: "Disc",
        value: num(seed.disc),
        numeric: true,
        validate: digitsOnly("Disc"),
        total: {
          key: "discTotal",
          value: num(seed.discTotal),
          validate: digitsOnly("Disc total"),
        },
      },
      {
        key: "track",
        label: "Track",
        value: num(seed.track),
        numeric: true,
        validate: digitsOnly("Track"),
        total: {
          key: "trackTotal",
          value: num(seed.trackTotal),
          validate: digitsOnly("Track total"),
        },
      },
      // Last because it is the one free-text field with no fixed shape — and the
      // one most often being cleared rather than written.
      { key: "comment", label: "Comment", value: seed.comment ?? "", multiline: true },
    ],
    submitLabel: "Save",
    heading: `Editing ${seed.name}`,
    // Saving rewrites the file in place — unsafe while the engine holds it open
    // (you can open this for the playing track, or playback may advance into it
    // while the editor is up). Gate Save on that, live.
    blocked: () => currentNodePath.value === path,
    blockedNote: "Can't save while this track is playing",
    onCancel: closePaneEditor,
    onSubmit: async (values, artwork) => {
      // Defensive re-check: the reactive gate keeps Save disabled while playing,
      // so this only trips on a same-tick race. Leave the form up rather than
      // rewriting the file under the decoder — and say why, since from the
      // outside a Save that quietly does nothing is indistinguishable from a
      // Save that is broken.
      if (currentNodePath.value === path) return "Can't save while this track is playing";
      let res: FileEntry;
      try {
        res = await invoke<FileEntry>("write_tags", {
          path,
          tags: {
            title: values.title || null,
            artist: values.artist || null,
            albumArtist: values.albumArtist || null,
            album: values.album || null,
            genre: values.genre || null,
            comment: values.comment || null,
            disc: parsePositive(values.disc),
            discTotal: parsePositive(values.discTotal),
            track: parsePositive(values.track),
            trackTotal: parsePositive(values.trackTotal),
            year: parsePositive(values.year),
            artwork,
          },
        });
      } catch (e) {
        // The backend's failures are written as sentences (see write_tags), so
        // the one it gives is the one to show. The form stays up with the user's
        // typing in it — a lost form full of retyped tags is its own bug.
        console.error("write_tags failed", e);
        return typeof e === "string" ? e : "Couldn't save the tags.";
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
  let seed: EditorTags;
  try {
    seed = await invoke<EditorTags>("read_file_tags", { path });
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
