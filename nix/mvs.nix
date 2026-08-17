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
  unwrapped = pkgs.rustPlatform.buildRustPackage {
    pname = "mvs";
    version = "0.1.0";
    src = ../mvs;
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
