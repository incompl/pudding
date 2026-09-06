# License supplement

License text for dependencies that declare a license but ship no copy of it.

Some crates keep their `LICENSE` at a workspace root that `cargo package` never
includes, so the file is missing from what we actually build against. Where the
license text is invariant (Apache-2.0, MPL-2.0, …) `gen-licenses.mjs` recovers it
from a sibling package automatically and nothing is needed here. What lands in
this directory is the rest: MIT- and BSD-style licenses, whose text carries the
copyright holder's own name and therefore cannot be borrowed from anyone else.

Each file is the upstream license **verbatim**, fetched once from the URL
recorded in `index.json`. Never write one by hand and never infer a copyright
line from a manifest's `authors` field — that invents a notice rather than
reproducing one.

`index.json` maps a package name to:

| key           | meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `license`     | the SPDX expression this entry was written against. The generator warns if the package's declared license later changes — that means re-checking upstream. |
| `file`        | the text file in this directory. Omit for a package that genuinely publishes no notice; supply `note` instead. |
| `mode`        | `replace` (default) or `append`, to add a license the package ships only part of. |
| `appendLabel` | heading for the appended text, in `append` mode.                  |
| `source`      | where the text came from, so the next person can re-verify it.    |
| `note`        | shown in place of a license text, for packages that publish none. |

The build **fails** when a package has no license text and no entry here, so a
new dependency in this situation cannot slip through unnoticed.
