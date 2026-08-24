// A minimal in-memory DOM, just enough to run src/library-nav.ts under node:test
// with no browser and no dependency (jsdom/happy-dom). The navigator touches a
// narrow slice of the DOM — createElement, className/textContent, append /
// appendChild / replaceChildren, addEventListener, classList.toggle, isConnected,
// and getElementById — so we model exactly that, faithfully enough for the
// behaviors the tests assert (especially isConnected flipping to false when
// replaceChildren detaches a subtree, which the async-load guard depends on).
//
// This is deliberately not a general DOM: it implements only what the module
// exercises. If library-nav starts using more of the DOM, extend this.

type Listener = (ev: FakeEvent) => void;

export interface FakeEvent {
  clientX?: number;
  clientY?: number;
  metaKey?: boolean;
  shiftKey?: boolean;
  preventDefault(): void;
}

export class FakeEl {
  readonly tagName: string;
  type = "";
  className = "";
  readonly children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  private ownText = "";
  private hasOwnText = false;
  private readonly listeners = new Map<string, Listener[]>();
  private readonly classes = new Set<string>();
  // Roots (the getElementById-registered containers) are connected by fiat; every
  // other node is connected iff it chains up to one. isConnected walks that chain.
  isRoot = false;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  // Setting textContent replaces all content with a single text node (real DOM
  // semantics); reading it concatenates descendant text so tests can read a row's
  // full label. A node with children has no own text.
  get textContent(): string {
    if (this.children.length === 0) return this.hasOwnText ? this.ownText : "";
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
    this.ownText = v;
    this.hasOwnText = true;
  }

  appendChild(child: FakeEl): FakeEl {
    if (child.parentNode) child.parentNode.remove(child);
    child.parentNode = this;
    this.children.push(child);
    this.hasOwnText = false;
    return child;
  }

  append(...nodes: FakeEl[]): void {
    for (const n of nodes) this.appendChild(n);
  }

  replaceChildren(...nodes: FakeEl[]): void {
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
    this.hasOwnText = false;
    for (const n of nodes) this.appendChild(n);
  }

  private remove(child: FakeEl): void {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
  }

  addEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  get classList() {
    const classes = this.classes;
    return {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !classes.has(c);
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
    };
  }

  get isConnected(): boolean {
    let n: FakeEl | null = this;
    while (n) {
      if (n.isRoot) return true;
      n = n.parentNode;
    }
    return false;
  }

  // --- test-only helpers (not part of the DOM contract) --------------------

  /** Fire a listener as the real element would when clicked/etc. */
  fire(type: string, ev: Partial<FakeEvent> = {}): void {
    const full: FakeEvent = { preventDefault() {}, ...ev };
    for (const fn of this.listeners.get(type) ?? []) fn(full);
  }

  /** Depth-first descendants (excluding self) matching a class. */
  queryAll(className: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl) => {
      for (const c of n.children) {
        if (c.className.split(/\s+/).includes(className)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

export class FakeDocument {
  private readonly byId = new Map<string, FakeEl>();

  createElement(tag: string): FakeEl {
    return new FakeEl(tag);
  }

  getElementById(id: string): FakeEl | null {
    return this.byId.get(id) ?? null;
  }

  /** Register a root container (as index.html would provide). */
  registerRoot(id: string): FakeEl {
    const el = new FakeEl("div");
    el.isRoot = true;
    this.byId.set(id, el);
    return el;
  }
}

/** Install a fresh document on globalThis and return it. */
export function installFakeDom(): FakeDocument {
  const doc = new FakeDocument();
  (globalThis as { document?: unknown }).document = doc;
  return doc;
}
