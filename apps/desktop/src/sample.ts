// The bundled welcome track: resource resolution and the small reactive payload
// shared by the idle hero (main.ts) and the transport's cold-start path
// (playback.ts). It is never a library item and never enters Open Recent.

import { invoke } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
import { signal } from "@preact/signals-core";
import type { SearchTrack } from "./types";

export const BUNDLED_SAMPLE: Omit<SearchTrack, "path"> = {
  title: "Pudding Sample",
  artist: "Peter Yearsley",
  album: null,
  albumArtist: "Lewis Carroll",
};

export const bundledSamplePath = signal<string | null>(null);
export const bundledSampleArt = signal<string | null>(null);

export async function prepareBundledSample(): Promise<void> {
  const path = await resolveResource("pudding sample.mp3");
  bundledSamplePath.value = path;
  bundledSampleArt.value = await invoke<string | null>("get_art", { path });
}
