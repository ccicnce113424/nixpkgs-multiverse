# nixpkgs-multiverse

> Please read this [blog post](https://fzakaria.com/2026/08/09/nixpkgs-multiverse-every-version-that-ever-existed) for context.

Every nixpkgs revision, reachable from a **single evaluation**. One flake input, no juggling `nixpkgs` pinned at N commits.

The whole index is browsable at **<https://nixmultiverse.com/>**

Search any attribute for every version it ever shipped, with copy-paste run
and pin commands, plus the full revision and release tables.


![lotr meme "One flake to rule them all"](./multiverse_lotr.jpg)

**Jump to:** [Usage](#usage) ·
[Version history](#version-history) ·
[Unfree packages](#unfree-packages-and-nixpkgs-config) ·
[The `mvs` CLI](#the-mvs-cli) ·
[NixOS / home-manager module](#the-nixos-and-home-manager-module) ·
[Replacing nixpkgs inputs](#replacing-several-nixpkgs-inputs) ·
[Building the index](#building-the-index)

## Status

![github master branch workflow](https://github.com/fzakaria/nixpkgs-multiverse/actions/workflows/update-index.yml/badge.svg?branch=main)
![ci workflow](https://github.com/fzakaria/nixpkgs-multiverse/actions/workflows/ci.yml/badge.svg?branch=main)

<!-- BEGIN index-status -->
- **304,758 package versions** across **31,798 attributes**, from **1,538 revisions**
- 2013-10-31 → 2026-08-10, newest [`2fcb964de67f`](https://github.com/NixOS/nixpkgs/commit/2fcb964de67fcf60b43471c55d5d99e61a9ccb5a) · [`nixos-26.11pre1051473`](https://nix-releases.s3.amazonaws.com/nixos/unstable/nixos-26.11pre1051473.2fcb964de67f/)
<!-- END index-status -->

## Usage

Access every version of every package ever packaged in nixpkgs, from 2013 to 2026 as an installable.

```console
$ nix run 'github:fzakaria/nixpkgs-multiverse#versions.python3."3.6.2"' -- --version
Python 3.6.2

$ nix run 'github:fzakaria/nixpkgs-multiverse#versions.python3."3.8.9"' -- --version
Python 3.8.9

# We can also get the latest version of a package.
$ nix run 'github:fzakaria/nixpkgs-multiverse#latest.python3' -- --version
Python 3.14.6
```

You can access also a package by its revision, which is a commit hash, a 12-character prefix, a `date-commit` label, the release version or tip.

```console
# the newest indexed revision
$ nix run github:fzakaria/nixpkgs-multiverse#tip.hello

# a release channel, by major.minor
$ nix run github:fzakaria/nixpkgs-multiverse#26.05.hello

# a revision by label, exactly as revOf returns it
$ nix eval github:fzakaria/nixpkgs-multiverse#2021-07-18-967d40bec14b.python3.version
"3.8.9"

# the same revision by commit, a 12-character prefix or the full hash
$ nix shell github:fzakaria/nixpkgs-multiverse#967d40bec14b.python3
$ nix shell github:fzakaria/nixpkgs-multiverse#967d40bec14be87262b21ab901dbace23b7365db.python3
```

Query the flake for all the versions of a package that **ever existed in Nixpkgs**.

```console
$ nix eval --json --apply 'f: f "python3"' \
   github:fzakaria/nixpkgs-multiverse#multiverse.x86_64-linux.versionsOf
[
  "3.3.2",
  "3.4.3",
  # 58 other versions omitted for brevity
  # ...
  "3.13.13",
  "3.14.6"
]
```

The same question, and every other one below, is a subcommand of
[`mvs`](#the-mvs-cli) — `mvs query versions python3` — which answers it out of a
baked database rather than an evaluation.

Create a specific complete revision of Nixpkgs using the `at` function.

```nix
let
  mv = multiverse.multiverse.x86_64-linux;
  # newest revision the index knows, as a real Nixpkgs
  pkgs_tip = mv.tip;
  # by release — the channel as it stands today, backports included
  pkgs_24_11 = mv.at "24.11";
  # newest revision on or before that date
  pkgs_2022_03_15 = mv.at "2022-03-15";
  # by commit
  pkgs_aae12a743f75 = mv.at "aae12a743f75";
in {
  packages = [
      pkgs_tip.python3
      pkgs_24_11.python3
      pkgs_2022_03_15.python3
      pkgs_aae12a743f75.python3
    ];
}
```

Explore more with `nix repl`

```console
$ nix repl
nix-repl> :lf github:fzakaria/nixpkgs-multiverse
nix-repl> multiverse.x86_64-linux.versionsOf "python3"
[ "3.3.2" "3.4.3" … "3.14.6" ]           # 62 versions

nix-repl> multiverse.x86_64-linux.revOf "python3" "3.8.9"
"2021-07-18-967d40bec14b"

nix-repl> multiverse.x86_64-linux.releases
[ "13.10" "14.04" … "26.05" ]
```


**Note**: Enumerating versions fetches nothing as it reads an index file only. A revision is materialised the first time you force a derivation.

### A soak period

`daysBehind` gives you the whole of nixos-unstable as it stood some number of
days before an anchor, a cooldown window similar to [Determinate Systems Cooldown](https://determinate.systems/blog/nixpkgs-cooldown/#reducing-the-risk-with-cooldowns).

The anchor is any selector `at` takes:

```nix
# a week behind the newest indexed revision
mv.daysBehind "tip" 7
# a week before the 26.05 channel tip
mv.daysBehind "26.05" 7
# a week before that date
mv.daysBehind "2026-05-30" 7
# a month before that commit landed
mv.daysBehind "aae12a743f75" 30
```

```console
nix-repl> (mv.daysBehind "tip" 7).hello.version
"2.12.3"
nix-repl> (mv.daysBehind "tip" 365).hello.version
"2.12.2"
```

A selector resolves to a date out of `revisions.json` or `releases.json`. Only the revision you asked for is ever fetched (i.e. `"26.05"` does not materialise 26.05).

Note: Days behind a release revision walk back on unstable, not the release branch.

### Provenance

Every set from the multiverse is tagged with its origin:

```console
nix-repl> (mv.at "2022-03-15").multiverse
{ date = "2022-03-14"; label = "2022-03-14-73ad5f9e147c";
  rev = "73ad5f9e147c0d2a2061f1d4bd91e05078dc0b58"; }

nix-repl> (mv.at "26.05").multiverse
{ build = 7376; date = "2026-08-09"; name = "nixos-26.05.7376.fcb8fcd6bf2d";
  release = "26.05"; rev = "fcb8fcd6bf2d0adecae5bd491afaaaf8311b758d"; }
```

### Releases move, revisions do not

`at "26.05"` is a *channel*, not a snapshot. Backports land on `release-26.05` for the whole life of the release, and `at` follows them, exactly as `github:NixOS/nixpkgs/nixos-26.05` does:

```console
# the channel tip, refreshed hourly
nix-repl> (mv.at "26.05").frankenphp.version
"1.12.6"

# the release commit, fixed forever
nix-repl> (mv.at "2026-05-30").frankenphp.version
"1.12.3"
```

If you need a result that cannot drift, select by **date or commit**. 

Releases live in their own file, `releases.json`, keyed by name
and indexed by nothing:

```console
nix-repl> multiverse.x86_64-linux.releaseTips."26.05"
{ build = 7273; date = "2026-08-08";
  name = "nixos-26.05.7273.8b8c811c7c25";
  rev = "8b8c811c7c2541c30382c5de7ed26be055569c60"; }
```

Each one is the highest-numbered published bump of that channel in the [nix-releases archive](https://nix-releases.s3.amazonaws.com/), so it exists in the [cache.nixos.org](https://cache.nixos.org) as well. Betas are skipped, so a release appears only once it has shipped.

All 25 releases the archive holds are tracked, back to `13.10`:

```console
nix-repl> (mv.at "13.10").hello.name
"hello-2.8"
```


Query the underlying revision data.

```nix
# every known version, version-aware sort
mv.versionsOf "python3"
# every known revision that shipped a version
mv.revOf "python3" "3.8.9"
# unstable as it stood N days before any anchor
mv.daysBehind "tip" 7
# a revision as the flake attrset `inputs.nixpkgs` would have been
mv.flakeAt "26.05"
# where a package set came from
(mv.at "26.05").multiverse
# every release channel tracked, oldest first
mv.releases
# the release table: what commit each channel is at, and when
mv.releaseTips
# every revision label, oldest first
mv.revs
# the raw {rev, date, channel, narHash, name} array
mv.revisions
```

### Version history

`index/versions.json` records only the newest revision that shipped each
version, which is all `version` and `versionsOf` need. `index/history.json`
records **when each version was present**, as ranges of revisions: a
lifetime, a removal, or "what did nixpkgs have on this date" is answerable
without fetching anything.

```console
nix-repl> mv.lifetimeOf "python3" "3.8.9"
{ earliest = "2021-04-26"; latest = "2021-07-18";
  earliestLabel = "2021-04-26-8e4fe32876ca"; latestLabel = "2021-07-18-967d40bec14b";
  runs = [ { first = "2021-04-26"; last = "2021-07-18"; … } ]; }

# what an attribute had at a revision — no fetch, where reading
# (mv.at "2022-03-15").python3.version materialises the whole revision
nix-repl> mv.versionAt "python3" "2022-03-15"
"3.9.10"

# when something left nixpkgs; null while it is still here
nix-repl> mv.goneSince "python2"
{ date = "2026-05-30"; label = "2026-05-30-76b7bc982574"; version = "2.7.18.12"; }

# every version of a package with its lifetime, oldest first
nix-repl> mv.historyOf "ripgrep"
```

The label `goneSince` hands back is a selector, so it feeds straight into `at`
to get a working derivation out of the last revision that had the package:

```nix
(mv.at (mv.goneSince "python2").label).python2
```

**A version is not always present the whole time.**
A version may have been upgraded and then downgraded, or removed and later re-added several times.

- `earliest` / `latest` are the **outer bounds of every sighting**.
- `runs` are the **unbroken stretches**.

As an input to your own flake

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

### Unfree packages and nixpkgs `config`

A multiverse revision is an ordinary nixpkgs import, so unfree packages need
`allowUnfree`. The `multiverse.<system>` flake output is built with an
empty `config`:

`lib.mkMultiverse` is the same API with `config` and `overlays` threaded
through to every revision it hands out:

```nix
{
  inputs.nix-vscode-extensions.url = "github:nix-community/nix-vscode-extensions";
  inputs.multiverse.url = "github:fzakaria/nixpkgs-multiverse";
  outputs =
    { nix-vscode-extensions, multiverse, ... }:
    let
      system = "x86_64-linux";
      mv = multiverse.lib.mkMultiverse {
        inherit system;
        config.allowUnfree = true;
        overlays = [ inputs.nix-vscode-extensions.overlays.default ];
      };
    in
    {
      packages.${system}.code = mv.version "vscode" "1.107.0";
    };
}
```

`mv.tip`, `mv.at`, `mv.version`, `mv.versions` and `mv.latest` all carry that
config.

## The `mvs` CLI

Everything above is an evaluation. `mvs` answers the same questions as a
program — offline, in milliseconds, out of a SQLite database baked into its own
store path at build time.

```console
$ nix run github:fzakaria/nixpkgs-multiverse#mvs -- query versions python3
python3 · 62 versions · 2013-10-31 .. 2026-08-10
VERSION  FIRST       LAST        REVS
3.3.2    2013-10-31  2013-10-31  1
3.4.3    2015-09-30  2015-09-30  1
…
3.13.13  2026-05-21  2026-07-05  12
3.14.6   2026-07-08  current     17
```

The data version *is* the flake version. A newer index arrives through
`nix flake update multiverse`, which rebuilds the database derivation and
rewraps the binary — there is no download path, no cache directory, and nothing
that can drift from the pinned input. Two people running the same `nix run` get
the same answers.

`--json` works on every subcommand.

### Reading the index — `mvs query`

| command | answers |
|---|---|
| `mvs query versions <attr>` | every version, oldest first, with its lifetime |
| `mvs query when <attr> <ver>` | first and last sighting, every run, the gaps |
| `mvs query at <sel> <attr>` | the version that revision shipped |
| `mvs query gone <attr>` | last sighting, or still current |
| `mvs query rev <sel>` | resolve any selector to commit, date and label |
| `mvs query search <pattern>` | attribute search |
| `mvs query diff <a> <b>` | added / removed / upgraded / downgraded |
| `mvs query stats` | headline numbers |

A *selector* is the same vocabulary `at` takes: `tip`, a release (`26.05`), a
date (`2022-03-15`), a commit prefix, or a revision label.

`query at` is the one that cannot be done any other way. It says what nixpkgs
had on a date without materialising anything, where reading
`(mv.at "2022-03-15").python3.version` fetches the whole ~378 MB revision to
look at one string:

```console
$ mvs query at 2022-03-15 python3
3.9.10
  2022-03-14-73ad5f9e147c (2022-03-14)
```

A version is not always present the whole time, and `when` says so rather than
flattening it into a range:

```console
$ mvs query when emacs 25.1
emacs 25.1 · 60 revisions · 2016-09-24 .. 2017-04-27
RUN  FIRST                    LAST                     REVS
1    2016-09-24-adfcc2d9531e  2016-09-24-adfcc2d9531e  1
2    2016-10-13-09e4b78b48fa  2017-04-24-c90998d5cf8b  58
3    2017-04-27-e89343dc08ca  2017-04-27-e89343dc08ca  1
  gap: 1 revision between 2016-10-01 and 2016-10-01
  gap: 1 revision between 2017-04-27 and 2017-04-27
```

### One revision for several packages — `mvs solve`

Composing versions from *different* revisions gives a closure with two libcs
and two opensslls. That is fine for a leaf command-line tool and wrong for
anything that links. `solve` inverts the question: one revision, one stdenv,
internally consistent.

```console
$ mvs solve python3@3.8 nodejs@14
110 revisions · 2020-11-21 .. 2021-07-18
newest: 967d40bec14b (2021-07-18)

ATTR     VERSION
python3  3.8.9
nodejs   14.17.3

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/967d40bec14be87262b21ab901dbace23b7365db";
```

When nothing satisfies the constraints it says which two never overlapped, and
exits non-zero:

```console
$ mvs solve python3@3.6 ripgrep@14
no revision ever had both
WANTED         FROM        TO          REVS
python3 3.6.x  2017-05-29  2018-11-17  162
ripgrep 14.x   2023-11-26  2025-10-15  288
  python3 3.6.x and ripgrep 14.x never overlapped
```

A version is a prefix, matched component by component: `python3@3.8` accepts
3.8.9 and refuses 3.81, and `python3@3.1` means 3.1.x rather than 3.10 through
3.13.

### Per-package pins — `mvs lock`

```
mvs lock add <attr>[@ver]        mvs lock update [<attr> | --all]
mvs lock rm <attr>               mvs lock status
mvs lock list
```

`mvs lock update helix` finds the newest indexed revision providing helix and
rewrites **only** that entry. Every other pin stays exactly where it was, which
is the difference from a single flake input that moves everything at once.

```json
{
  "version": 1,
  "pins": {
    "helix": {
      "rev": "2fcb964de67fcf60b43471c55d5d99e61a9ccb5a",
      "label": "2026-08-10-2fcb964de67f",
      "version": "25.07.1",
      "date": "2026-08-10"
    }
  }
}
```

`mvs lock status` is where the history index earns its place — how far behind a
pin has fallen, with nothing fetched and no clock consulted. Both numbers are
measured against the newest revision the index knows, so the answer is
reproducible and moves only when the index does:

```console
$ mvs lock status
ATTR   PINNED   LATEST   BEHIND
helix  25.01.1  25.07.1  2 versions, 72 days
```

A pin can never point past what the index knows, because materialising a
revision needs its narHash. Moving one forward is therefore two steps, and
honestly so:

```console
$ nix flake update multiverse    # learn about newer revisions
$ mvs lock update helix           # move this one package
```

The Nix side reads the same file. `readLock` resolves it lazily, so twenty pins
materialise only the revisions behind the packages actually built:

```nix
multiverse.lib.readLock {
  system = "x86_64-linux";
  file = ./multiverse.lock;
}
# => { helix = <derivation>; ripgrep = <derivation>; }
```

or, in the module, `multiverse.lock = ./multiverse.lock;`.

### Running a version — `mvs run`, `mvs shell`

Thin wrappers over `nix run` and `nix shell` that take `attr@version` and
resolve it through the index. `--dry-run` prints the command line instead,
which is how to see what a constraint resolved to before fetching it.

```console
$ mvs run ripgrep@13.0.0 -- --version
ripgrep 13.0.0 from 2023-11-29-7c6e3666e204
ripgrep 13.0.0

$ mvs shell ripgrep@13.0.0 fd@8.7.0 --dry-run
nix shell github:NixOS/nixpkgs/7c6e3666e204…#ripgrep github:NixOS/nixpkgs/7c9cc5a6e5d3…#fd
```

`mvs shell` composes across revisions, which is right for standalone binaries
and wrong for a development environment — for that, `solve` gives one coherent
revision.

### The database

`multiverse.db` is derived at build time and never committed: it is binary, it
would change every time the hourly job lands a revision, and a committed copy
could sit beside JSON it no longer matches. The JSON files stay canonical.

The same derivation doubles as the artifact for anyone who wants to run SQL
over 13 years of nixpkgs — 8.4 MB, one row per *run*:

```console
$ nix build github:fzakaria/nixpkgs-multiverse#index-db
$ sqlite3 result 'SELECT count(*) FROM runs'
331307
```

## The NixOS and home-manager module

`nixosModules.default` and `homeManagerModules.default` share every option below:

```nix
{
  imports = [ inputs.multiverse.nixosModules.default ];

  multiverse = {
    enable = true;
    config.allowUnfree = true;

    # Attributes pinned to an exact version, each resolved against whichever
    # revision last shipped it.
    pins = {
      vscode = "1.107.0";
      ripgrep = "13.0.0";
    };

    # The same idea, maintained by `mvs lock` instead of by hand: a set of
    # commits, each moved on its own by `mvs lock update <attr>`.
    lock = ./multiverse.lock;
  };
}
```

Pins are also available as derivations, for options that take a package rather
than installing one:

```nix
programs.vscode.package = config.multiverse.pinned.vscode;
# and, for a lock file, config.multiverse.locked.vscode
```

An attribute claimed by more than one of `pins`, `lock` and
`cooldown.packages` is a configuration error rather than a file collision out
of `buildEnv`: each side would resolve to a different derivation of the same
package.

**Note**: Only top-level attributes work. Nested sets such as `python3Packages.*`,
or `nodePackages.*` are not in the index and cannot be used.

### Cooldown

A soak period, as a module option. `days` behind `anchor`, along nixos-unstable,
using the same machinery as [`daysBehind`](#a-soak-period):

```nix
multiverse = {
  enable = true;
  cooldown = {
    enable = true;
    days = 7;
    # any selector `at` takes
    anchor = "tip";
    packages = [ "ripgrep" "fd" ];
  };
};
```

This soaks the packages you name, not the system. The whole soaked revision is
available as a package set for anything the list cannot express:

```nix
programs.neovim.package = config.multiverse.cooldown.pkgs.neovim;
```

Soaking an entire NixOS configuration is a different operation and has to happen
at the flake level, where `nixosSystem` is called, see
[`flakeAt`](#what-about-inputsnixpkgsfollows).

An attribute claimed by both `pins` and `cooldown.packages` fails the
configuration rather than colliding at build time.

### Reaching the rest of the API

`config.multiverse.instance` is a full multiverse carrying the module's `config`
and `overlays`, for everything the options do not cover:

```nix
environment.systemPackages = [
  (config.multiverse.instance.at "24.11").ghc
];
```

### Rewriting `pkgs.<attr>` instead

The module installs derivations; it never touches `nixpkgs.overlays`. That is
deliberate since home-manager discards every `nixpkgs.*` definition when
`home-manager.useGlobalPkgs = true`, so a module that set overlays would
silently do nothing in the most common home-manager deployment.

If you want a pin to be visible to *every* other module, apply the overlay
yourself, at the layer that honours it:

```nix
nixpkgs.overlays = [
  (inputs.multiverse.lib.pinOverlay {
    pins.vscode = "1.107.0";
    config.allowUnfree = true;
  })
];
```

Now `pkgs.vscode` is 1.107.0 everywhere, and anything reading it — including
other modules' `package` defaults — picks it up.

### Without the module

`mkMultiverse` in an overlay works too, if you would rather have the whole API
hanging off `pkgs`:

```nix
nixpkgs.overlays = [
  (final: prev: {
    mv = inputs.multiverse.lib.mkMultiverse {
      system = final.stdenv.hostPlatform.system;
      config.allowUnfree = true;
      overlays = [
        # whatever overlays you want to apply to every revision
      ];
    };
  })
];

# ...then, in any module
environment.systemPackages = [ pkgs.mv.versions.vscode."1.107.0" ];
```

Same caveat as above: this sets `nixpkgs.overlays`, so it is a NixOS-level or
standalone-home-manager pattern, not one to reach for under `useGlobalPkgs`.

## Replacing several nixpkgs inputs

A flake that pins two channels to get two package sets:

```nix
inputs = {
  nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  nixpkgs-unstable.url = "github:nixos/nixpkgs/nixos-unstable";
};
```

becomes one nixpkgs plus multiverse:

```nix
{
  inputs = {
    # Keep exactly one nixpkgs. It is what `follows` resolves to and where the
    # module system gets its `lib`; see the next section.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    multiverse.url = "github:fzakaria/nixpkgs-multiverse";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs, multiverse, home-manager, ... }:
    let
      system = "x86_64-linux";
      mv = multiverse.multiverse.${system};
    in
    {
      # ...
    };
}
```

Every use of the second input has a replacement that costs nothing until it is
forced:

| before | after |
|---|---|
| `nixpkgs-unstable.legacyPackages.${system}.ripgrep` | `mv.tip.ripgrep` |
| a second input pinned to another release | `mv.at "24.11"` |
| a third input pinned to a commit for one package | `mv.version "ripgrep" "13.0.0"` |
| a pin nobody remembers the reason for | `mv.at "2022-03-15"` |

### What about `inputs.nixpkgs.follows`?

You must still keep **one** real `nixpkgs` input and follow that.

`follows` rewires one flake input to another *flake input*, and the target has to be shaped like nixpkgs. home-manager's own `flake.nix` evaluates `nixpkgs.lib` and `nixpkgs.legacyPackages.${system}` while producing its outputs.

`nixpkgs-multiverse.legacyPackages.${system}` is the multiverse API, not a package set.

```nix
# does not work
home-manager.inputs.nixpkgs.follows = "multiverse";
```

To build the home-manager configuration itself out of a multiverse revision you can wire it through `pkgs`:

```nix
home-manager.lib.homeManagerConfiguration {
  pkgs = mv.at "26.05"; # or mv.tip, or mv.at "2026-03-01"
  modules = [ ./home.nix ];
}
```

NixOS needs one more step: `nixosSystem` lives on the nixpkgs *flake*, a
package set's `lib` does not have it, so build the system from `flakeAt`:

```nix
(mv.flakeAt "26.05").lib.nixosSystem {
  system = "x86_64-linux";
  modules = [ ./configuration.nix ];
}
```

### Pinning another flake's nixpkgs

A transitive input can be pinned without adding a top-level nixpkgs input:

```nix
inputs.home-manager.inputs.nixpkgs.url = "github:NixOS/nixpkgs/73ad5f9e147c0d2a2061f1d4bd91e05078dc0b58";
```

The lock machinery only takes concrete refs, but the commit behind any
multiverse selector is one `nix eval` away, off the provenance tag:

```console
$ nix eval --raw 'github:fzakaria/nixpkgs-multiverse#multiverse.x86_64-linux' \
    --apply 'mv: (mv.at "2022-03-15").multiverse.rev'
73ad5f9e147c0d2a2061f1d4bd91e05078dc0b58
```

Any selector `at` takes works. Answering fetches that one tree (nothing is
built); a release tip comes straight off the table and fetches nothing:

```console
$ nix eval --raw 'github:fzakaria/nixpkgs-multiverse#multiverse.x86_64-linux.releaseTips."26.05".rev'
fcb8fcd6bf2d0adecae5bd491afaaaf8311b758d
```

To pin whatever revision ships a specific package version, `revOf` names it,
and the label it returns is itself a selector, so it feeds straight back into
`at`:

```console
$ nix eval --raw 'github:fzakaria/nixpkgs-multiverse#multiverse.x86_64-linux' \
    --apply 'mv: mv.revOf "python3" "3.8.9"'
2021-07-18-967d40bec14b

$ nix eval --raw 'github:fzakaria/nixpkgs-multiverse#multiverse.x86_64-linux' \
    --apply 'mv: (mv.at (mv.revOf "python3" "3.8.9")).multiverse.rev'
967d40bec14be87262b21ab901dbace23b7365db
```


## Building the index

```sh
# refresh revisions.json from the channel archive
nix run .#fetch-unstable-revisions
# point releases.json at the current tip of every release channel
nix run .#fetch-releases
# extract versions + narHashes for every revision
nix run .#build-index
# only revisions the index has never covered
nix run .#build-index -- --incremental
# smoke test on the first 30
nix run .#build-index -- -n 30
# rebuild the index from cache, no evaluation
nix run .#build-index -- --merge-only
# extract this many revisions at once
nix run .#build-index -- -j 40
# fold version lifetimes out of the same extractions
nix run .#build-history
# only what the history has never covered
nix run .#build-history -- --incremental
# rewrite the status block at the top of this README
nix run .#update-readme-status
```

None of this needs a nixpkgs clone: revisions are resolved through the GitHub API and materialised with `nix flake prefetch`, which is what lets [the update workflow](.github/workflows/update-index.yml) run hourly and commit whatever moved.

Set `NIXPKGS=/path/to/nixpkgs` to use a clone instead, which trades the download for a `git archive` and keeps the tree out of the store.

## License

MIT, please see [LICENSE](LICENSE).

The Nix expressions and tooling are original work. `revisions.json`,
`index/versions.json` and `index/history.json` are generated metadata about
nixpkgs: revisions, dates, hashes and version strings, not nixpkgs source. Nixpkgs itself is MIT and is
fetched at evaluation time.
