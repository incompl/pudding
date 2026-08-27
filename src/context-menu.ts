// Cursor-positioned context menu (tree rows, queue rows, search results). A
// self-contained leaf: its own open-menu stack + listener-installed flag, the
// `h` DOM builder, and the ContextMenuItem type — nothing else. Only
// showContextMenu is public; the rest is internal machinery.

import { h } from "./dom";
import type { ContextMenuItem } from "./types";

// The open menu stack: index 0 is the root, deeper entries are flyouts. Kept so
// dismissal removes every level and a hover can close menus below a given depth.
let contextMenus: HTMLElement[] = [];
let contextMenuListenersInstalled = false;

function hideContextMenu(): void {
  for (const m of contextMenus) m.remove();
  contextMenus = [];
}

function contextMenusContain(target: Node): boolean {
  return contextMenus.some((m) => m.contains(target));
}

// Close every flyout deeper than `depth`, leaving that menu and its ancestors up.
function closeSubmenusBelow(depth: number): void {
  while (contextMenus.length > depth + 1) {
    contextMenus.pop()?.remove();
  }
}

function ensureContextMenuListeners(): void {
  if (contextMenuListenersInstalled) return;
  contextMenuListenersInstalled = true;
  // A press anywhere outside the menu(s) dismisses; items run on click, which
  // fires after this mousedown. Capture phase so it fires even if a descendant
  // (e.g. the search input's native shadow DOM) swallows the bubbling event.
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!contextMenusContain(e.target as Node)) hideContextMenu();
    },
    true,
  );
  // Focus moving out of the menu also dismisses it — covers focusing the search
  // box (or any control) by click or keyboard.
  document.addEventListener("focusin", (e) => {
    if (!contextMenusContain(e.target as Node)) hideContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
  });
  window.addEventListener("resize", hideContextMenu);
  // Capture so a scroll in any container (e.g. the tree) closes the menu, since
  // its fixed position would otherwise detach from the row.
  window.addEventListener("scroll", hideContextMenu, true);
}

// Clamp a menu to the viewport so an edge row doesn't push it offscreen.
function positionContextMenu(menu: HTMLElement, x: number, y: number): void {
  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

// Build one menu level (root or flyout) at `depth`. Hovering any row closes
// deeper flyouts; a `submenu` row then opens its own flyout beside itself.
function buildContextMenu(items: ContextMenuItem[], depth: number): HTMLElement {
  const menu = h("div", { class: "context-menu" });
  for (const item of items) {
    const row = h("div", { class: "context-menu-item", text: item.label });
    if ("submenu" in item) {
      row.classList.add("has-submenu");
      const submenu = item.submenu;
      row.addEventListener("mouseenter", () => {
        closeSubmenusBelow(depth);
        const child = buildContextMenu(submenu, depth + 1);
        document.body.appendChild(child);
        contextMenus.push(child);
        // Open to the row's right, aligned to its top; positionContextMenu flips
        // it left if it would overflow.
        const r = row.getBoundingClientRect();
        positionContextMenu(child, r.right - 2, r.top);
      });
    } else {
      const action = item.action;
      row.addEventListener("mouseenter", () => closeSubmenusBelow(depth));
      row.addEventListener("click", () => {
        hideContextMenu();
        action();
      });
    }
    menu.appendChild(row);
  }
  return menu;
}

export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  ensureContextMenuListeners();
  hideContextMenu();
  const menu = buildContextMenu(items, 0);
  document.body.appendChild(menu);
  contextMenus.push(menu);
  positionContextMenu(menu, x, y);
}
