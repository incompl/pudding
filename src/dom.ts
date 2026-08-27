// A tiny element-construction helper. It only *builds* DOM — no reactivity, no
// diffing — so it slots under the existing signals model: effects still own
// updates, this just replaces the createElement/appendChild/addEventListener
// boilerplate the render functions repeat. See renderLeafTrackList for the
// before/after.

type Child = Node | string | number | false | null | undefined;

export interface ElProps<K extends keyof HTMLElementTagNameMap> {
  // Space-separated class list (the common case, so it gets a short name).
  class?: string;
  // textContent shorthand; ignored if children are also passed.
  text?: string;
  // data-* attributes (keys are the bit after data-, camelCase like dataset).
  data?: Record<string, string | number>;
  // Any other attributes (type, aria-*, role, disabled…). false/null omits it.
  attrs?: Record<string, string | number | boolean | null | undefined>;
  // Inline styles, including custom properties via setProperty for --vars.
  style?: Record<string, string>;
  // Typed event listeners: { click: (e) => …, contextmenu: (e) => … }.
  on?: {
    [E in keyof HTMLElementEventMap]?: (
      this: HTMLElementTagNameMap[K],
      ev: HTMLElementEventMap[E],
    ) => void;
  };
}

// h("div", { class: "nav-track-row", on: { click } }, child, child)
// Falsy children (a conditional row part) are skipped, so callers can inline
// `cond && h(...)` instead of pushing to an array.
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps<K> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.data) {
    for (const [k, v] of Object.entries(props.data)) el.dataset[k] = String(v);
  }
  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v === false || v == null) continue;
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  if (props.style) {
    for (const [k, v] of Object.entries(props.style)) {
      el.style.setProperty(k, v);
    }
  }
  if (props.on) {
    for (const [type, handler] of Object.entries(props.on)) {
      el.addEventListener(type, handler as EventListener);
    }
  }
  append(el, children);
  return el;
}

// Append children to a parent, flattening arrays and skipping falsy entries.
// Numbers/strings become text nodes. Exposed for render functions that build a
// container up front and fill it in a loop.
export function append(parent: Node, children: Child | Child[]): void {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === false || child == null) continue;
    parent.appendChild(
      typeof child === "string" || typeof child === "number"
        ? document.createTextNode(String(child))
        : child,
    );
  }
}
