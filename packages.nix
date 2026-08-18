# Everything this repository itself builds, for callers who are not the flake:
#
#   nix-build packages.nix -A mvs
#
# The flake's `packages.<system>` output is this file, so the two spellings
# cannot drift apart about what a package is called or what it is built from.
# The multiverse API is the other entry point, `default.nix`; nothing here is
# part of it.
#
# `self` is threaded through only because two derivations stamp the commit they
# were built from into their output — see nix/site.nix — and nothing outside a
# flake knows it. The empty attrset is the honest answer, and the `or` defaults
# at those two sites turn it into a placeholder.
{
  system ? builtins.currentSystem,
  self ? { },
}:
let
  pkgs = import ./nix/pkgs.nix { inherit self system; };
in
rec {
  site = pkgs.multiverse-site;
  mvs = pkgs.mvs;
  index-db = pkgs.multiverse-index-db;
  default = site;
}
