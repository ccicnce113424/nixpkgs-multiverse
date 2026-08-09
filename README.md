# nixpkgs-multiverse

Every nixpkgs revision, reachable from a **single evaluation**. One flake input,
no juggling `nixpkgs` pinned at N commits.

![lotr meme "One flake to rule them all"](./multiverse_lotr.jpg)

```console
$ nix shell 'github:fzakaria/nixpkgs-multiverse#versions.python3."3.8.9"' -c python3 --version
Python 3.8.9
```

A 2021 Python on a 2026 machine, substituted from cache.nixos.org rather than
built.

![57 pythons from one flake input](./demos/multiverse.gif)

## Every CPython ever packaged, running at once

```console
$ nix build github:fzakaria/nixpkgs-multiverse#every-python && cat result
```

```
  VERSION   REVISION                   REPORTED                 COMPILER
  3.5.3     17.03                      linux-x86_64           GCC 5.4.0
  3.7.4     2019-10-20-f35f0880f2cd    linux-x86_64           GCC 8.3.0
  3.8.9     2021-07-18-967d40bec14b    linux-x86_64           GCC 10.3.0
  3.10.5    2022-08-15-af9e00071d09    linux-x86_64           GCC 11.3.0
  3.11.6    2024-01-08-317484b1ead8    linux-x86_64           GCC 12.3.0
  3.12.9    2025-05-04-979daf34c8ca    linux-x86_64           GCC 14.2.1 20250322
  3.14.6    2026-07-19-241313f4e8e5    linux-x86_64           GCC 15.2.0
  ----------------------------------------------------------------------------
  57 interpreters, 0 compiled
```

Each interpreter carries its own glibc, openssl and stdenv, and they execute
side by side in one build sandbox. The compiler column is nine years of GCC,
co-resident. Nothing is compiled — every one is the derivation Hydra built.

## What it indexes

| | |
|---|---|
| revisions known | **1,396** (2015-09-30 → 2026-07-19) |
| of those, labelled releases | 22 |
| revisions indexed | **1,393** (3 fail to evaluate) |
| attributes | 30,947 |
| (attr, version) pairs | 289,521 |
| `index/versions.json` | **5.18 MB** |

A release is just a commit with a nice name. `revisions.json` is one ordered
array; releases carry an extra `release` label, everything else is a
`nixos-unstable` channel bump.

## Usage

### Explore with `nix repl`

```console
$ nix repl
nix-repl> :lf github:fzakaria/nixpkgs-multiverse
nix-repl> multiverse.x86_64-linux.versionsOf "python3"
[ "3.5.3" "3.6.2" … "3.13.13" ]          # 57 versions

nix-repl> multiverse.x86_64-linux.revOf "python3" "3.8.9"
"2021-07-06-00c86ad14639"

nix-repl> multiverse.x86_64-linux.releases
[ "15.09" "16.03" … "26.05" ]
```

Enumerating versions fetches nothing — it reads the index only. A revision is
materialised the first time you force a derivation.

### The three ways in

| | what it gives you | consistent set? |
|---|---|---|
| `versions.<pkg>.<version>` | one exact version | n/a |
| `latest.<pkg>` | newest version of that package, ever | **no** |
| `tip` / `at <sel>` | a whole Nixpkgs | yes |

All three are plain attributes, so they work as flake installables:

```console
$ nix shell '.#versions.python3."3.8.9"' -c python3 --version
$ nix run   '.#latest.python3' -- --version
$ nix run   '.#tip.ripgrep' -- --version
```

### A specific version

`versions` is a lazy `{attr → {version → derivation}}` map. Its keys are only
ever real version strings.

```nix
mv.versions.python3."3.8.9"
mv.version "python3" "3.8.9"   # same thing, as a function
```

### The newest version of a package

```nix
mv.latest.python3
```

`latest` is an attrset of 30,947 derivations, but it is **not** a Nixpkgs and
its members are **not** mutually consistent. Each is the newest version of that
package from whichever revision last shipped it — `python3` from 2026, a package
Nixpkgs dropped in 2018 from 2018. Only 23,392 of the 30,947 attributes have
their newest version in a 2026 revision.

