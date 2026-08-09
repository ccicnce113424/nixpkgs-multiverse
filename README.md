# nixpkgs-multiverse

> Please read this [blog post](https://fzakaria.com/2026/08/09/nixpkgs-multiverse-every-version-that-ever-existed) for context.

Every nixpkgs revision, reachable from a **single evaluation**. One flake input, no juggling `nixpkgs` pinned at N commits.

![lotr meme "One flake to rule them all"](./multiverse_lotr.jpg)

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
# the raw {rev, date, narHash} array
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

## Building the index

```sh
# refresh revisions.json from the channel archive
tools/fetch-unstable-revisions.sh
# extract versions + narHashes
tools/build-index.sh
# smoke test on the first 30
tools/build-index.sh -n 30
# rebuild the index from cache, no evaluation
tools/build-index.sh --merge-only
```

## License

MIT, please see [LICENSE](LICENSE).

The Nix expressions and tooling are original work. `revisions.json` and
`index/versions.json` are generated metadata about nixpkgs: revisions, dates,
hashes and version strings, not nixpkgs source. Nixpkgs itself is MIT and is
fetched at evaluation time.
