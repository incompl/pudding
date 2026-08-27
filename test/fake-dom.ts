// A minimal in-memory DOM, just enough to run src/library-nav.ts under node:test
// with no browser and no dependency (jsdom/happy-dom). The navigator touches a
// narrow slice of the DOM — createElement, className/textContent, setAttribute,
// append / appendChild / replaceChildren, addEventListener, classList.toggle,
// isConnected, and getElementById — so we model exactly that, faithfully enough for the
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

// The exact slice of the real DOM this fake models, written down as a contract the
// fake must `implements`. Two payoffs over the old `as unknown as Document` cast:
//   - `implements` forces FakeEl/FakeDocument to keep providing every modeled
//     member — the fake can't silently lose a method the source relies on;
//   - the `_FaithfulEl` check below proves the scalar/attribute signatures match
//     lib.dom, so a member modeled with the wrong shape (e.g. a one-arg
//     setAttribute) fails to compile.
// When src/ starts touching a DOM member not listed here, add it to the contract:
// the fake won't compile until it's modeled, which surfaces the gap at the point
// you extend the surface rather than as a runtime "x is not a function" mid-test.
interface ModeledElement {
  readonly tagName: string;
  className: string;
  textContent: string;
  readonly isConnected: boolean;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: Listener): void;
  // Tree + classList ops are modeled in the fake's own terms (FakeEl, not a
  // generic Node), so they're contract-checked for existence but not against
  // lib.dom's signatures — see _FaithfulEl for what is.
  appendChild(child: FakeEl): FakeEl;
  append(...nodes: FakeEl[]): void;
  replaceChildren(...nodes: FakeEl[]): void;
  classList: {
    add(c: string): void;
    remove(c: string): void;
    contains(c: string): boolean;
    toggle(c: string, force?: boolean): boolean;
  };
}

interface ModeledDocument {
  createElement(tag: string): FakeEl;
  getElementById(id: string): FakeEl | null;
}

// Prove the scalar/attribute members match the real DOM. If a modeled signature
// drifts from lib.dom, `_FaithfulEl` becomes `false` and `_AssertTrue<false>`
// fails to compile. (createElement/getElementById and the tree ops return FakeEl
// rather than a real Node, so they're deliberately outside this check.)
type FaithfulKeys =
  | "tagName"
  | "className"
  | "textContent"
  | "isConnected"
  | "setAttribute"
  | "getAttribute";
type _FaithfulEl = Pick<ModeledElement, FaithfulKeys> extends Pick<HTMLElement, FaithfulKeys>
  ? true
  : false;
type _AssertTrue<T extends true> = T;
// Exported only so it counts as "used" (noUnusedLocals); its job is to fail to
// compile — via the _AssertTrue<false> constraint — if _FaithfulEl drifts.
export type _FaithfulElCheck = _AssertTrue<_FaithfulEl>;

export class FakeEl implements ModeledElement {
  readonly tagName: string;
  type = "";
  className = "";
  readonly children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  private ownText = "";
  private hasOwnText = false;
  private readonly listeners = new Map<string, Listener[]>();
  private readonly classes = new Set<string>();
  private readonly attributes = new Map<string, string>();
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

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
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

export class FakeDocument implements ModeledDocument {
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
  // The one unavoidable cast: globalThis.document is typed as the full Document,
  // and FakeDocument is deliberately a partial (see ModeledDocument). Everything
  // the source actually reaches through `document` is covered by the contract
  // above; this boundary is the single spot where that partiality is asserted.
  globalThis.document = doc as unknown as Document;
  return doc;
}