That is what makes it useful: it reaches packages Nixpkgs has since removed.
`mv.latest.relibc` resolves; `mv.tip.relibc` does not exist.

### A whole nixpkgs

`at` takes a release name, a date, or a commit prefix; `tip` is the newest
revision the index knows.

```nix
mv.at "24.11"          # release
mv.at "2022-03-15"     # newest revision on or before that date
mv.at "aae12a743f75"   # commit prefix
mv.tip                 # newest indexed revision
```

These are real Nixpkgs instances — `lib`, `callPackage`, an internally
consistent package set.

`tip` is the tip of the **index**, not of the channel. It is frozen at the last
indexing run and drifts behind `nixos-unstable` until the index is rebuilt. For
the live channel, add a `nixpkgs` input; multiverse is for reaching backwards.

### Querying without building anything

```nix
mv.versionsOf "python3"     # every known version, version-aware sort
mv.revOf "python3" "3.8.9"  # "2021-07-18-967d40bec14b"
mv.releases                 # [ "15.09" … "26.05" ]
mv.revs                     # every revision label, oldest first
mv.revisions                # the raw {rev, date, narHash} array
```

Use `versionsOf` rather than `builtins.attrNames mv.versions.<pkg>`: `attrNames`
sorts lexicographically, which puts `3.9.5` after `3.9.13`.

### Compose several versions at once

`tests/compose.nix`:

```nix
let
  mv = import ../. { };
  host = mv.at "25.05";                  # newest revision supplies the builder
  pythons = [
    (mv.version "python3" "3.10.11")
    (mv.version "python3" "3.11.9")
    (mv.version "python3" "3.12.10")
  ];
in
{
  env = host.buildEnv {
    name = "three-pythons";
    paths = pythons;
    ignoreCollisions = true;             # three Pythons all want bin/python3
  };
}
```

```console
$ nix-build tests/compose.nix -A env
created 52 symlinks in user environment
```

A 67-path, 507 MB closure. Exactly two derivations are built — the `buildEnv`
wrapper and its `builder.pl`; everything else substitutes. The closure holds
`bash-5.2-p15`, `bash-5.2p26` and `bash-5.2p37`, plus `glibc-2.37-8`,
`glibc-2.39-52` and `glibc-2.40-66` — three eras coexisting, because Nix keeps
the dependency graphs disjoint.

### As an input to your own flake

```nix
{
  inputs.multiverse.url = "github:fzakaria/nixpkgs-multiverse";
  outputs =
    { self, nixpkgs, multiverse }:
    let
      mv = multiverse.multiverse.x86_64-linux;
    in
    {
      devShells.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.mkShell {
        packages = [
          (mv.version "python3" "3.8.9")
          (mv.version "nodejs" "14.17.0")
        ];
      };
    };
}
```

### Without flakes

`default.nix` forwards to `multiverse.nix`. This is the one idiom flakes cannot
express, since a flake attribute path takes no arguments:

```console
$ nix shell --impure --expr '(import ./. {}).version "python3" "3.8.9"' -c python3 --version
```

## Why it works

Store paths derive from content and basename, never location or fetcher. A
revision fetched into the store produces byte-identical derivations to one
checked out at top level, so everything Hydra built stays a cache hit. Verified
three ways — a checked-out directory, `fetchGit` from a local clone, and
`fetchTree` from GitHub all yield the same `python3-3.12.10` store path.

Cache hits need the entire transitive closure to match — historical stdenv,
glibc, bootstrap-files, `lib/` — which is why whole revisions are fetched rather
than version/hash tables patched onto today's stdenv. The latter would produce
novel derivations with no cache coverage at all.

## The index

`index/versions.json` maps each (attribute, version) to the single newest
revision that shipped it, as an offset into `revisions.json`:

```json
{
  "revisionCount": 1396,
  "attrs": {
    "python3": { "3.8.9": 412, "3.12.10": 1204 }
  }
}
```

Storing one integer rather than every revision a version appeared in keeps the
file flat as revisions are added; otherwise a package that never changes version
accumulates an entry per revision. Measured across encodings at 109 revisions:

