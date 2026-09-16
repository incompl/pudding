// Editor surfaces: the generic inline-editor form builder, the right-pane editor
// face (track metadata + stream add/edit mount here), and the in-place inline
// rename (label → text input). The station-specific editors live in
// streams-view.ts; this module owns the shared machinery they build on.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { effect } from "@preact/signals-core";
import { h } from "./dom";
import type {
  InlineEditorOptions,
  InlineEditorArtwork,
  ArtworkEdit,
  ArtworkPick,
  CommonTags,
  EditorTags,
  FieldValidator,
  ContextMenuItem,
  InlineEditorBusy,
  InlineEditorControls,
  TagProgress,
  TagWriteReport,
  TrackProvider,
} from "./types";
import {
  app,
  paneEditor,
  currentNodePath,
  enginePoolLive,
  dismissRightPanel,
  isNotDownloaded,
} from "./state";
import { paneEditorView, queueTitleEl } from "./dom-refs";
import { refreshLibrary } from "./library";
import { renameOpenPlaylist } from "./playlists";
import { curatedList } from "./queue";
import { toast } from "./main";
import { applyTagUpdates } from "./track-facts";

// Batch id for a run of tag work — a write, or the seed read that fills the form
// in — minted here and sent with the call. It rides on every progress event and
// on the cancel, so a progress label can ignore a batch that isn't its own and a
// late Stop can't kill the batch after the one it was aimed at. Minted by the
// caller because the backend's own number would not exist until the command
// returned — precisely too late to cancel it. One counter for both kinds: they
// are told apart by the event they arrive on, and two counters could hand a read
// and a write the same number. Monotonic within a session; it never needs to
// survive a restart.
let tagGeneration = 0;
function nextTagGeneration(): number {
  return ++tagGeneration;
}

// Run one batch of file work with the form counting it out. Both long tag
// operations report the same three numbers on their own event — the write per file
// rewritten, the seed read per file parsed — so the subscribe/filter/label/clean-up
// is written once here and the caller supplies only what differs: which event, how
// the count reads, and whether there is anything to stop.
//
// The batch id is the whole of the filtering. Events are app-wide, and a form that
// took every one of them would count a batch the user walked away from: start on
// 300 files, escape, open on 3, and the new form counts to 300.
async function withTagProgress<T>(
  opts: {
    event: "tag-write-progress" | "tag-read-progress";
    generation: number;
    controls: InlineEditorControls | null;
    total: number;
    label: (done: number, total: number) => string;
    stop?: InlineEditorBusy["stop"];
  },
  work: () => Promise<T>,
): Promise<T> {
  const { controls, label, stop } = opts;
  const busy = (done: number, total: number): void =>
    controls?.setBusy({ label: label(done, total), stop });
  busy(0, opts.total);
  // Inside the try from here on, because the busy state is already on: a listen()
  // that rejects would otherwise strand the form inert behind a Stop button for a
  // batch that never started — and with Escape bound to that Stop, undismissable.
  let unlisten: UnlistenFn | null = null;
  try {
    // Subscribed before the work starts, because the first files are done before
    // its promise has done anything at all.
    unlisten = await listen<TagProgress>(opts.event, (e) => {
      if (e.payload.generation !== opts.generation) return;
      busy(e.payload.done, e.payload.total);
    });
    return await work();
  } finally {
    unlisten?.();
    controls?.setBusy(null);
  }
}

// Write `tags` (a patch: a key it doesn't carry is a tag the files keep) across
// `paths`, with the form showing what is happening to it. One call for a
// selection of any size — the loop, the per-file progress and the refusals are
// all the backend's, and this is the half that puts a number on them.
//
// Stop is offered only past one file. Cancellation happens between files and
// never inside one (lofty rewrites a file in place), so on a single file there is
// nothing left for it to spare and the button would be a promise the batch can't
// keep.
async function runTagWrite(
  paths: string[],
  tags: Record<string, unknown>,
  controls: InlineEditorControls | null,
): Promise<TagWriteReport> {
  const generation = nextTagGeneration();
  return withTagProgress(
    {
      event: "tag-write-progress",
      generation,
      controls,
      total: paths.length,
      // "Saving..." at one file, a count past it: "37 of 1" is noise, and at
      // three hundred the count is the whole point of the line.
      label: (done, total) =>
        total > 1 ? `Saving... ${done} of ${total}` : "Saving...",
      stop:
        paths.length > 1
          ? {
              label: "Stop",
              onStop: () => void invoke("cancel_tag_write", { generation }),
            }
          : undefined,
    },
    () => invoke<TagWriteReport>("write_tags", { paths, generation, tags }),
  );
}

