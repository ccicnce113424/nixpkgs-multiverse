# The shells behind `nix develop`.
{ pkgs }:
{
  # Everything tools/*.sh needs, so `tools/build-index.sh` runs the same way on
  # any host — including the bash 4+ the scripts assume.
  default = pkgs.mkShellNoCC { packages = pkgs.multiverse-tools.deps; };

  # `nix develop .#mvs -c cargo test` — the crate's own toolchain, with MVS_DB
  # already pointing at a built database so the tests have an index to read
  # without one being wired up by hand.
  #
  # The differential test against builtins.compareVersions runs from here rather
  # than from `nix flake check`: it needs a `nix` to ask, and the build sandbox
  # has none, so it skips there and CI runs it.
  mvs = pkgs.mkShell {
    packages = [
      pkgs.cargo
      pkgs.rustc
      pkgs.rustfmt
      pkgs.clippy
    ];
    MVS_DB = pkgs.multiverse-index-db;
  };
}
