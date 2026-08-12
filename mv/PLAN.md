# `mv` — implementation plan

A Rust CLI for reading the multiverse index: versions, lifetimes, revision
selection, constraint solving, and per-package pins.

## Scope

**In:** a consumer tool. Read-only, offline, no network. Everything it answers
comes from a database baked into its own store path at build time.

**Out:**

- *Growing* the index. `tools/*.sh` keep that job — `fetch-unstable-revisions`,
  `fetch-releases`, `build-index`, `build-history`, `build-stats`,
  `add-narhashes`, `update-readme-status` are unchanged and CI keeps calling
  them.
- Downloading anything. The data version *is* the flake version: a newer index
  arrives through `nix flake update multiverse`, which rebuilds the database
  derivation and rewraps the binary. A separate download path would be a second
  source of truth that drifts from the pinned input, and two people running the
  same `nix run` would get different answers.
- `bisect`. Wanted, but it is the only command needing a build/eval loop and it
  blocks nothing. It slots in cleanly later.
- `init` / `use`. Writing `flake.nix` and `.envrc` files is where the edge cases
  live (existing flake, clobbering, `.envrc` conventions) for very little gain
  over `solve` printing a snippet you can redirect.

One property falls out of being offline that is worth stating plainly: **a pin
can never point past what the index knows.** Materialising a revision needs its
narHash, and `mv` only has the ones in its baked database. So the workflow is
honestly two-step, which is exactly the two-layer state issue #4 asks for:

```console
$ nix flake update multiverse    # learn about newer revisions
$ mv lock update helix           # move this one package
```

## Command surface

### `mv query` — everything read-only

| command | answers |
|---|---|
| `mv query versions <attr>` | every version, oldest first, with its lifetime |
| `mv query when <attr> <ver>` | first and last sighting, every run, gaps |
| `mv query at <sel> <attr>` | the version that revision shipped |
| `mv query gone <attr>` | last sighting, or still current |
| `mv query rev <sel>` | resolve any selector to commit / date / label |
| `mv query search <pattern>` | attribute search |
| `mv query diff <a> <b>` | added / removed / upgraded / downgraded |
| `mv query stats` | headline numbers |

A *selector* is whatever `at` accepts: `tip`, a release (`26.05`), a date
(`2022-03-15`), a commit prefix, or a revision label.

`--json` on every subcommand; human-readable tables otherwise.

`query at` deserves emphasis: it answers "what version did nixpkgs have on this
date" from the index alone, where the Nix API has to materialise the whole
~378 MB revision to read one `.version`.

### `mv solve`

Find a single revision satisfying several constraints at once.

```console
$ mv solve python3@3.8 nodejs@14
110 revisions · 2020-11-21 .. 2021-07-18
newest: 967d40bec14b (2021-07-18)

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/967d40bec14be87262b21ab901dbace23b7365db";

$ mv solve python3@3.6 ripgrep@14
no revision ever had both
  python3 3.6.x  ended 2019-04-08
  ripgrep 14.x   began 2024-01-06
```

This is the answer to multiverse's one real weakness. Composing versions from
*different* revisions gives closures with mismatched libc and openssl — fine for
a leaf CLI, wrong for anything that links. `solve` inverts the question: one
revision, one stdenv, internally consistent.

Proving unsatisfiability *and saying why* is the part no other tool does; mise
and asdf cannot, because they do not model compatibility at all.

Verified against the current index: intersecting the run ranges for `python3
3.8.x` (160 revisions) and `nodejs 14.x` (197 revisions) yields 110 revisions in
well under a millisecond, and the deliberately impossible pair correctly returns
empty.

### `mv lock` — per-package pins (issue #4)

```
mv lock add <attr>[@ver]        mv lock update [<attr> | --all]
mv lock rm <attr>               mv lock status
mv lock list
```

`multiverse.lock`:

```json
{
  "version": 1,
  "pins": {
    "helix": {
      "rev": "2fcb964de67fcf60b43471c55d5d99e61a9ccb5a",
      "label": "2026-08-10-2fcb964de67f",
      "version": "25.01",
      "date": "2026-08-10"
    }
  }
}
```

`mv lock update helix` finds the newest indexed revision providing helix and
rewrites **only** that entry. Every other pin stays exactly where it was.

`mv lock status` is where the history index earns its place — "helix is 3
versions and 47 days behind" with no fetching.

Nix side gains `multiverse.lib.readLock ./multiverse.lock`, returning
`{ <attr> = <derivation>; }`, and `modules/multiverse.nix` gains a
`multiverse.lock` option beside `pins`.

### `mv run` / `mv shell`

Thin wrappers over `nix run` / `nix shell` that take `attr@version` and resolve
it through the index.

Deliberately scoped to leaf tools. `mv shell ripgrep@13.0.0 fd@8.7.0` composes
across revisions, which is right for standalone binaries and wrong for a
development environment — for that, `solve` gives you one coherent revision.

## Data

The JSON files stay canonical and committed. `multiverse.nix` reads them and the
offset invariant depends on them; that contract does not move.

`multiverse.db` is **derived at build time and never committed** — it is binary,
would change hourly, and committing it would bloat the repository's history for
no benefit. The same derivation output doubles as the artifact for anyone who
wants to run SQL over 13 years of nixpkgs (`nix build .#index-db`).

