// Cursor-positioned context menu (tree rows, queue rows, search results) — drawn
// by the OS. A thin adapter and nothing more: it maps our declarative
// ContextMenuItem tree onto the payloads @tauri-apps/api/menu accepts, then pops
// the result at the click. Every behavior the old DOM menu hand-rolled —
// dismissal on an outside press, Escape, scroll and resize, hover-opened
// flyouts, viewport clamping, keyboard navigation, type-select — is AppKit's.
// Only showContextMenu is public.

import { Menu, type MenuOptions } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import type { ContextMenuItem } from "./types";

// One entry of a native menu, as the plugin's untagged payload. Which kind of
// item the Rust side builds is inferred from the fields present, in this order:
// `item` → predefined (our separators), `checked` → check item, `items` →
// submenu, otherwise a plain item. That ordering is why `checked` must never
// appear beside `items`: the pair would deserialize as a check item and the
// submenu would silently vanish. ContextMenuItem's submenu variant carries no
// `checked` for exactly that reason.
type NativeItem = NonNullable<MenuOptions["items"]>[number];

// The last menu we popped, still holding its native resource. See showContextMenu.
let previous: Menu | null = null;

// Ids are derived from the item's position in the tree ("ctx:1.0.3") rather than
// left to Tauri's generator. Tauri keys each item's action channel by menu-item
// id in a map it never evicts, so a fresh id per right-click would grow that map
// for the life of the process; a positional id makes the next popup overwrite the
// same slot. The "ctx:" prefix keeps them clear of the menubar's ids, which the
// Rust on_menu_event handler matches by name (src-tauri/src/lib.rs).
function toNative(items: ContextMenuItem[], path: string): NativeItem[] {
  return items.map((item, i): NativeItem => {
    if ("separator" in item) return { item: "Separator" };
    const id = `ctx:${path}${i}`;
    const enabled = item.disabled !== true;
    if ("submenu" in item) {
      // A submenu may be a thunk so its level can be built against live state
      // (the Columns picker's checkmarks). Native menus are built whole, up
      // front, so it resolves here rather than on hover — still per right-click,
      // so the checkmarks are as fresh as they ever were.
      const sub = typeof item.submenu === "function" ? item.submenu() : item.submenu;
      return { id, text: item.label, enabled, items: toNative(sub, `${path}${i}.`) };
    }
    const action = item.action;
    if (item.checked === undefined) return { id, text: item.label, enabled, action };
    return { id, text: item.label, enabled, checked: item.checked, action };
  });
}

// Pop a menu at (x, y) — viewport CSS pixels, i.e. a click's clientX/clientY.
// The window has a full-size content view (titleBarStyle "Overlay"), so the
// webview sits at its origin and those coordinates are the window coordinates
// the native side positions against.
//
// Resolves once the menu is dismissed; the chosen item's action runs on its own
// channel and is not awaited here. Call sites are contextmenu listeners, which
// can't await, so they discard the promise with `void`.
export async function showContextMenu(
  x: number,
  y: number,
  items: ContextMenuItem[],
): Promise<void> {
  const menu = await Menu.new({ items: toNative(items, "") });
  // Free the *previous* popup's native resource, not this one's on dismissal: an
  // item's action arrives over a channel and can land after popup() resolves, so
  // a menu is kept alive until the next right-click replaces it.
  const stale = previous;
  previous = menu;
  try {
    await menu.popup(new LogicalPosition(x, y));
  } finally {
    if (stale) void stale.close().catch((e) => console.error("menu close failed", e));
  }
}
