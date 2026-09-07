#!/usr/bin/env node
// Generates public/licenses.json — the data behind Help ▸ Licenses.
//
// Nothing here is hand-maintained: the list is derived from the real dependency
// graphs (cargo's resolve output for the Rust side, pnpm's for the frontend), and
// each entry's license text is the actual file shipped inside that package. Run
// it via `pnpm gen:licenses`; `pnpm build` runs it first, so a release always
// ships an accurate list.
//
// The output lands in public/ rather than src/ deliberately: Vite copies it to
// dist verbatim, so half a megabyte of license text stays out of the JS bundle
// and is fetched only when the panel is opened.
//
// License *texts* are deduplicated (whitespace-normalized) into a shared array
// and referenced by index — hundreds of crates ship the same Apache-2.0 body.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Filenames a package might use for its license text. NOTICE is included because
// Apache-2.0 requires redistributing it when present.
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)/i;

// The deduplication table. Keyed on the text with whitespace collapsed so that
// two copies of the same license differing only in line wrapping share an entry;
// the first-seen text is what we keep and show.
const texts = [];
const textIndex = new Map();
function intern(text) {
  const key = text.replace(/\s+/g, " ").trim();
  if (!key) return -1;
  const found = textIndex.get(key);
  if (found !== undefined) return found;
  textIndex.set(key, texts.length);
  texts.push(text.trimEnd());
  return texts.length - 1;
}

// Concatenate every license-ish file in a package directory. Dual-licensed
// packages ship LICENSE-MIT *and* LICENSE-APACHE and we owe the reader both, so
// they're joined under their filenames rather than picking one.
function readLicenseDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return -1;
  }
  const files = entries
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
    .map((e) => e.name)
    .sort();
  if (!files.length) return -1;
  const parts = [];
  for (const name of files) {
    let body;
    try {
      body = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!body.trim()) continue;
    parts.push(files.length > 1 ? `=== ${name} ===\n\n${body.trim()}` : body.trim());
  }
  return parts.length ? intern(parts.join("\n\n")) : -1;
}

// --- Rust crates -----------------------------------------------------------
//
// --filter-platform prunes the resolve graph to what actually builds for macOS,
// so Windows/Linux-only crates don't show up in a list of what this binary
// contains. We then walk the graph from our own package following normal and
// build dependencies: dev-dependencies are test-only and never ship.
function cargoComponents() {
  const meta = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--manifest-path",
        path.join(root, "src-tauri/Cargo.toml"),
        "--filter-platform",
        process.arch === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin",
      ],
      { maxBuffer: 1 << 28, encoding: "utf8", cwd: root },
    ),
  );
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));

  const reached = new Set();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    for (const dep of nodes.get(id).deps) {
      const kinds = dep.dep_kinds.map((k) => k.kind ?? "normal");
      if (!kinds.some((k) => k === "normal" || k === "build")) continue;
      if (reached.has(dep.pkg)) continue;
      reached.add(dep.pkg);
      stack.push(dep.pkg);
    }
  }
  reached.delete(meta.resolve.root);

  return [...reached]
    .map((id) => byId.get(id))
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      ecosystem: "cargo",
      license: pkg.license ?? "",
      url: pkg.repository || `https://crates.io/crates/${pkg.name}`,
      // license_file names a non-standard path; otherwise scan the crate dir.
      text: pkg.license_file
        ? intern(
            fs.readFileSync(path.join(path.dirname(pkg.manifest_path), pkg.license_file), "utf8"),
          )
        : readLicenseDir(path.dirname(pkg.manifest_path)),
    }));
}

// --- npm packages ----------------------------------------------------------
//
// --prod only: devDependencies (vite, playwright, typescript...) are build tooling
// and none of their code is in the shipped bundle.
function npmComponents() {
  const tree = JSON.parse(
    execFileSync("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], {
      maxBuffer: 1 << 28,
      encoding: "utf8",
      cwd: root,
    }),
  );
  const found = new Map();
  const visit = (node) => {
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      const id = `${name}@${dep.version}`;
      if (found.has(id)) continue;
      found.set(id, { name, ...dep });
      visit(dep);
    }
  };
  for (const project of tree) visit(project);

  return [...found.values()].map((dep) => {
    let manifest = {};
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dep.path, "package.json"), "utf8"));
    } catch {
      /* fall through to the bare name/version entry */
    }
    const repo =
      typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
    return {
      name: dep.name,
      version: dep.version,
      ecosystem: "npm",
      license: typeof manifest.license === "string" ? manifest.license : "",
      url: (repo ?? "").replace(/^git\+/, "").replace(/\.git$/, "") ||
        `https://www.npmjs.com/package/${dep.name}`,
      text: readLicenseDir(dep.path),
    };
  });
}

