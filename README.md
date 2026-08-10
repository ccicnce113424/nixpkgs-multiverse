# nixpkgs-multiverse

> Please read this [blog post](https://fzakaria.com/2026/08/09/nixpkgs-multiverse-every-version-that-ever-existed) for context.

Every nixpkgs revision, reachable from a **single evaluation**. One flake input, no juggling `nixpkgs` pinned at N commits.

![lotr meme "One flake to rule them all"](./multiverse_lotr.jpg)

## Status

![github master branch workflow](https://github.com/fzakaria/nixpkgs-multiverse/actions/workflows/update-index.yml/badge.svg?branch=main)

<!-- BEGIN index-status -->
- **292,770 package versions** across **31,096 attributes**, from **1,405 revisions**
- 2015-09-30 → 2026-08-07, newest [`f13ff45afd1b`](https://github.com/NixOS/nixpkgs/commit/f13ff45afd1bb73e640eaa08a7066dbed07e3238) · [`nixos-26.11pre1049422`](https://nix-releases.s3.amazonaws.com/nixos/unstable/nixos-26.11pre1049422.f13ff45afd1b/)
<!-- END index-status -->

## Usage

Access every version of every package ever packaged in nixpkgs, from 2015 to 2026 as an installable.

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
  "3.5.3",
  "3.6.2",
  # 56 other versions omitted for brevity
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
  # by release
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
[ "3.5.3" "3.6.2" … "3.13.13" ]          # 57 versions

nix-repl> multiverse.x86_64-linux.revOf "python3" "3.8.9"
"2021-07-06-00c86ad14639"

nix-repl> multiverse.x86_64-linux.releases
[ "15.09" "16.03" … "26.05" ]
```


**Note**: Enumerating versions fetches nothing as it reads an index file only. A revision is materialised the first time you force a derivation.


Query the underlying revision data.

```nix
# every known version, version-aware sort
mv.versionsOf "python3"
# every known revision that shipped a version
mv.revOf "python3" "3.8.9"
# all known revisions, newest first
mv.releases
# every revision label, oldest first
mv.revs
# the raw {rev, date, channel, narHash, name} array, plus `release` on releases
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
# extract versions + narHashes for every revision
nix run .#build-index
# only revisions the index has never covered
nix run .#build-index -- --incremental
# smoke test on the first 30
nix run .#build-index -- -n 30
# rebuild the index from cache, no evaluation
nix run .#build-index -- --merge-only
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
