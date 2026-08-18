# `mvs`, the consumer tool: read the index without materialising anything.
#
# The binary is wrapped with MVS_DB pointing at the database index-db.nix
# builds, which is what makes the data version *be* the flake version. There is
# no download path and no cache directory on purpose — a second source of truth
# would drift from the pinned input, and two people running the same `nix run`
# would get different answers.
#
# Built from the package set nix/pkgs.nix bootstraps — itself a multiverse
# revision — so `inputs = { }` stays intact.
{ pkgs }:
let
  inherit (pkgs) lib;

  unwrapped = pkgs.rustPlatform.buildRustPackage {
    pname = "mvs";
    version = "0.1.0";
    # The four inputs the build reads, named rather than a bare `../mvs`.
    #
    # A flake hands nix a git-filtered tree, so `../mvs` costs nothing there.
    # `nix-build packages.nix -A mvs` out of a working checkout has no such
    # filter and copies whatever is lying around — mvs/target alone is hundreds
    # of megabytes, and a stray `result` symlink or editor swap file changes the
    # store path, which is enough to make the two roads disagree about a
    # derivation that is supposed to be the same one. An allowlist is immune to
    # both, and to whatever lands in the directory next. See docs/non-flake.md.
    #
    # build-db.py sits in mvs/ but is not part of this build: nix/index-db.nix
    # reaches for it as its own store path.
    src = lib.fileset.toSource {
      root = ../mvs;
      fileset = lib.fileset.unions [
        ../mvs/Cargo.toml
        ../mvs/Cargo.lock
        ../mvs/src
        ../mvs/tests
      ];
    };
    cargoLock.lockFile = ../mvs/Cargo.lock;

    # The unit tests run here. The differential test against
    # builtins.compareVersions cannot: it needs a `nix` to ask, and there is
    # none inside the sandbox, so it skips and CI runs it.
    meta = {
      description = "Read the nixpkgs multiverse index";
      mainProgram = "mvs";
    };
  };
in
pkgs.runCommand "mvs"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    inherit (unwrapped) meta;
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/mvs $out/bin/mvs --set MVS_DB ${pkgs.multiverse-index-db}
  ''
