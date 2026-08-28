// Theming. The app's neutral palette (the blacks / grays / whites) is chosen by
// MODE (dark / light / system); a THEME only swaps the two accent custom
// properties (--accent / --accent-dim). So a "theme" is nothing more than an
// accent pair layered on the mode's neutrals — see styles.css :root (dark
// neutrals) and the html[data-mode="…"] hook applyTheme sets below.
//
// Persistence is three keys: the mode preference, plus the chosen accent *per*
// mode. Splitting the accent by mode is what makes an OS dark<->light auto-switch
// (mode "system", e.g. a macOS sunset flip) a non-event: applyTheme re-resolves
// to the accent saved for whichever side is now active, and neither choice ever
// clobbers the other.
//
// A leaf module: imports only the signal lib + the shared store (state.ts). The
// settings UI that renders the swatch row lives in main.ts and drives this
// through setThemeMode / setAccentFor.

import { effect, signal } from "@preact/signals-core";
import { app } from "./state";

export type ThemeMode = "dark" | "light";
export type ThemeModePref = ThemeMode | "system";

export interface AccentTheme {
  id: string;
  name: string;
  accent: string; // --accent
  accentDim: string; // --accent-dim (hovers, seek track, disabled, live pulse)
}

export const DARK_THEMES: AccentTheme[] = [
  { id: "pistachio", name: "Pistachio", accent: "#b5d17a", accentDim: "#7e9152" },
  { id: "dreamcicle", name: "Dreamcicle", accent: "#f5a966", accentDim: "#be7637" },
  { id: "blackberry", name: "Blackberry", accent: "#db6bf4", accentDim: "#a94fc0" },
  { id: "blueberry", name: "Blueberry", accent: "#3ea9ff", accentDim: "#217fcb" },
  { id: "banana", name: "Banana", accent: "#f0d375", accentDim: "#b19843" },
  { id: "strawberry", name: "Strawberry", accent: "#ef6c7e", accentDim: "#c14858" },
];

export const LIGHT_THEMES: AccentTheme[] = [
  { id: "emerald", name: "Emerald", accent: "#00a86b", accentDim: "#007a4e" },
  { id: "sunstone", name: "Sunstone", accent: "#ff740a", accentDim: "#c55a08" },
  { id: "amethyst", name: "Amethyst", accent: "#a32bff", accentDim: "#701ab3" },
  { id: "sapphire", name: "Sapphire", accent: "#0a3dff", accentDim: "#1334ae" },
  { id: "coffee", name: "Coffee", accent: "#966428", accentDim: "#673018" },
  { id: "ruby", name: "Ruby", accent: "#f61d52", accentDim: "#c31641" },
];

// The neutral background each mode paints (styles.css :root --bg for dark, the
// html[data-mode="light"] --bg override for light). The settings preview cards
// fill themselves with this so a swatch shows its accent on the mode's real
// black/white ground rather than floating on the settings pane — letting all
// themes, both modes, preview truthfully side by side. Kept in sync by hand.
export const MODE_BG: Record<ThemeMode, string> = {
  dark: "#000",
  light: "#ffffff",
};

const DEFAULT_DARK_ACCENT = "pistachio";
const DEFAULT_LIGHT_ACCENT = "emerald";

export const KEY_THEME_MODE = "themeMode";
export const KEY_DARK_ACCENT = "darkAccent";
export const KEY_LIGHT_ACCENT = "lightAccent";

// Reactive so the settings swatch row can re-render (and re-highlight) whenever
// the mode or a per-mode accent changes, and applyTheme can be an effect.
export const themeMode = signal<ThemeModePref>("dark");
export const darkAccent = signal<string>(DEFAULT_DARK_ACCENT);
export const lightAccent = signal<string>(DEFAULT_LIGHT_ACCENT);

const prefersDark =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

// The OS scheme as a signal so effects re-run on an auto dark<->light flip. Only
// consequential while the mode preference is "system"; harmless otherwise.
const osPrefersDark = signal(prefersDark?.matches ?? true);

// The mode actually in force: the preference, or the live OS scheme under "system".
export function effectiveMode(): ThemeMode {
  if (themeMode.value === "system") return osPrefersDark.value ? "dark" : "light";
  return themeMode.value;
}

export function themesForMode(mode: ThemeMode): AccentTheme[] {
  return mode === "dark" ? DARK_THEMES : LIGHT_THEMES;
}

// The accent id chosen for a mode (its persisted signal's value).
export function accentIdFor(mode: ThemeMode): string {
  return mode === "dark" ? darkAccent.value : lightAccent.value;
}

function resolveTheme(mode: ThemeMode): AccentTheme | undefined {
  const themes = themesForMode(mode);
  const id = accentIdFor(mode);
  return themes.find((t) => t.id === id) ?? themes[0];
}

// Push the resolved mode + accent onto <html>: data-mode drives the neutral
// palette in CSS; setting the two custom properties recolors everything that
// reads var(--accent…). Registered as an effect (setupTheme), so it re-runs on
// any preference, accent, or OS-scheme change.
export function applyTheme(): void {
  const mode = effectiveMode();
  document.documentElement.dataset.mode = mode;
  const theme = resolveTheme(mode);
  const root = document.documentElement.style;
  if (theme) {
    root.setProperty("--accent", theme.accent);
    root.setProperty("--accent-dim", theme.accentDim);
  } else {
    // No theme defined for this mode yet (the light set is still empty): drop the
    // overrides so :root's accent shows through rather than a stale one.
    root.removeProperty("--accent");
    root.removeProperty("--accent-dim");
  }
}

// --- Persistence ---

// Read the three persisted keys into the signals. Call once after the store
// loads and before setupTheme, so the first apply paints the saved appearance.
export async function loadThemeSettings(): Promise<void> {
  const mode = await app.store.get<string>(KEY_THEME_MODE);
  if (mode === "dark" || mode === "light" || mode === "system") themeMode.value = mode;
  const dark = await app.store.get<string>(KEY_DARK_ACCENT);
  if (typeof dark === "string") darkAccent.value = dark;
  const light = await app.store.get<string>(KEY_LIGHT_ACCENT);
  if (typeof light === "string") lightAccent.value = light;
}

async function persistThemeMode(): Promise<void> {
  await app.store.set(KEY_THEME_MODE, themeMode.value);
  await app.store.save();
}

async function persistAccents(): Promise<void> {
  await app.store.set(KEY_DARK_ACCENT, darkAccent.value);
  await app.store.set(KEY_LIGHT_ACCENT, lightAccent.value);
  await app.store.save();
}

export function setThemeMode(mode: ThemeModePref): void {
  themeMode.value = mode;
  void persistThemeMode();
}

// Select an accent for a specific mode (writes that mode's key), independent of
// which mode is currently effective — the combined appearance picker sets the
// dark and light accents from their own rows, and choosing one never touches the
// other's preference.
export function setAccentFor(mode: ThemeMode, id: string): void {
  if (mode === "dark") darkAccent.value = id;
  else lightAccent.value = id;
  void persistAccents();
}

// Wire the apply-on-change effect + the OS-scheme listener. Call once at startup
// after loadThemeSettings so the first apply uses the persisted values.
export function setupTheme(): void {
  prefersDark?.addEventListener("change", (e) => {
    osPrefersDark.value = e.matches;
  });
  // Tracks themeMode, osPrefersDark, and the active accent signal via resolveTheme.
  effect(applyTheme);
}