```
revisions.json ─┐
versions.json  ─┼──▶ derivation ──▶ multiverse.db ──▶ mv (MV_DB=<store path>)
history.json   ─┘
```

Database resolution is deliberately trivial: `--db <path>` for development,
otherwise `$MV_DB`, which the wrapper always sets. No cache directory, no
fallback chain, no network.

### Schema

One row per **run**, which makes the interesting queries pure SQL:

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);      -- revisionCount, built_from

CREATE TABLE revisions(
  off     INTEGER PRIMARY KEY,   -- offset into revisions.json; the join key everywhere
  rev     TEXT NOT NULL,
  date    TEXT NOT NULL,
  name    TEXT,
  narhash TEXT
);
CREATE INDEX revisions_rev  ON revisions(rev);
CREATE INDEX revisions_date ON revisions(date);

CREATE TABLE releases(name TEXT PRIMARY KEY, rev TEXT, date TEXT, build INTEGER, channel_name TEXT);

CREATE TABLE attrs(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);   -- ~31,800

CREATE TABLE runs(                                                        -- ~331,000
  attr_id INTEGER NOT NULL REFERENCES attrs(id),
  version TEXT NOT NULL,
  first   INTEGER NOT NULL,
  last    INTEGER NOT NULL
);
CREATE INDEX runs_attr ON runs(attr_id);
CREATE INDEX runs_span ON runs(first, last);
```

`attrs` is normalised on purpose — repeating each attribute name once per run
would be most of the file. **Measure the built database against the 13 MB of
JSON before settling on this.** If it lands much larger, fall back to one packed
blob of runs per attribute and decode in Rust.

Why runs rather than `(attr, version) → newest offset`: 8.4% of pairs are
non-contiguous — they left nixpkgs and came back. `R` and `OVMF` swing their
default version regularly, and a reverted bump does it for a single revision.
Collapsing that loses the ability to answer `at`, `solve`, and `diff` correctly.

Sketch of `solve`, one `EXISTS` per constraint:

```sql
SELECT r.off, r.rev, r.date FROM revisions r
WHERE EXISTS (SELECT 1 FROM runs JOIN attrs ON attrs.id = runs.attr_id
              WHERE attrs.name = ?1 AND runs.version GLOB ?2
                AND r.off BETWEEN runs.first AND runs.last)
  AND EXISTS (...)
ORDER BY r.off DESC;
```

## The one real correctness risk

Nixpkgs versions are not semver. Real examples from the index:
`0-unstable-2026-06-17`, `202502`, `2.7.18.12`, `1.12-nightly`, `20250512.1`.

`mv` must order them exactly as `builtins.compareVersions` does — split into
runs of digits and non-digits, compare digit runs numerically — or
`query versions`, `solve` and `lock status` all quietly disagree with Nix.

This gets its own module and a **differential test**: sample a few thousand real
pairs out of the index, compare `mv`'s ordering against
`nix eval --expr 'builtins.compareVersions ...'`, and fail on any mismatch. It
is the cheapest bug to prevent and the most likely to be subtly wrong.

## Packaging

Single crate at `mv/`. Built by `rustPlatform.buildRustPackage` from
`pkgsFor system` — itself a multiverse revision — so `inputs = { }` stays
intact. `Cargo.lock` committed for `cargoLock.lockFile`.

```nix
packages.mv        # wrapped with MV_DB=${indexDb}
packages.index-db  # the database on its own
apps.mv
```

Consequence to accept: `nix run .#mv` rebuilds the database whenever the index
changes. That is a few seconds of derivation on a cold cache, in exchange for
never shipping a stale or drifting copy.

## Crates

`clap` (derive) · `rusqlite` (bundled) · `anyhow` · `owo-colors` + `anstream` ·
`jiff` · `tabled` or hand-rolled table output.

No `serde_json` on the query path — the database replaces it. No `ureq`, no
`directories`; there is nothing to download and nothing to cache.

## Phasing

1. **Foundation.** Crate skeleton, the `index-db` derivation and schema, the
   version comparator, and the differential test against
   `builtins.compareVersions`. Nothing above this is trustworthy until ordering
   matches Nix exactly.
2. **`mv query`.** All subcommands with `--json`. Immediately replaces the
   `nix eval --apply` gymnastics the README currently documents.
3. **`mv solve`.** The command that justifies a binary existing.
4. **`mv lock`**, plus Nix-side `readLock` and the module option. Closes
   issue #4.
5. **`mv run` / `mv shell`.**

Steps 1–2 are a useful tool on their own; every step after ships independently.

## Open questions

- **Database size.** Unmeasured. Do this first; it decides whether the
  normalised-rows schema survives.
- **`GLOB` versus explicit range constraints.** `python3@3.8` is a prefix match
  today. Whether `>=`/`<` constraints are worth supporting depends on whether
  prefix matching turns out to be limiting in practice — worth deferring until
  `solve` has real use.
- **Sorting in SQL or in Rust.** SQLite cannot sort by Nix version ordering, so
  anything version-ordered must be sorted in Rust after the query. Fine at these
  sizes (62 versions for `python3`), but it rules out `ORDER BY version` and
  `LIMIT` pushdown.
