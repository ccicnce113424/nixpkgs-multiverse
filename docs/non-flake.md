# Without flakes

Nothing here needs the flake machinery.

`default.nix` hands back exactly what the `multiverse.<system>` flake output
does:

```nix
# the same value, twice
multiverse.multiverse.x86_64-linux
import nixpkgs-multiverse { system = "x86_64-linux"; }
```

Eevery function in [the Nix API](./nix-api.md): `at`, `version`,
`versionsOf`, `daysBehind`, `fast`, `readLock` works.

## Pinning the repository

With [npins](https://github.com/andir/npins):

```console
$ npins add github fzakaria nixpkgs-multiverse
```

```nix
let
  sources = import ./npins;
  mv = import sources.nixpkgs-multiverse { };
in
mv.version "python3" "3.8.9"
```

[niv](https://github.com/nmattia/niv) is the same shape: `niv add
fzakaria/nixpkgs-multiverse`, then `import (import ./nix/sources.nix).nixpkgs-multiverse { }`.
With no pinning tool at all:

```nix
import (builtins.fetchTarball {
  url = "https://github.com/fzakaria/nixpkgs-multiverse/archive/<commit>.tar.gz";
  sha256 = "fill me in";
}) { }
```

Updating the multiverse does not change any of your pins.

## From the command line

`nix run github:fzakaria/nixpkgs-multiverse#<selector>` has no non-flake
spelling. Instead you can execute the following from the repository with `-A`:

```console
$ nix-build -A 'versions.python3."3.8.9"' && ./result/bin/python3 --version
Python 3.8.9

$ nix-build -A latest.ripgrep --no-out-link
/nix/store/…-ripgrep-14.1.1
```

Against a pinned source rather than a checkout:

```console
$ nix-build -E 'import (import ./npins).nixpkgs-multiverse { }' -A latest.hello
```


The `nix-shell` is also supported:

```nix
# shell.nix
let
  sources = import ./npins;
  mv = import sources.nixpkgs-multiverse { };
in
mv.tip.mkShell {
  packages = [
    (mv.version "python3" "3.8.9")
    (mv.version "nodejs" "14.17.0")
  ];
}
```

## The CLI

The `mvs` CLI is within `packages.nix`:

```console
$ nix-build packages.nix -A mvs
$ ./result/bin/mvs query versions python3
```

## What flakes buy you

Two things, both about the CLI rather than the API:

* `nix run github:fzakaria/nixpkgs-multiverse#<selector>` with nothing checked
  out and nothing pinned. Every example in these docs that starts that way is
  a convenience, not a dependency.
* `flakeAt`, which hands back a revision shaped like the `nixpkgs` *flake* —
  the attrset carrying `lib.nixosSystem`. It exists on the non-flake road too
  and returns the same value, but what it is for is
  [building a system at the flake level](./flake-inputs.md#what-about-inputsnixpkgsfollows).
