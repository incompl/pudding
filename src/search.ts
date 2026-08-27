// The global search widget: the debounced multi-source query (artists, albums,
// folders, playlists, streams, tracks), the results dropdown, and its keyboard
// navigation. setupSearch() wires it once at startup.

import { invoke } from "@tauri-apps/api/core";
import { h } from "./dom";
import type {
  SearchItem,
  SearchArtist,
  SearchAlbum,
  SearchFolder,
  SearchTrack,
} from "./types";
import { activeTab, app } from "./state";
import { searchResultsEl, searchInput } from "./dom-refs";
import { showContextMenu } from "./context-menu";
import {
  openArtistQueue,
  openAlbumQueue,
  playFolder,
  playSearchTrack,
  playPlaylistPath,
  playStream,
  persistActiveTab,
  libraryRootPaths,
  searchItemTrackProvider,
  addToPlaylistItem,
  debounce,
} from "./main";

function searchLabel(t: SearchTrack): { primary: string; secondary: string } {
  const fallbackName = t.path.split(/[\\/]/).pop() ?? t.path;
  return {
    primary: t.title ?? fallbackName,
    secondary: [t.artist, t.album].filter(Boolean).join(" · "),
  };
}

export function setupSearch(): void {
  let items: SearchItem[] = [];
  let activeIndex = -1;
  // Bumped per query so a slow search_tracks that resolves after a newer
  // keystroke can't overwrite fresher results.
  let queryToken = 0;
  // Query and caret held while the input is blurred. Blur empties the visible
  // box (the collapsed field just shows clipped stale text otherwise) but the
  // search isn't discarded: refocusing restores the query, its selection, and
  // reopens its results.
  let stash: {
    query: string;
    start: number;
    end: number;
    dir: "forward" | "backward" | "none";
  } | null = null;
  const searchBox = document.getElementById("search") as HTMLElement;

  function close(): void {
    items = [];
    activeIndex = -1;
    searchResultsEl.classList.add("hidden");
    searchResultsEl.innerHTML = "";
  }

  function choose(item: SearchItem): void {
    if (item.kind === "artist") {
      void openArtistQueue(item.artist.name);
    } else if (item.kind === "album") {
      void openAlbumQueue(item.album.album, item.album.artist);
    } else if (item.kind === "folder") {
      // Play into the queue without touching the left panel — no tab switch or
      // scroll, so a search never yanks you away from where you were browsing.
      void playFolder(item.folder);
    } else if (item.kind === "file") {
      playSearchTrack(item.track);
    } else if (item.kind === "playlist") {
      // Choosing a playlist plays it, consistent with every other search hit
      // (there's no single/double-click split in search, so a choice is a play,
      // not the tree's browse). It opens as the playing source and starts from
      // the first track; preview-only browsing lives in the tree.
      void playPlaylistPath(item.playlist.path);
    } else {
      activeTab.value = "streams";
      void persistActiveTab();
      playStream(item.stream);
    }
    searchInput.value = "";
    searchInput.blur();
    close();
  }

  function render(): void {
    searchResultsEl.innerHTML = "";
    if (items.length === 0) {
      searchResultsEl.appendChild(
        h("div", { class: "search-empty", text: "No results" }),
      );
      searchResultsEl.classList.remove("hidden");
      return;
    }
    let activeRow: HTMLElement | null = null;
    items.forEach((item, i) => {
      // Distinct masked-SVG icons (like the folder row's) mark artist, album,
      // folder and playlist rows so the library row types read apart at a glance;
      // file/stream rows carry no icon. The glyph is a masked SVG in .search-icon
      // so it takes the row's color instead of the OS emoji.
      let iconClass: string | null = null;
      let primaryText = "";
      let secondaryText = "";
      if (item.kind === "artist") {
        iconClass = "search-icon icon-artist";
        primaryText = item.artist.name;
        secondaryText = "Artist";
      } else if (item.kind === "album") {
        iconClass = "search-icon icon-album";
        primaryText = item.album.album;
        secondaryText = item.album.artist ? `Album · ${item.album.artist}` : "Album";
      } else if (item.kind === "folder") {
        iconClass = "search-icon";
        primaryText = item.folder.name;
        // The containing folder's path (relative to its library folder) gives
        // context — which artist an album sits under. Skipped for top-level
        // folders, where the parent is a library folder itself and adds only
        // noise. With several library folders, strip whichever one contains it.
        const parentPath = item.folder.path.split("/").slice(0, -1).join("/");
        const root = libraryRootPaths().find(
          (r) => parentPath === r || parentPath.startsWith(r + "/"),
        );
        if (root && parentPath !== root) {
          secondaryText = parentPath.slice(root.length + 1);
        } else if (!root) {
          secondaryText = parentPath;
        }
      } else if (item.kind === "file") {
        const l = searchLabel(item.track);
        primaryText = l.primary;
        secondaryText = l.secondary;
      } else if (item.kind === "playlist") {
        iconClass = "search-icon icon-playlist";
        primaryText = item.playlist.name;
        secondaryText = "Playlist";
      } else {
        primaryText = item.stream.name;
      }
      const text = h(
        "span",
        { class: "text" },
        h("div", { class: "primary", text: primaryText }),
        secondaryText && h("div", { class: "secondary", text: secondaryText }),
      );
      const row = h(
        "div",
        {
          class: i === activeIndex ? "search-result active" : "search-result",
          attrs: { role: "option" },
          // mousedown, not click: clicking a row blurs the input first, and a blur
          // handler that closed the dropdown would remove the row before click.
          // preventDefault keeps the input focused (so the dropdown survives a
          // right-click); only a left-click chooses the row.
          on: {
            mousedown: (e) => {
              e.preventDefault();
              if (e.button === 0) choose(item);
            },
          },
        },
        iconClass && h("span", { class: iconClass }),
        text,
      );
      if (i === activeIndex) activeRow = row;
      // Right-click a track-bearing hit to add it to a playlist.
      const provider = searchItemTrackProvider(item);
      if (provider) {
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, [addToPlaylistItem(provider)]);
        });
      }
      searchResultsEl.appendChild(row);
    });
    searchResultsEl.classList.remove("hidden");
    if (activeRow) (activeRow as HTMLElement).scrollIntoView({ block: "nearest" });
  }

  const runSearch = debounce(async (raw: string) => {
    const token = ++queryToken;
    const query = raw.trim();
    if (!query) {
      close();
      return;
    }
    const needle = query.toLowerCase();
    const streamItems: SearchItem[] = app.allStreams
      .filter((s) => s.name.toLowerCase().includes(needle))
      .map((s) => ({ kind: "stream", stream: s }));
    // Playlists are indexed client-side (kept fresh by the watcher), so they
    // filter here alongside streams rather than through a backend query.
    const playlistItems: SearchItem[] = app.playlistIndex
      .filter((p) => p.name.toLowerCase().includes(needle))
      .map((p) => ({ kind: "playlist", playlist: p }));
    let artistItems: SearchItem[] = [];
    let albumItems: SearchItem[] = [];
    let folderItems: SearchItem[] = [];
    let fileItems: SearchItem[] = [];
    try {
      const [artists, albums, folders, tracks] = await Promise.all([
        invoke<SearchArtist[]>("search_artists", { query }),
        invoke<SearchAlbum[]>("search_albums", { query }),
        invoke<SearchFolder[]>("search_folders", { query }),
        invoke<SearchTrack[]>("search_tracks", { query }),
      ]);
      artistItems = artists.map((a) => ({ kind: "artist", artist: a }));
      albumItems = albums.map((a) => ({ kind: "album", album: a }));
      folderItems = folders.map((f) => ({ kind: "folder", folder: f }));
      fileItems = tracks.map((t) => ({ kind: "file", track: t }));
    } catch (e) {
      console.error("search failed", e);
    }
    if (token !== queryToken) return;
    // Artists and albums first (a metadata-name match usually means "open that
    // page"), then folders and playlists (both "open this collection" hits),
    // streams, and finally individual tracks.
    items = [
      ...artistItems,
      ...albumItems,
      ...folderItems,
      ...playlistItems,
      ...streamItems,
      ...fileItems,
    ];
    activeIndex = items.length > 0 ? 0 : -1;
    render();
  }, 150);

  searchInput.addEventListener("input", () => runSearch(searchInput.value));
  searchInput.addEventListener("focus", () => {
    if (stash && !searchInput.value) {
      searchInput.value = stash.query;
      // Restores the caret for keyboard-driven focus (tab, window
      // reactivation). On mouse focus the browser places the caret from the
      // click position afterward, which is the better behavior there anyway.
      searchInput.setSelectionRange(stash.start, stash.end, stash.dir);
    }
    if (searchInput.value.trim()) runSearch(searchInput.value);
  });

  // Escape and choose() clear the value before blurring, so only abandoned
  // queries survive the round trip. The runSearch("") call supersedes any
  // pending debounced keystroke that would otherwise reopen the dropdown
  // after the box has visually emptied.
  searchInput.addEventListener("blur", () => {
    stash = searchInput.value
      ? {
          query: searchInput.value,
          start: searchInput.selectionStart ?? searchInput.value.length,
          end: searchInput.selectionEnd ?? searchInput.value.length,
          dir: searchInput.selectionDirection ?? "none",
        }
      : null;
    searchInput.value = "";
    close();
    runSearch("");
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      close();
      searchInput.blur();
      return;
    }
    if (searchResultsEl.classList.contains("hidden") || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[activeIndex >= 0 ? activeIndex : 0]);
    }
  });

  // Cmd/Ctrl+F focuses the search field (matches Apple Music / iTunes).
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // Swallow mousedown inside the widget so it never reaches the document-level
  // drag-region handler (which would otherwise start a window drag) or the
  // outside-click closer below.
  searchBox.addEventListener("mousedown", (e) => e.stopPropagation());

  // Any mousedown that escapes the widget closes the dropdown.
  document.addEventListener("mousedown", () => close());
}