// --- Vendored icon artwork -------------------------------------------------
//
// The glyphs in src/styles.css are Lucide icon paths, inlined as CSS mask data
// URLs rather than installed — a handful of frozen strings, consumed in a form no
// package ships. That makes them the same blind spot as the Rust standard library
// below: their artwork is in what we ship while neither dependency graph mentions
// them, so `pnpm list --prod` can never surface it. Named here instead.
//
// "ISC AND MIT", not just ISC: Lucide inherited some icons from Feather, which
// stay under Cole Bemis's MIT, and Pudding uses icons from both halves (music,
// lock and radio are Feather's; list-music, folder, user and disc are Lucide's).
// The upstream LICENSE carries both notices, which is what the supplement holds.
function lucideComponent() {
  return {
    name: "Lucide",
    version: "icon artwork",
    ecosystem: "vendored",
    license: "ISC AND MIT",
    url: "https://lucide.dev",
    text: -1,
  };
}

// lucideComponent joins the list here, before the supplement pass below, so its
// notice is attached the same way every other text-less component's is. (The Rust
// standard library is pushed after that pass — it recovers its text from the
// toolchain and needs no supplement.)
const components = [...cargoComponents(), ...npmComponents(), lucideComponent()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);

// --- Canonical texts for packages that ship none ---------------------------
//
// A crate may declare `license = "MPL-2.0"` and ship no LICENSE file (the whole
// symphonia family does this — the license lives at their workspace root, which
// crates.io doesn't package). For licenses whose text is fixed — no per-holder
// copyright line to get wrong — we can fill the gap from a sibling package that
// *does* ship it, which keeps this derived rather than hand-written.
//
// Deliberately excludes MIT/BSD/ISC and friends: their text carries the
// copyright holder's own name, so one package's copy is not another's. Those
// entries stay text-less and the panel points at the project instead.
const INVARIANT = ["Apache-2.0", "MPL-2.0", "Unicode-3.0", "CC0-1.0", "Unlicense"];
const canonical = new Map();
for (const id of INVARIANT) {
  // Only packages licensed under exactly this one license are evidence of what
  // its text is; a dual-licensed package's LICENSE file could be either half.
  const votes = new Map();
  for (const c of components) {
    if (c.license === id && c.text >= 0) votes.set(c.text, (votes.get(c.text) ?? 0) + 1);
  }
  // Take the copy the most packages agree on, and only if at least two do — one
  // package's file is not evidence of a canonical text. Copies do drift in small
  // ways (the MPL's Exhibit A link is http: in some, https: in others), so this
  // is a vote rather than a demand for unanimity.
  const [text, count] = [...votes].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (count === undefined || count < 2) continue;
  canonical.set(id, text);
  for (const c of components) {
    if (c.license === id && c.text < 0) c.text = text;
  }
}

