# Demonstrates the point of the multiverse: several versions of the same package,
# drawn from different vendored revisions, composed inside a single evaluation.
#
# This is what a multi-input flake makes painful and what indexing-by-commit
# cannot do at all — the three Pythons below come from three different nixpkgs
# revisions and coexist in one derivation because Nix keeps their dependency
# graphs disjoint.
{
  system ? builtins.currentSystem,
}:
let
  mv = import ../. { inherit system; };

  # Newest revision supplies the builder itself; the contents come from wherever
  # each version happens to live.
  host = mv.at "25.05";

  pythons = [
    (mv.version "python3" "3.10.11") # 23.05
    (mv.version "python3" "3.11.9") # 24.05
    (mv.version "python3" "3.12.10") # 25.05
  ];
in
{
  inherit pythons;

  # `ignoreCollisions` because three Pythons all want bin/python3; the point
  # here is that the closure resolves at all, not that the env is tidy.
  env = host.buildEnv {
    name = "three-pythons";
    paths = pythons;
    ignoreCollisions = true;
  };
}
