# Tests mv.flakeAt: a revision presented as the flake attrset that
# `inputs.nixpkgs` would have been, had the revision been a flake input.
# Exercised by evaluation only:
#
#   nix eval --json -f tests/flake-at.nix --apply 'f: f { }'
#
# Forcing the assertions fetches three trees (tip, the newest release, and one
# pre-flake revision) but builds nothing.
{
  system ? "x86_64-linux",
}:
let
  mv = import ../multiverse.nix { inherit system; };

  # The newest release the index tracks, so the test never goes stale.
  newestRelease = builtins.elemAt mv.releases (builtins.length mv.releases - 1);

  tipFlake = mv.flakeAt "tip";
  releaseFlake = mv.flakeAt newestRelease;

  # The one system every revision in the index has always had. The pre-flake
  # case below is asked of it rather than of this host: a 2019 nixpkgs cannot be
  # evaluated for aarch64-darwin at all, and what that case tests is the
  # synthesised-outputs fallback, not which platforms nixpkgs supported in 2019.
  alwaysBuilt = "x86_64-linux";

  # Old enough that the tree predates nixpkgs' own flake.nix (20.03), so this
  # lands on the synthesised-outputs fallback.
  preFlake = (import ../multiverse.nix { system = alwaysBuilt; }).flakeAt "2019-01-01";
in

# flakeAt "tip" resolves to the same revision as `tip` itself.
assert tipFlake.rev == mv.tip.multiverse.rev;

# The bookkeeping a real flake input carries.
assert tipFlake._type == "flake";
assert tipFlake.inputs == { };
assert tipFlake.sourceInfo ? narHash;

# The outputs of nixpkgs' own flake.nix are all present: nixosSystem is
# reachable without the eval-config.nix detour, and legacyPackages is a real
# package set.
assert tipFlake.lib ? nixosSystem;
assert builtins.isAttrs tipFlake.legacyPackages.${system}.hello;

# A release selector resolves through releases.json and the provenance tag
# names the release.
assert releaseFlake.multiverse.release == newestRelease;
assert releaseFlake.lib ? nixosSystem;

# A label — the `date-<12 hex>` handle revOf and revs hand out — is itself a
# selector, so the version → revision path composes without string surgery.
# Tip's own label lands on the same memoised instance, so this fetches nothing.
assert (mv.flakeAt tipFlake.multiverse.label).rev == tipFlake.rev;

# A pre-flake tree still yields lib and a package set — just none of the
# outputs only nixpkgs' flake.nix could have provided.
assert preFlake._type == "flake";
assert builtins.isString preFlake.legacyPackages.${alwaysBuilt}.hello.name;
assert !(preFlake ? nixosModules);

{
  tip = tipFlake.multiverse.label;
  release = "${newestRelease} -> ${releaseFlake.rev}";
  preFlake = preFlake.multiverse.label;
  libVersion = tipFlake.lib.version;
}