| encoding | size | grows with revision count? |
|---|---|---|
| full revision list, names | 63.9 MB | yes |
| `[first, last]`, offsets | 4.1 MB | no |
| newest only, offset | **3.3 MB** | no |

Newest is also the build-correct choice: the most patched build, and the one
Hydra produced most recently, so the most likely to still substitute.

Nix has no SQLite builtin — the only parsers are `fromJSON`, `fromTOML`,
`readFile` and `readDir` — so the eval-side index has to be JSON. History
questions ("which revisions *also* had this version") belong in tooling built
from `index/.per-rev`, not in a file parsed on every evaluation.

## Revisions are not flake inputs

`flake.nix` has `inputs = { }` on purpose. Flake inputs are fetched eagerly: a
flake with three nixpkgs inputs whose output referenced only the first still
materialised all three, ~378 MB each. At 1,396 revisions that does not work.

Revisions are fetched with `builtins.fetchTree`, pinned by `narHash`, only when
touched. Secondary reason: nixpkgs had no `flake.nix` before 20.03, so older
revisions cannot be flake inputs at all.

## Performance

| what | cpu | values |
|---|---|---|
| `versionsOf` — index only, 0 revisions | 0.30s | 175k |
| one version via `versions.…` | 0.46s | 700k |
| 1 revision | 0.37s | 758k |
| 3 revisions | 0.62s | 1.22M |
| 3 packages, all same revision | **0.29s** | 767k |

Cost is per revision touched, not per package — revisions are memoised, so three
packages from one revision cost the same as one. Each revision actually used
costs ~378 MB of store, fetched once.

## Building the index

```sh
tools/fetch-unstable-revisions.sh    # refresh revisions.json from the channel archive
tools/build-index.sh                 # extract versions + narHashes
tools/build-index.sh -n 30           # smoke test on the first 30
tools/build-index.sh --merge-only    # rebuild the index from cache, no evaluation
```

Each revision is checked out with `git archive` into a temp directory, never
into the nix store. Forcing `drv.version` does not copy a tree into the store,
so indexing costs one ~280 MB scratch directory at a time and no store growth.
The narHash is computed from the same checkout, so one pass produces both.
Extraction runs 2–34s per revision. The full set took 40 minutes of wall clock
on a 256-core machine at 64-way parallelism, peaking at 6 GB of scratch and
adding nothing to the nix store.

`index/.per-rev/` caches the raw `{attr: version}` output per revision, keyed by
revision and by a hash of `extract-versions.nix`, so editing the extractor
invalidates the cache instead of silently reusing stale results.

## Layout

```
multiverse.nix          the implementation
default.nix             forwards to multiverse.nix (non-flake entry point)
flake.nix               same API, no inputs
revisions.json          ordered array of every known revision
index/versions.json     {attr: {version: revision offset}}
tools/build-index.sh              extract versions and narHashes
tools/extract-versions.nix        per-revision extraction
tools/fetch-unstable-revisions.sh refresh revisions.json
tools/add-narhashes.sh            fill narHash for revisions that lack one
tests/compose.nix       three Pythons, three revisions, one derivation
demos/every-python.nix  the demo above
```

`fetcher = "github"` (default) uses `fetchTree` pinned by `narHash` — pure-eval
safe and portable. `fetcher = "local"` uses `fetchGit` against the clone at
`nixpkgsSource`: offline and faster when a clone exists, but an absolute path
outside the tree is rejected under pure evaluation.

## Known limits

- **1,393 of 1,396 revisions are indexed.** All 1,396 carry a narHash, so the
  GitHub fetcher works everywhere. The three gaps are 15.09, 16.03 and 16.09.
- **No attrpath rename tracking.** `python3` meant 3.5 in 17.03 and 3.13 today;
  packages get renamed, aliased, dropped and revived. The index will serve the
  wrong thing for those.
- Composition is safe for leaf applications and dev shells. Mixing two glibcs
  into a single linked program, or into a NixOS system closure, is not.

## License

MIT — see [LICENSE](LICENSE).

The Nix expressions and tooling are original work. `revisions.json` and
`index/versions.json` are generated metadata about nixpkgs — revisions, dates,
hashes and version strings — not nixpkgs source. nixpkgs itself is MIT and is
fetched at evaluation time.