// --- Electing a branch of an "or" license ----------------------------------
//
// A package offered under "MIT OR Apache-2.0" that ships no text can still be
// covered: dual licensing exists so the user may pick, and we can pick the
// branch whose text is invariant and therefore recoverable (above). Doing so is
// an actual election — the panel says which branch the shown text is, so nobody
// reads it as the package's only terms.
//
// "AND" expressions are excluded: those require every named license at once, so
// there is nothing to choose and a single text would under-report.
for (const c of components) {
  if (c.text >= 0 || /\bAND\b/.test(c.license)) continue;
  // Both spellings of "or" appear in the wild: "MIT OR Apache-2.0" and the older
  // "MIT/Apache-2.0".
  const options = c.license.split(/\s+OR\s+|\//).map((o) => o.trim().replace(/^\(|\)$/g, ""));
  const pick = options.find((o) => canonical.has(o));
  if (!pick) continue;
  c.text = canonical.get(pick);
  c.elected = pick;
}

// --- Hand-supplied notices -------------------------------------------------
//
// What's left is MIT/BSD-style: their text names the copyright holder, so no
// sibling package's copy will do. scripts/licenses-supplement holds the real
// upstream text for those, fetched once and checked in — see the README there.
const supplementDir = path.join(root, "scripts/licenses-supplement");
const supplement = JSON.parse(fs.readFileSync(path.join(supplementDir, "index.json"), "utf8"));
const usedSupplements = new Set();
const warnings = [];

for (const c of components) {
  const entry = supplement[c.name];
  if (!entry) continue;
  usedSupplements.add(c.name);
  // A package that relicenses invalidates the notice we stored for it, and that
  // has to be re-checked upstream by a human rather than papered over.
  if (entry.license !== c.license) {
    warnings.push(
      `${c.name} now declares "${c.license}" but its supplement was written for ` +
        `"${entry.license}" — re-check ${entry.source}`,
    );
  }
  if (!entry.file) {
    // No text exists upstream to reproduce; the note explains why.
    c.note = entry.note;
    continue;
  }
  const text = fs.readFileSync(path.join(supplementDir, entry.file), "utf8").trim();
  if (entry.mode === "append") {
    // The package ships one half of an "AND" license; add the other.
    if (c.text < 0) {
      warnings.push(`${c.name} supplement is mode "append" but the package ships no text`);
      continue;
    }
    c.text = intern(`${texts[c.text]}\n\n=== ${entry.appendLabel} ===\n\n${text}`);
  } else {
    if (c.text >= 0) {
      warnings.push(`${c.name} now ships its own license text — its supplement is redundant`);
      continue;
    }
    c.text = intern(text);
  }
}

for (const name of Object.keys(supplement)) {
  if (!usedSupplements.has(name)) {
    warnings.push(`supplement entry "${name}" matches no dependency — stale, remove it`);
  }
}

// --- The Rust standard library ---------------------------------------------
//
// std/core/alloc are statically linked into the binary and licensed Apache-2.0
// OR MIT, but they are not dependencies, so `cargo metadata` never mentions
// them — a blind spot every cargo-based license tool shares. The toolchain ships
// the notice for exactly this purpose: COPYRIGHT-library.html covers the library
// itself *and* the out-of-tree crates vendored into it, so it's both the
// authoritative text and more complete than anything we could assemble.
function htmlToText(html) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(p|div|tr|h[1-6]|ul|ol|br|pre|hr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(\w+);/g, (m, name) => entities[name] ?? m)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function rustStdComponent() {
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
  const version = /rustc (\S+)/.exec(
    execFileSync("rustc", ["--version"], { encoding: "utf8" }),
  )?.[1];
  const docs = path.join(sysroot, "share/doc/rust");
  const entry = {
    name: "Rust standard library",
    version: version ?? "unknown",
    ecosystem: "rust",
    license: "Apache-2.0 OR MIT",
    url: "https://github.com/rust-lang/rust",
    text: -1,
  };

  const copyright = path.join(docs, "COPYRIGHT-library.html");
  if (fs.existsSync(copyright)) {
    entry.text = intern(htmlToText(fs.readFileSync(copyright, "utf8")));
    return entry;
  }
  // Older toolchains ship no COPYRIGHT-library.html; fall back to the plain
  // license texts, which still carry the terms if not the contributor list.
  const parts = [];
  for (const name of ["Apache-2.0", "MIT"]) {
    const file = path.join(docs, "licenses", `${name}.txt`);
    if (fs.existsSync(file)) parts.push(`=== ${name} ===\n\n${fs.readFileSync(file, "utf8").trim()}`);
  }
  if (parts.length) {
    entry.text = intern(parts.join("\n\n"));
  } else {
    entry.note =
      "This Rust toolchain ships no copy of the standard library's license. " +
      "See https://github.com/rust-lang/rust for its Apache-2.0 and MIT terms.";
    warnings.push("no standard-library license text found in the Rust toolchain");
  }
  return entry;
}

components.push(rustStdComponent());
components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

// --- Nothing may ship unattributed -----------------------------------------
//
// A dependency with no license text and no explanation is a compliance hole, and
// a silent one is worse than a broken build — so this is fatal, not a warning.
const uncovered = components.filter((c) => c.text < 0 && !c.note);
if (uncovered.length) {
  console.error(
    `\nlicenses: ${uncovered.length} ${uncovered.length === 1 ? "dependency has" : "dependencies have"} ` +
      `no license text and no entry in ` +
      `scripts/licenses-supplement:\n` +
      uncovered.map((c) => `  ${c.name} ${c.version} [${c.license}]  ${c.url}`).join("\n") +
      `\n\nAdd the upstream text to scripts/licenses-supplement (see its README).\n`,
  );
  process.exit(1);
}

for (const w of warnings) console.warn(`licenses: warning: ${w}`);

const appManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const tauriConf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));

const out = {
  generated: new Date().toISOString().slice(0, 10),
  app: {
    name: tauriConf.productName,
    version: tauriConf.version,
    license: appManifest.license,
    text: intern(fs.readFileSync(path.join(root, "LICENSE"), "utf8")),
  },
  components,
  texts,
};

fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.writeFileSync(path.join(root, "public/licenses.json"), JSON.stringify(out));

const elected = components.filter((c) => c.elected).length;
const noted = components.filter((c) => c.note).length;
console.log(
  `licenses: ${components.length} components, ${texts.length} unique texts, ` +
    `${elected} shown under an elected license branch, ` +
    `${noted} with no notice published upstream, ` +
    `${(fs.statSync(path.join(root, "public/licenses.json")).size / 1024).toFixed(0)} KB`,
);
