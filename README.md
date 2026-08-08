# nixpkgs-multiverse

Every nixpkgs revision, reachable from a **single evaluation**. One flake input,
no juggling `nixpkgs` pinned at N commits, no vendored trees.

## Every CPython ever packaged, running at once

```console
$ nix build github:fzakaria/nixpkgs-multiverse#every-python && cat result
```

```
  every CPython in nixpkgs, running at once
  ----------------------------------------------------------------------------
  VERSION   RELEASE  REPORTED                 COMPILER
  ----------------------------------------------------------------------------
  3.5.3     17.03    linux-x86_64           GCC 5.4.0
  3.6.2     17.09    linux-x86_64           GCC 6.4.0
  3.6.4     18.03    linux-x86_64           GCC 7.3.0
  3.6.6     18.09    linux-x86_64           GCC 7.3.0
  3.7.3     19.03    linux-x86_64           GCC 7.4.0
  3.7.4     19.09    linux-x86_64           GCC 8.3.0
  3.7.6     20.03    linux-x86_64           GCC 9.2.0
  3.8.5     20.09    linux-x86_64           GCC 9.3.0
  3.8.9     21.05    linux-x86_64           GCC 10.3.0
  3.9.6     21.11    linux-x86_64           GCC 10.3.0
  3.9.12    22.05    linux-x86_64           GCC 11.3.0
  3.10.8    22.11    linux-x86_64           GCC 11.3.0
  3.10.11   23.05    linux-x86_64           GCC 12.2.0
  3.11.6    23.11    linux-x86_64           GCC 12.3.0
  3.11.9    24.05    linux-x86_64           GCC 13.2.0
  3.12.7    24.11    linux-x86_64           GCC 13.3.0
  3.12.10   25.05    linux-x86_64           GCC 14.2.1 20250322
  3.13.9    25.11    linux-x86_64           GCC 14.3.0
  3.13.13   26.05    linux-x86_64           GCC 15.2.0
  ----------------------------------------------------------------------------
  19 interpreters, 0 compiled
```

Nineteen CPython interpreters spanning 2017 to 2026, each carrying its own
glibc, openssl and stdenv, **executing inside one build sandbox**. Look at the
compiler column: nine years of GCC, 5.4.0 through 15.2.0, co-resident. Nothing
was compiled — every interpreter is the exact derivation Hydra built at its
release, substituted from cache.nixos.org.

> This demo materialises 19 revisions, ~378 MB of store each (~7 GB). Ordinary
> use touches one or two.

---

## What it indexes

**22 NixOS releases, 17.03 → 26.05** (~9 years): 30,122 attributes, 117,927
distinct (attr, version) pairs. The repo is **12 MB** — revisions are fetched
lazily and only when touched.

```console
$ nix shell 'github:fzakaria/nixpkgs-multiverse#versions.python3."3.8.9"' -c python3 --version
Python 3.8.9
```

A 2021 Python running on a 2026 machine, substituted rather than built.

## Usage

### Explore with `nix repl`

```console
$ nix repl
nix-repl> :lf github:fzakaria/nixpkgs-multiverse
Added 12 variables.

nix-repl> multiverse.x86_64-linux.versionsOf "ripgrep"
[ "0.4.0" "0.6.0" "0.8.1" "0.9.0" "0.10.0" "11.0.2" "12.1.1" "13.0.0"
  "14.1.0" "14.1.1" "15.1.0" ]

nix-repl> multiverse.x86_64-linux.revsFor "python3" "3.8.9"
[ "21.05" ]

nix-repl> multiverse.x86_64-linux.revisions."21.05"
{ date = "2021-05-31";
  narHash = "sha256-ZjBd81a6J3TwtlBr3rHsZspYUwT9OdhDk+a/SgSEf7I=";
  rev = "fefb0df7d2ab2e1cabde7312238026dcdc972441"; }

# A whole nixpkgs as it was at a release:
nix-repl> (multiverse.x86_64-linux.at "24.11").hello.version
"2.12.1"

nix-repl> multiverse.x86_64-linux.latest "jq"
«derivation /nix/store/hvdnz13lnsmi1h7hd5clvr10b910a35k-jq-1.8.1.drv»
```