// Fold `paths` down to the tags they share, with the form counting the files off
// as they are parsed. The other long tag operation, and the reason the editor can
// open before it has anything to show: at a few hundred files this is seconds of
// disk, and it happens behind a form that is already on screen saying so.
//
// No Stop to go with the count. Cancelling a read would spare nothing the user
// can see — escaping the form leaves the fold running to the end of its list,
// which is bounded, touches nothing, and is then never heard from again.
async function runTagRead(
  paths: string[],
  controls: InlineEditorControls | null,
): Promise<CommonTags> {
  const generation = nextTagGeneration();
  return withTagProgress(
    {
      event: "tag-read-progress",
      generation,
      controls,
      total: paths.length,
      label: (done, total) =>
        total > 1 ? `Reading... ${done} of ${total}` : "Reading...",
    },
    () => invoke<CommonTags>("read_common_tags", { paths, generation }),
  );
}

// The artwork well: a preview of the file's picture, a Choose... that swaps in a
// picked image, and a Remove that takes it out. Three states and no more (see
// ArtworkEdit) — a save that didn't touch the well leaves the file's picture
// untouched, which is what keeps tag edits from re-writing every cover in a
// library. Undo is Cancel: Remove always means remove, even after a Choose, so
// the two buttons never change meaning under the pointer.
function buildArtworkField(
  opts: InlineEditorArtwork,
  // The well is a field like any other as far as Save is concerned, and the only
  // one whose edits arrive by button rather than by keystroke — so it has to say
  // when it has changed, or a picked cover would sit in a form whose Save is still
  // greyed out for want of a typed character.
  onChange: () => void,
): {
  row: HTMLElement;
  state: () => ArtworkEdit;
} {
  let edit: ArtworkEdit = { kind: "keep" };
  const img = h("img", { class: "artwork-well-image", attrs: { alt: "" } });
  // Text set in render(): an empty well means "this file carries no picture" on
  // one file and "these files carry different ones" on a mixed selection.
  const placeholder = h("span", { class: "artwork-well-empty" });
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
    // The mixed state is only the *untouched* one: once a picture is chosen or
    // removed, every selected file is getting that same answer and the well shows
    // it, exactly as it would for one file.
    const multiple = opts.mixed === true && edit.kind === "keep";
    // The same mark the touched fields wear, for the same reason: a well emptied by
    // Remove looks exactly like a well that was empty to begin with, and only one of
    // those is about to strip a picture off every selected file. The words below it
    // need no equivalent swap — "No artwork" is already true of what the save
    // leaves behind, where "Multiple values" on an armed field is not.
    well.classList.toggle("is-dirty", edit.kind !== "keep");
    img.hidden = src == null;
    placeholder.hidden = src != null;
    placeholder.textContent = multiple ? "Multiple" : "No artwork";
    if (src) img.src = src;
    // Nothing to remove when the well is already empty; the button would be a
    // no-op dressed as an action. A mixed well is the exception: it looks empty
    // while hiding N pictures, and Remove is the only way to strip them.
    removeBtn.hidden = src == null && !multiple;
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
        onChange();
      },
    },
  });
  removeBtn.addEventListener("click", () => {
    errorEl.classList.add("hidden");
    edit = { kind: "remove" };
    render();
    onChange();
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
    key: string;
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
  const artwork = opts.artwork
    ? buildArtworkField(opts.artwork, () => syncEnabled())
    : null;
  if (artwork) form.appendChild(artwork.row);
  // The boxes that came up empty because the selection disagreed. Remembered
  // because their placeholder stops being true the moment they are touched: an
  // armed empty box writes emptiness, so "Multiple values" would be describing the
  // files as they were rather than as the save will leave them.
  const seededMixed = new Set<HTMLElement>();
  const mkInput = (
    value: string | undefined,
    opt: {
      numeric?: boolean;
      multiline?: boolean;
      placeholder?: string;
      mixed?: boolean;
    } = {},
  ): HTMLInputElement | HTMLTextAreaElement => {
    // A mixed box starts empty and says why in the one place an empty box has
    // left to say anything. "Multiple values" is far wider than the few digits a
    // numeric box is sized for, so that one gets a dash instead — a field with a
    // better word for itself passes its own `placeholder`, which wins outright
    // (Title's is the file name, and a caller with no single file name to show
    // simply doesn't pass one).
    const placeholder =
      opt.placeholder ??
      (opt.mixed ? (opt.numeric ? "—" : "Multiple values") : undefined);
    const input = opt.multiline
      ? h("textarea", { attrs: { rows: 2, placeholder: placeholder ?? false } })
      : h("input", {
          class: opt.numeric ? "inline-editor-number" : undefined,
          attrs: { type: "text", placeholder: placeholder ?? false },
        });
    input.value = value ?? "";
    if (opt.mixed) seededMixed.add(input);
    return input;
  };
  for (const field of opts.fields) {
    const input = mkInput(field.value, {
      numeric: field.numeric,
      multiline: field.multiline,
      placeholder: field.placeholder,
      mixed: field.mixed,
    });
    inputs.set(field.key, input);
    const checks = field.validate ? [{ input, validate: field.validate }] : [];
    // "Track [3] of [12]": a second input for the total, sharing the row and the
    // label. Registered like any other field, so submit collects it by its key.
    let totalInput: HTMLInputElement | HTMLTextAreaElement | null = null;
    if (field.total) {
      totalInput = mkInput(field.total.value, {
        numeric: true,
        placeholder: field.total.placeholder,
        mixed: field.total.mixed,
      });
      inputs.set(field.total.key, totalInput);
      if (field.total.validate) {
        checks.push({ input: totalInput, validate: field.total.validate });
      }
    }
    // Either half being mixed dims the row: the class only reaches placeholders,
    // and the half that agrees is showing a value rather than one of those.
    const mixed = field.mixed === true || field.total?.mixed === true;
    const row = h(
      "label",
      { class: mixed ? "inline-editor-field is-mixed" : "inline-editor-field" },
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
    if (field.browse) browsers.push({ key: field.key, input, browse: field.browse });
  }

  // The fields the user has actually edited — the whole of what a save sends (see
  // the patch in openMetadataEditor's onSubmit). Declared up here because Save's
  // enabled state is now read from it as well.
  const touched = new Set<string>();

  // The form's working state, set by the caller through `controls` while a save
  // or a seed read is running (see InlineEditorBusy). Null the rest of the time.
  let busy: InlineEditorBusy | null = null;
  // Cancel and Stop are one button because they are one gesture in one place —
  // "not the rest of this". The word changes with what is running; that Stop
  // leaves the already-written files written is the note's to say, not the
  // button's.
  const cancelBtn = h("button", {
    class: "inline-editor-cancel",
    attrs: { type: "button" },
    text: "Cancel",
    on: { click: () => (busy?.stop ? busy.stop.onStop() : opts.onCancel()) },
  });
  const submitBtn = h("button", {
    class: "inline-editor-submit",
    attrs: { type: "submit" },
    text: opts.submitLabel,
  });
  // The note saying why Save didn't take, carrying two kinds of message: the
  // standing reason Save is disabled (`blockedNote`, e.g. "Can't save while this
  // track is playing"), marked with a padlock because it is an expected
  // constraint, and the reason a submit that did run came back refused, which
  // wears no lock and takes the danger colour. A third, the form's standing
  // `note`, wears neither and holds the line when the other two have nothing to
  // say. Present in the DOM from the start so toggling it doesn't reflow the row.
  //
  // It rides *in* the actions row, to the left of the buttons, rather than on a
  // line below them: the pane scrolls, and a reason on its own line under Save
  // could sit past the fold in a short window — a disabled button explaining
  // itself somewhere the user can't see. In the row it is as visible as Save
  // itself, which the pane keeps in view (see the sticky rule in styles.css).
  const noteIcon = h("span", { class: "inline-editor-note-icon" });
  const noteText = h("span");
  const noteEl = h("div", { class: "inline-editor-note hidden" }, noteIcon, noteText);
  form.appendChild(
    h("div", { class: "inline-editor-actions" }, noteEl, cancelBtn, submitBtn),
  );
  // Set by a submit that came back with a reason; cleared when the next one starts.
  let refusal: string | null = null;
  // A submit that is still running. Save's disabled state is computed from the
  // form's values, and none of them change while the await is out — so without
  // this, a second Enter starts a second write over the same files while the
  // first is still rewriting them. Looking un-frozen is the lesser half of it.
  let inFlight = false;

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
  // Has anything been said yet? A form nobody has touched carries an empty patch,
  // and sending one is not a harmless no-op: every selected file is still opened,
  // rewritten byte for byte and re-stated, so a Save nobody meant bumps Date
  // Modified on all of them and, at a few hundred files, spends seconds doing it.
  // The button being dead until there is something to write is also the only "how
  // many fields will this save" the form needs — the dirty borders say which.
  const armed = (): boolean =>
    touched.size > 0 || (artwork?.state().kind ?? "keep") !== "keep";
  const syncEnabled = (): void => {
    const blocked = opts.blocked?.() ?? false;
    const invalid = syncFieldErrors();
    submitBtn.disabled =
      inFlight ||
      busy != null ||
      blocked ||
      invalid ||
      !armed() ||
      required.some((key) => !inputs.get(key)!.value.trim());
    // What's left for the note under the buttons is the three things no single
    // field can explain: what is running right now, the standing block (nothing
    // you type changes it, so it keeps the padlock) and the refusal the last
    // submit came back with. A bad value is not among them — that message lives
    // under its own row. Running wins over the other two: while a save is out,
    // what it is doing is the only thing worth the line.
    let note: string | null = null;
    let tone: "busy" | "blocked" | "refusal" | "standing" | null = null;
    if (busy) {
      note = busy.label;
      tone = "busy";
    } else if (blocked && opts.blockedNote) {
      note = opts.blockedNote;
      tone = "blocked";
    } else if (refusal) {
      note = refusal;
      tone = "refusal";
    } else if (opts.note) {
      // Last, because it is the only one of the four that is still true after
      // the user has read it once: a standing fact about the form gives way to
      // anything with news.
      note = opts.note;
      tone = "standing";
    }
    noteEl.classList.toggle("hidden", note == null);
    noteEl.classList.toggle("is-refusal", tone === "refusal");
    noteIcon.hidden = tone !== "blocked";
    noteText.textContent = note ?? "";
  };
  const setBusy = (next: InlineEditorBusy | null): void => {
    busy = next;
    // Inert, not hidden: the typing stays on screen (it is what is being written)
    // but a save already carries the values it was given, so a field changed
    // under it would be a lie about what landed on disk.
    for (const input of inputs.values()) input.disabled = next != null;
    cancelBtn.textContent = next?.stop ? next.stop.label : "Cancel";
    syncEnabled();
  };
  // A field is touched the moment it fires `input`, not when its value ends up
  // different from the seed: someone who types and puts it back has still said
  // something about that tag, and a save carries it. Every box lives in `inputs`
  // under its own key, totals included, so this one listener covers them all.
  //
  // Every way a field can be edited goes through here, because "edited" is what
  // Save is gated on and what the patch is built from — two routes that drifted
  // apart would be a field that looks armed and is never sent, or the reverse.
  const markTouched = (
    key: string,
    input: HTMLInputElement | HTMLTextAreaElement,
  ): void => {
    touched.add(key);
    // Say so on the box itself. The patch model is otherwise invisible: a save
    // writes the fields that were edited and leaves every other tag alone, and
    // nothing on screen distinguishes the two until the border does. It marks
    // *touched*, not changed-from-seed, because that is what the save acts on —
    // typing a character and taking it back still rewrites that tag, which for a
    // Year seeded from an ID3 full date costs the month and the day.
    input.classList.add("is-dirty");
    // A mixed box that has been touched and emptied is the one way to strip a tag
    // from a whole selection, and the placeholder is the only thing that can say
    // so — the box is empty either way, and "Multiple values" now describes what
    // the save is about to remove. Swapped once and not swapped back: a field
    // cannot become untouched, so from here an empty box always means clear.
    if (seededMixed.has(input)) input.placeholder = "Clear";
  };
  for (const [key, input] of inputs) {
    input.addEventListener("input", () => {
      markTouched(key, input);
      syncEnabled();
    });
  }
  for (const { key, input, browse } of browsers) {
    const buttonRow = input.parentElement!.querySelector(".inline-editor-browse")!;
    buttonRow.addEventListener("click", async () => {
      const picked = await browse();
      if (picked != null) {
        input.value = picked;
        // Through the same door typing goes through. Assigning `value` in script
        // fires no `input` event, so without this a browsed field would never be
        // marked touched — which used to mean "quietly not sent" and now also means
        // a Save that stays greyed out under a file the user just picked.
        markTouched(key, input);
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
    inFlight = true;
    syncEnabled();
    void (async () => {
      // Whatever happens, the form comes back: an onSubmit that threw would
      // otherwise leave Save disabled for good, with no way back but Cancel. The
      // repaint is half of that promise — clearing the flag without re-running
      // the gate leaves the button greyed out with nothing left to re-run it — so
      // both live in the finally, and a throw is caught rather than escaping as
      // an unhandled rejection.
      try {
        const message = await opts.onSubmit(
          values,
          artwork?.state() ?? { kind: "keep" },
          touched,
        );
        if (typeof message === "string" && message) refusal = message;
      } catch (e) {
        // Every caller turns its own failures into a returned sentence, so a
        // throw is a bug rather than a refusal. Still say something: a Save that
        // quietly comes back unchanged is indistinguishable from one that worked.
        console.error("inline editor submit failed", e);
        refusal = "Something went wrong.";
      } finally {
        inFlight = false;
        syncEnabled();
      }
    })();
  });
  // Esc cancels from anywhere in the form (matching the rename affordance), and
  // means whatever the button beside it means: Stop while a stoppable batch is
  // running, Cancel otherwise. A save the user can only stop with the mouse is a
  // save they will close the form on instead.
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (busy?.stop) busy.stop.onStop();
      else opts.onCancel();
    }
  });
  opts.controls?.({ setBusy });
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
// is decoupled from any row and applyTagUpdates refreshes each surface after the
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

// Open the metadata editor over `paths` — one file or several hundred, through
// the same form and the same code path. The tags are read here rather than by the
// caller, because the form goes up *first* and fills in second: at a large
// selection the fold is a multi-second read, and awaiting it before opening would
// leave the window showing nothing at all between the click and the form — worse
// than a visible wait, because there is no surface yet to put the count on.
//
// So the form is mounted inert with a `Reading... 37 of 300` note and then rebuilt
// on what the fold came back with. Rebuilding rather than filling the boxes in
// place is what "seed the form" means here: every field's value, its mixed
// placeholder, and the artwork well's state are built from the seed, and the first
// form holds nothing worth preserving — its inputs were disabled for its whole
// life.
//
// Save writes the patch across every path, refreshes every surface that shows any
// of them (applyTagUpdates), and closes; Cancel closes. Resolves once the form is
// seeded, or the read failed and closed it — which is what the e2e bridge waits on
// before it reads the fields.
//
// `note` is a standing line the caller wants under the buttons for this edit's
// whole life — an aggregate menu saying which of its tracks it had to leave out.
function openMetadataEditor(paths: string[], note?: string): Promise<void> {
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

  // The count is the whole of the confirmation: it is the one place the user sees
  // what they are about to do and to how many files, and it is on screen from the
  // first frame because the tags it would otherwise wait for say nothing about
  // that. The file name comes off the path rather than out of the seed for the
  // same reason — this has to read right before the read returns.
  const heading =
    paths.length === 1
      ? `Editing ${paths[0].split("/").pop() ?? paths[0]}`
      : `Editing ${paths.length} tracks`;

  // Saving rewrites each file in place — unsafe while the engine holds one open.
  // At one file that is the track being edited; across a selection it is any
  // member of it, including one that playback advances into while the form is up.
  // Blocking the whole save rather than quietly skipping the held file: a partial
  // save nobody asked for is worse than a disabled button that says why.
  //
  // This is the polite half, not the load-bearing one. It sees only the audible
  // track, while the decode frontier runs ahead of it; the backend refuses the
  // file the engine actually holds, per file, at the moment it opens each one.
  //
  // A standing playhead is not the same as a held file, which is why this asks
  // enginePoolLive first: an album played to its end keeps currentNodePath so play
  // resumes the finished track, and a restored session has one before it has ever
  // played. Both leave the engine holding nothing — the backend's own gate opens
  // for exactly those cases (queue_exhausted empties held_paths_of) — and without
  // this the last track of every album would be uneditable until something else
  // played, with a note saying it was playing when it wasn't.
  const selected = new Set(paths);
  const playingHere = (): boolean => {
    if (!enginePoolLive.value) return false;
    const path = currentNodePath.value;
    return path != null && selected.has(path);
  };
  const blockedNote =
    paths.length > 1
      ? "Can't save while one of these tracks is playing"
      : "Can't save while this track is playing";

  // The form's own handle, for the working state a read or a save puts it in.
  // Repointed at each build, so it always names the form that is mounted.
  let controls: InlineEditorControls | null = null;

  // What the form says when a batch comes back. Four outcomes, and the batch that
  // fully succeeded is the only one that closes it — every other one has something
  // to tell the user, and the note under the buttons is where it gets told.
  const outcome = (report: TagWriteReport): string | void => {
    // A file whose library row couldn't be updated was still written correctly, so
    // it counts with the saved: telling someone a save failed when it didn't is
    // the one report worse than no report at all.
    const stale = report.failed.filter((f) => f.stale);
    const failed = report.failed.filter((f) => !f.stale);
    const saved = report.ok.length + stale.length;
    // One rebuild of each surface for the whole batch, not one per track.
    applyTagUpdates(report.ok);
    // The note has room for a count and not for forty paths; the log takes the
    // paths, which is what anyone diagnosing this actually needs.
    for (const f of failed) console.error("write_tags failed", f.path, f.message);
    if (report.stopped) {
      // Stop is not Undo, and the wording carries that: the files already written
      // stay written, and the ones the loop never reached are untouched rather
      // than failed.
      const rest = failed.length > 0 ? ` ${failed.length} couldn't be written.` : "";
      return `Stopped. ${saved} of ${paths.length} saved.${rest}`;
    }
    if (report.aborted) {
      // The storage gave out — a full disk, a drive pulled out — and the batch
      // stopped rather than attempting the hundreds behind it. Saying the rest are
      // unchanged is the whole point of the sentence: every write is staged on a
      // copy and renamed into place, so a save that fails leaves the track exactly
      // as it was, and a half-finished bulk edit costs nothing but the redo.
      return saved === 0
        ? `${report.aborted}. Nothing was changed.`
        : `Saved ${saved} of ${paths.length}. ${report.aborted}. The rest are unchanged.`;
    }
    if (saved === 0) return failed[0]?.message ?? "Couldn't save the tags.";
    if (failed.length > 0) {
      return `Saved ${saved} of ${paths.length}. ${failed.length} couldn't be written.`;
    }
    if (stale.length > 0) {
      // Every file is correct on disk; what is behind is the library's own copy of
      // them. The whole-batch case is the common one rather than the rare one — a
      // save that overlaps a scan trips the write lock on its first file and every
      // file after it — so it gets the sentence that doesn't count anything.
      return stale.length === saved
        ? `Saved ${saved === 1 ? "the track" : saved}. The library list will catch up on the next scan.`
        : `Saved ${saved}. ${stale.length} library ${stale.length === 1 ? "row" : "rows"} will refresh on the next scan.`;
    }
    closePaneEditor();
  };

  // Build the form on `seed`, or on nothing while the fold is still running.
  const build = (seed: CommonTags | null): HTMLFormElement => {
    const tags: EditorTags | null = seed?.common ?? null;
    // Which fields the selection disagrees about. Empty before the seed lands and
    // for any single file, where there is nothing to disagree with.
    const mixed = new Set(seed?.mixed ?? []);
    const differs = (key: string): boolean => mixed.has(key);
    return buildInlineEditor({
      note,
      controls: (c) => {
        controls = c;
      },
      artwork: {
        label: "Artwork",
        current: tags?.artwork ?? null,
        mixed: differs("artwork"),
        choose: chooseArtwork,
      },
      fields: [
        {
          key: "title",
          label: "Title",
          value: tags?.title ?? "",
          // The file name, which is what an empty Title box is standing in for —
          // but only while there is one file name to show AND one title it could
          // be standing in for. A selection whose titles disagree needs the mixed
          // placeholder instead: an explicit one wins outright, so a shared file
          // name (two "01 Intro.mp3" in different albums) would otherwise show as
          // if it were the stand-in for a single empty title, with nothing saying
          // the box came up empty because the files disagree.
          placeholder: differs("name") || differs("title") ? undefined : tags?.name,
          mixed: differs("title"),
        },
        { key: "artist", label: "Artist", value: tags?.artist ?? "", mixed: differs("artist") },
        { key: "album", label: "Album", value: tags?.album ?? "", mixed: differs("album") },
        {
          key: "albumArtist",
          label: "Album Artist",
          value: tags?.albumArtist ?? "",
          mixed: differs("albumArtist"),
        },
        { key: "genre", label: "Genre", value: tags?.genre ?? "", mixed: differs("genre") },
        {
          key: "year",
          label: "Year",
          value: num(tags?.year ?? null),
          numeric: true,
          mixed: differs("year"),
          validate: fourDigitYear,
        },
        {
          key: "disc",
          label: "Disc",
          value: num(tags?.disc ?? null),
          numeric: true,
          mixed: differs("disc"),
          validate: digitsOnly("Disc"),
          total: {
            key: "discTotal",
            value: num(tags?.discTotal ?? null),
            mixed: differs("discTotal"),
            validate: digitsOnly("Disc total"),
          },
        },
        {
          key: "track",
          label: "Track",
          value: num(tags?.track ?? null),
          numeric: true,
          mixed: differs("track"),
          validate: digitsOnly("Track"),
          total: {
            key: "trackTotal",
            value: num(tags?.trackTotal ?? null),
            mixed: differs("trackTotal"),
            validate: digitsOnly("Track total"),
          },
        },
        // Last because it is the one free-text field with no fixed shape — and the
        // one most often being cleared rather than written.
        {
          key: "comment",
          label: "Comment",
          value: tags?.comment ?? "",
          multiline: true,
          mixed: differs("comment"),
        },
      ],
      submitLabel: "Save",
      heading,
      blocked: playingHere,
      blockedNote,
      onCancel: closePaneEditor,
      onSubmit: async (values, artwork, touched) => {
        // Defensive re-check: the reactive gate keeps Save disabled while a
        // selected track is playing, so this only trips on a same-tick race. Leave
        // the form up rather than rewriting a file under the decoder — and say
        // why, since from the outside a Save that quietly does nothing is
        // indistinguishable from a Save that is broken.
        if (playingHere()) return blockedNote;
        // The patch is exactly what the user typed in and nothing else: a key the
        // form doesn't send is a tag every selected file keeps, untouched (see the
        // Rust TagEdits). That is the whole of the difference between editing one
        // file and editing three hundred — there is no second call shape for the
        // single-file case, and so no pair of them to drift apart.
        const patch: Record<string, unknown> = { artwork };
        for (const key of ["title", "artist", "album", "albumArtist", "genre", "comment"]) {
          // A box typed into and then emptied sends null, which *strips* that tag
          // from every selected file. That is a real verb — the only way to clear
          // a tag across a selection — reached by backspacing rather than by
          // accident of the wire format.
          if (touched.has(key)) patch[key] = values[key] || null;
        }
        for (const key of ["year", "disc", "discTotal", "track", "trackTotal"]) {
          if (touched.has(key)) patch[key] = parsePositive(values[key]);
        }
        let report: TagWriteReport;
        try {
          report = await runTagWrite(paths, patch, controls);
        } catch (e) {
          // A throw is the batch-level failure (an unreadable artwork pick); a
          // file that couldn't be written comes back in `failed`. Both are written
          // as sentences, so the one the backend gives is the one to show. The
          // form stays up with the user's typing in it — a lost form full of
          // retyped tags is its own bug.
          console.error("write_tags failed", e);
          return typeof e === "string" ? e : "Couldn't save the tags.";
        }
        return outcome(report);
      },
    });
  };

  const reading = build(null);
  openPaneEditor("metadata", reading);
  return (async () => {
    let seed: CommonTags;
    try {
      seed = await runTagRead(paths, controls);
    } catch (e) {
      console.error("read_common_tags failed", e);
      // Close rather than leave an empty form up: an unseeded form is
      // indistinguishable from files that carry no tags at all, and saving from it
      // would be the user writing that emptiness over every one of them.
      if (reading.isConnected) closePaneEditor();
      toast(typeof e === "string" ? e : "Couldn't read those tags.");
      return;
    }
    // The form the user walked away from is not the form to fill in. Cancel, Esc
    // and any other editor opening over this one all leave it detached, and the
    // seed belongs to none of them.
    if (!reading.isConnected) return;
    openPaneEditor("metadata", build(seed));
  })();
}

// The "Edit metadata..." context-menu verb, shared by every track surface and by
// selections of any size. Reads the files' tags fresh from disk rather than from
// the rows: a view carries only a partial row (a SearchTrack from Songs/album/
// artist lists has no album-artist or disc), and seeding the form from one would
// let a save write those fields back empty.
//
// A cloud-only file is kept out of it either way. Reading a dataless file
// materializes it — a download the user didn't ask for, per file. Playing such a
// track is the one action that downloads it (audio.rs parks a worker thread on the
// fetch); once it lands, the row's "(Not downloaded)" clears and the verb comes
// back with it. The two menu items below differ only in *when* they can know:
// see editMetadataItem and editMetadataProviderItem.
//
// The verb's actual work, callable on its own: open the editor on `paths` and seed
// it. Separate from the menu item so the e2e/screenshot bridge can reach the
// editor face, which no native context menu can open for it.
export function editTags(paths: string[], note?: string): Promise<void> {
  // Dedupe before anything counts the selection. A queue can hold the same file in
  // two rows, and a list selection is a set of row *objects* rather than of paths,
  // so twelve selected rows can be eleven files. Undeduped that is a doubled read,
  // a second write over a file the loop just rewrote, and a heading that says rows
  // where the user reads files.
  const unique = [...new Set(paths)];
  if (unique.length === 0) return Promise.resolve();
  return openMetadataEditor(unique, note);
}

// The menu item for a selection that is already in hand — one row or forty. The
// count goes in the label because it is the only thing between the click and a
// form that will rewrite that many files.
//
// Files, not rows, for the same reason editTags dedupes: a queue can hold one file
// in two rows, so two selected rows can be one file — and a label promising two
// tracks over a form headed "Editing song.mp3" is the menu lying about what the
// click does. Counted here off the same dedupe editTags will apply.
export function editMetadataItem(
  tracks: { path: string; notDownloaded?: boolean }[],
): ContextMenuItem {
  const files = new Set(tracks.map((t) => t.path)).size;
  return {
    label:
      files === 1 ? "Edit metadata..." : `Edit metadata for ${files} tracks...`,
    // Any one cloud-only file disables the whole item. The seed read opens every
    // selected file, so a selection carrying one dataless track would download it
    // — and a menu that greys out is a better answer than a download nobody asked
    // for, or a form that silently edits fewer files than the rows it was opened
    // from.
    disabled: tracks.some(isNotDownloaded),
    action: () => void editTags(tracks.map((t) => t.path)),
  };
}

// The same verb over an aggregate — an artist or album row, whose tracks are a
// query rather than a selection. An album is the most natural unit bulk tag
// editing has, which is why these rows carry it at all.
//
// The cloud-file rule has to be the other one, and for a reason rather than for
// convenience: `editMetadataItem` can grey itself out because `notDownloaded` is
// already on every row it was handed, while an aggregate doesn't know until the
// provider has been awaited — long after the menu is drawn. So this one is never
// disabled and filters instead, opening on the local files and saying in the
// form's note which ones it left behind. Refusing a whole album over one cloud
// track would be worse, and editing fewer files than the user pointed at without
// saying so would be worse still.
export function editMetadataProviderItem(getTracks: TrackProvider): ContextMenuItem {
  return {
    label: "Edit metadata...",
    action: () => {
      void (async () => {
        let tracks: { path: string; notDownloaded?: boolean }[];
        try {
          tracks = await getTracks();
        } catch (e) {
          console.error("editMetadataProviderItem failed", e);
          return;
        }
        // Count files, not rows — `editTags` dedupes, and a note reading "3 of
        // 14" over a heading reading "Editing 10 tracks" would be its own puzzle.
        const seen = new Set<string>();
        const local: string[] = [];
        let skipped = 0;
        for (const t of tracks) {
          if (seen.has(t.path)) continue;
          seen.add(t.path);
          if (isNotDownloaded(t)) skipped++;
          else local.push(t.path);
        }
        if (local.length === 0) {
          // Nothing to open the form on. Say why here rather than putting up an
          // editor with no files behind it.
          toast(
            skipped > 0 ? "Those tracks aren't downloaded yet." : "Nothing to edit here.",
          );
          return;
        }
        await editTags(
          local,
          skipped > 0
            ? `${skipped} of ${seen.size} aren't downloaded and were left out`
            : undefined,
        );
      })();
    },
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
