# Documentation

Every nixpkgs revision, reachable from a single evaluation. These pages cover
the two ways to use the index: as Nix expressions, and as the `mvs` command
line tool.

1. [Design](./design.md) explains why this exists, and why Nix makes it
   possible in the first place.
2. [Comparisons](./comparisons.md) places this next to nix-index, comma,
   fastpkgs, devbox, and flox, and says what it deliberately is not.
3. [Selectors](./selectors.md) covers the one vocabulary for naming a
   revision, shared by the Nix API and `mvs`.
4. [The Nix API](./nix-api.md) such as `at`, `daysBehind`, `versionsOf`, version
   history, provenance, and how releases differ from revisions.
5. [The `mvs` CLI](./cli.md) allows querying the index offline, solving one revision for
   several packages, write per-package pins, run a version.
6. [The NixOS, nix-darwin, and home-manager module](./modules.md) allows pinning
   individual packages from your system configuration.
7. [Replacing several nixpkgs inputs](./flake-inputs.md) allows using the multiverse
   as the `nixpkgs` other flakes see.
8. [Without flakes](./non-flake.md) wires the same API up from npins, niv or a
   plain `fetchTarball`.
9. [Building the index](./building-the-index.md) explains how the data is extracted
   and refreshed.
10. [The store-path index](./store-paths.md) explains how versions are matched
    to cache.nixos.org store paths — the data behind `fast.*`, the census, and
    the site's dependency and liveness views.

The index itself is browsable at <https://nixmultiverse.com/>.

Questions, ideas, and "does it handle X?" are welcome in the
[Discord thread](https://discord.com/channels/568306982717751326/1538990827404267590).