Enumerating versions fetches **nothing** — it reads the index only, in ~0.3s.
A revision is materialised the first time you force a derivation.

### Use a specific version

`versions` is a lazy `{attr → {version → derivation}}` map, so ordinary flake
installable syntax works:

```console
$ nix shell '.#versions.python3."3.8.9"' -c python3 --version
Python 3.8.9

$ nix build '.#versions.jq."1.6"' --print-out-paths
/nix/store/s9j08pc615ii5z8rln2yjarsc9zf7q04-jq-1.6-bin
/nix/store/xy88xh5axf0j1d5mc4dy4fzf3gw1pphl-jq-1.6-man
```

### Query from the command line

```console
$ nix eval --json --apply 'f: f "gcc"' .#multiverse.x86_64-linux.versionsOf
["5.4.0","6.4.0","7.3.0","7.4.0","8.3.0","9.2.0","9.3.0","10.3.0","11.3.0",
 "12.2.0","12.3.0","13.2.0","13.3.0","14.2.1.20250322","14.3.0","15.2.0"]
```

### Compose several versions at once

`tests/compose.nix` — the thing multi-input flakes make painful and
commit-indexing cannot do at all:

```nix
let
  mega = import ../. { };
  host = mega.at "25.05";              # newest revision supplies the builder
  pythons = [
    (mega.version "python3" "3.10.11")   # from 23.05
    (mega.version "python3" "3.11.9")    # from 24.05
    (mega.version "python3" "3.12.10")   # from 25.05
  ];
in {
  inherit pythons;
  env = host.buildEnv {
    name = "three-pythons";
    paths = pythons;
    ignoreCollisions = true;           # three Pythons all want bin/python3
  };
}
```

```console
$ nix-build tests/compose.nix -A env
created 52 symlinks in user environment
/nix/store/23y3ahp4iq0marbk6lp8d3953pkbd3kb-three-pythons
```

**89 paths fetched from cache, 2 built** (just the env wrapper). The fetch list
contains `bash-5.2-p15`, `bash-5.2p26` and `bash-5.2p37` — three eras of bash
coexisting, because Nix keeps the dependency graphs disjoint.

### As an input to your own flake

```nix
{
  inputs.multiverse.url = "github:fzakaria/nixpkgs-multiverse";
  outputs = { self, nixpkgs, multiverse }: let
    mega = multiverse.multiverse.x86_64-linux;
  in {
    devShells.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.mkShell {
      packages = [ (mega.version "python3" "3.8.9") (mega.version "nodejs" "14.17.0") ];
    };
  };
}
```

### Without flakes

`default.nix` forwards to `multiverse.nix`. This is the one idiom flakes cannot
express, since a flake attribute path cannot take arguments:

```console
$ nix shell --impure --expr '(import ./. {}).version "python3" "3.8.9"' -c python3 --version
Python 3.8.9
```

## Versions are deduplicated, and that is lossy

The index is `{attr: {version: [rev, ...]}}`, so a version appearing in several
releases is **one key with several revisions**. 43,892 of 117,927 pairs (37%)
span more than one release; some packages carry the same version across all 19.

But the same version string is **not the same derivation**. `aalib` is 1.4rc5 in
every release, and every release builds it differently:

```
17.03  /nix/store/blqvzyb6d8hywa5jw4znkwq319xlgaq2-aalib-1.4rc5-bin
20.09  /nix/store/ig6l8y6sxvik98w5l3cnq798j8msdb94-aalib-1.4rc5-bin
23.05  /nix/store/jjq9vl67kh6wsgnzjdwmr8bl17h25fmq-aalib-1.4rc5-bin
26.05  /nix/store/czc992lykj1rg010jyd9lzxfrzg9i5gg-aalib-1.4rc5-bin
```

`version "aalib" "1.4rc5"` returns the **newest** (26.05) — most patched, most
likely to still be cached. The others stay reachable:

```nix
mega.revsFor "aalib" "1.4rc5"     # [ "17.03" … "26.05" ]
(mega.at "17.03").aalib           # the 2017 build specifically
```

## Why it works

Store paths derive from **content and basename, never location or fetcher**. A
revision fetched into the store produces byte-identical derivations to one
checked out at top level, so everything Hydra built stays a cache hit. Verified
three ways — a checked-out directory, `fetchGit` from a local clone, and
`fetchTree` from GitHub all yield the same `python3-3.12.10` store path.

Cache hits require the *entire transitive closure* to match — historical stdenv,
glibc, bootstrap-files, `lib/` — which is why whole revisions are fetched rather
than version/hash tables patched onto today's stdenv. The latter produces novel
derivations with zero cache coverage.

## Do NOT declare revisions as flake inputs

This is why `flake.nix` has `inputs = { }`.

**Flake inputs are fetched eagerly.** Measured: a flake with three nixpkgs
inputs whose output referenced only the *first* still materialised all three.
At 22 revisions that is ~8 GB fetched before any evaluation can begin, growing
linearly with every revision added.

Revisions are instead fetched via `builtins.fetchTree`, pinned by `narHash`,
only when touched. That is what lets the revision count grow without bound.

Secondary reason: **nixpkgs had no `flake.nix` before 20.03**, so 15.09–19.09
cannot be flake inputs at all. They work fine via `import (fetchTree …)`.

## Measurements

**Cache retention goes back at least to 2015.** `hello` from 15.09, 17.03,
18.09, 19.09, 20.09, 21.11 and 22.11 all still substitute.

**Evaluation scales with revisions touched, not packages:**

| what | cpu | values |
|---|---|---|
| `versionsOf` — index only, 0 revisions | 0.30s | 175k |
| one version via `versions.…` | 0.46s | 700k |
| 1 revision | 0.37s | 758k |
| 3 revisions | 0.62s | 1.22M |
| 5 revisions | 1.66s | 3.29M |
| **3 packages, all same revision** | **0.29s** | **767k** |

Revisions are memoised, so three packages from one revision cost the same as
one. Cost per revision actually used: ~378 MB of store, fetched once.

**Index generation** is 2–34s per revision for *every* top-level attribute,
because extracting a version forces `drv.version` and not the build graph.
Indexing all ~2000 channel bumps would be ~4.5 CPU-hours.

## Layout

```
multiverse.nix            the implementation
default.nix             forwards to multiverse.nix (non-flake entry point)
flake.nix               same API, deliberately no inputs
revisions.json          {name: {rev, date, narHash}} — what exists
index/versions.json     {attr: {version: [rev, ...]}} — read lazily
tools/build-index.sh    regenerate index/versions.json
tools/extract-versions.nix   per-revision version extraction
tools/add-narhashes.sh  populate narHash in revisions.json
tests/compose.nix       three Pythons, three revisions, one derivation
demos/every-python.nix  the demo above
```

`fetcher = "github"` (default) uses `fetchTree` pinned by `narHash` — pure-eval
safe and portable. `fetcher = "local"` uses `fetchGit` against a clone set by
`nixpkgsSource`: offline and faster when a clone exists, but an absolute path
outside the tree is rejected under pure evaluation. Both produce identical
derivations. Index generation uses `local`, since it needs every revision.

## Known limits

- **Release granularity is not "every version that ever existed."** A version
  that lived between two releases is invisible. Channel bumps (~2000 over 12
  years) are the principled next step: they are exactly what Hydra built, so
  they are exactly what has substitutes.
- **No attrpath rename tracking.** `python3` meant 3.5 in 17.03 and 3.13 today;
  packages get renamed, aliased, dropped and revived. The index will silently
  serve the wrong thing for those.
- **15.09/16.03/16.09 fail to evaluate** on Nix 2.34, so the index starts at
  17.03 even though `revisions.json` lists them.
- Composition is safe for leaf applications and dev shells. Mixing two glibcs
  into a single linked program, or into a NixOS system closure, is not.
