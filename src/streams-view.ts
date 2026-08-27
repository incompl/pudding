// The Streams-tab list: row rendering (select/play/context-menu/reorder) plus the
// station add/edit/delete editors. Loading + validating the stream list itself
// lives in library.ts; the shared editor machinery lives in editors.ts.

import { invoke } from "@tauri-apps/api/core";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { h } from "./dom";
import type { Stream, ContextMenuItem, InlineEditorField } from "./types";
import {
  app,
  currentStreamUrl,
  selectedStreamUrl,
  streamListWritable,
} from "./state";
import { streamsContainer, streamListPathInput } from "./dom-refs";
import { showContextMenu } from "./context-menu";
import { attachStreamReorder } from "./drag-drop";
import { buildInlineEditor, closePaneEditor, openPaneEditor } from "./editors";
import { refreshStreams } from "./library";
import { setEmpty, playStream } from "./main";

export function renderStreams(streams: Stream[]): void {
  streamsContainer.innerHTML = "";
  if (streams.length === 0) {
    setEmpty(streamsContainer, "Stream list is empty");
    return;
  }
  const ul = h("ul");
  for (const stream of streams) {
    const label = h("span", {
      class: "node-label",
      data: { streamUrl: stream.url },
    });
    if (currentStreamUrl.value === stream.url) {
      label.classList.add("playing");
    }
    if (selectedStreamUrl.value === stream.url) {
      label.classList.add("selected");
    }
    // The gutter shows the station glyph at rest and a play button on hover —
    // the same swap tree tracks do with their track number, now that a plain
    // click selects rather than plays.
    label.appendChild(
      h(
        "span",
        { class: "icon stream" },
        h("span", { class: "radio" }),
        // Plays directly and swallows the click so the row's select-on-click
        // doesn't also fire.
        h("button", {
          class: "row-play",
          attrs: { "aria-label": "Play" },
          on: {
            click: (e) => {
              e.stopPropagation();
              playStream(stream);
            },
          },
        }),
      ),
    );
    label.appendChild(h("span", { class: "label-text", text: stream.name }));
    // Single click selects (highlight only); the hover play button or a
    // double-click commits — matching the file tree and playlists.
    label.addEventListener("click", () => {
      app.lastSelectionPane = "stream";
      selectedStreamUrl.value = stream.url;
    });
    label.addEventListener("dblclick", () => playStream(stream));
    // Right-click a station to play it, or (on a writable local list) edit it
    // in place / remove it. Selecting the row first mirrors the tree's
    // right-click-selects behavior.
    label.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      app.lastSelectionPane = "stream";
      selectedStreamUrl.value = stream.url;
      const items: ContextMenuItem[] = [{ label: "Play", action: () => playStream(stream) }];
      if (streamListWritable.value) {
        items.push(
          { label: "Edit…", action: () => openEditStationEditor(stream) },
          { label: "Delete", action: () => void deleteStream(stream) },
        );
      }
      showContextMenu(e.clientX, e.clientY, items);
    });
    const li = h("li", { class: "stream-row" }, label);
    attachStreamReorder(li, stream);
    ul.appendChild(li);
  }
  streamsContainer.appendChild(ul);
}

// Pick a local image file and hand back its file:// URL (the portable form
// get_stream_image reads), or null if the dialog was dismissed. A user can also
// just type/paste an http(s) URL into the field instead of browsing.
async function browseStationImage(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
  });
  if (typeof selected !== "string") return null;
  try {
    return await invoke<string>("to_file_url", { path: selected });
  } catch (e) {
    console.error("to_file_url failed", selected, e);
    return null;
  }
}

// The three fields of a station, shared by Add and Edit so both look and behave
// identically. `stream` prefills them when editing an existing entry.
function stationEditorFields(stream?: Stream): InlineEditorField[] {
  return [
    { key: "name", label: "Name", value: stream?.name, placeholder: "Pudding FM" },
    { key: "url", label: "URL", value: stream?.url, placeholder: "https://", required: true },
    {
      key: "image",
      label: "Image",
      value: stream?.image ?? "",
      placeholder: "URL or file",
      browse: browseStationImage,
    },
  ];
}

// Add a station: open the editor face (see openPaneEditor) with an empty form.
// Only reachable when the list is writable (the Add button hides otherwise), and
// the face replaces its own contents, so no "already open" guard is needed. Save
// writes the stream, refreshes the list, and closes; Cancel just closes.
export function openAddStationEditor(): void {
  if (!streamListWritable.value) return;
  const editor = buildInlineEditor({
    fields: stationEditorFields(),
    submitLabel: "Add",
    heading: "New stream",
    onCancel: closePaneEditor,
    onSubmit: async (values) => {
      try {
        await invoke("add_stream", {
          path: streamListPathInput.value,
          name: values.name,
          url: values.url,
          image: values.image || null,
        });
      } catch (e) {
        console.error("add_stream failed", e);
        return; // leave the form up so the user can correct and retry
      }
      closePaneEditor();
      await refreshStreams(streamListPathInput.value);
    },
  });
  openPaneEditor("stream", editor);
}

// Edit an existing station in the editor face, prefilled. `index` is the
// station's position in the file (== its index in allStreams, which is the file
// order), resolved live so it's right even if the list changed since render.
// Save rewrites the entry and refreshes the list; Cancel just closes (the row was
// never touched, so nothing to restore).
function openEditStationEditor(stream: Stream): void {
  const index = app.allStreams.indexOf(stream);
  if (index < 0) return;
  const editor = buildInlineEditor({
    fields: stationEditorFields(stream),
    submitLabel: "Save",
    heading: `Editing ${stream.name}`,
    onCancel: closePaneEditor,
    onSubmit: async (values) => {
      try {
        await invoke("update_stream", {
          path: streamListPathInput.value,
          index,
          name: values.name,
          url: values.url,
          image: values.image || null,
        });
      } catch (e) {
        console.error("update_stream failed", e);
        return; // leave the form up so the user can correct and retry
      }
      closePaneEditor();
      await refreshStreams(streamListPathInput.value);
    },
  });
  openPaneEditor("stream", editor);
}

async function deleteStream(stream: Stream): Promise<void> {
  const index = app.allStreams.indexOf(stream);
  if (index < 0) return;
  const ok = await confirm(`This will remove ${stream.name} from the stream list.`, {
    title: `Remove ${stream.name}?`,
    kind: "warning",
  });
  if (!ok) return;
  try {
    await invoke("delete_stream", { path: streamListPathInput.value, index });
  } catch (e) {
    console.error("delete_stream failed", e);
    return;
  }
  await refreshStreams(streamListPathInput.value);
}
