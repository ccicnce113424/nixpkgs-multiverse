# nixpkgs-multiverse

> Please read this [blog post](https://fzakaria.com/2026/08/09/nixpkgs-multiverse-every-version-that-ever-existed) for context.

Every nixpkgs revision, reachable from a **single evaluation**. One flake input, no juggling `nixpkgs` pinned at N commits.

![lotr meme "One flake to rule them all"](./multiverse_lotr.jpg)

## Status

![github master branch workflow](https://github.com/fzakaria/nixpkgs-multiverse/actions/workflows/update-index.yml/badge.svg?branch=main)

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

NixOS is the same shape, with one wrinkle that you must go through `eval-config.nix`, which is what `nixosSystem` wraps:

```nix
let
  pkgs = mv.at "26.05";
in
import "${pkgs.path}/nixos/lib/eval-config.nix" {
  inherit system;
  modules = [ ./configuration.nix ];
}
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
# rewrite the status block at the top of this README
nix run .#update-readme-status
```

None of this needs a nixpkgs clone: revisions are resolved through the GitHub API and materialised with `nix flake prefetch`, which is what lets [the update workflow](.github/workflows/update-index.yml) run hourly and commit whatever moved.

Set `NIXPKGS=/path/to/nixpkgs` to use a clone instead, which trades the download for a `git archive` and keeps the tree out of the store.

## License

MIT, please see [LICENSE](LICENSE).

The Nix expressions and tooling are original work. `revisions.json` and
`index/versions.json` are generated metadata about nixpkgs: revisions, dates,
hashes and version strings, not nixpkgs source. Nixpkgs itself is MIT and is
fetched at evaluation time.
