# The root attrset nix-eval-jobs walks to get {attr -> output -> store path}
# for a single vendored revision, at one explicit system.
#
# This is the evaluation half of the inverted join in docs/store-paths.md.
# The channel's
# store-paths listing cannot say which system a path was built for, so it
# cannot turn a derivation name into a digest; an evaluation can, because the
# system is an input to it. The listing keeps its other job — deciding whether
# Hydra built a path at all — as a membership test on the digest this produces.
#
# Mirrors nix/extract-versions.nix in how it enters nixpkgs, and differs from it
# in who does the forcing: that one is a single nix-instantiate over the whole
# attrset, while nix-eval-jobs hands each
# top-level name to a worker that evaluates `root.<name>` by itself. Everything
# expensive therefore has to live inside a value, never in the attrset that
# lists them, or the parent process pays for all of nixpkgs at once.
{
  revPath,
  system ? builtins.currentSystem,
  # When null, walk every top-level attribute. Otherwise a list of names.
  attrs ? null,
}:

let
  entry = import revPath;

  args = {
    inherit system;
    config = {
      allowAliases = true;
      allowUnfree = true;
      allowBroken = false;
    };
  };

  # nixpkgs only grew an `overlays` argument in 17.03 — 16.09 takes exactly
  # { config, system } — and handing a function an argument it does not declare
  # is a hard error, so the empty list is offered only where it is accepted.
  pkgs =
    if (builtins.functionArgs entry) ? overlays then
      entry (args // { overlays = [ ]; })
    else
      entry args;

  # Attribute names to walk. `attrNames` does not force any value, so the
  # parent process gets the whole list for the price of the fixpoint alone.
  names =
    if attrs != null then
      attrs
    else
      let
        attempt = builtins.tryEval (builtins.attrNames pkgs);
      in
      if attempt.success then attempt.value else [ ];

  # Top-level derivations only, and the filter runs in the worker that forces
  # the attribute rather than here. Anything that is not a derivation becomes
  # an empty attrset, which nix-eval-jobs neither reports nor recurses into:
  # that is what keeps `haskellPackages` and friends — every one of which sets
  # recurseForDerivations — out of a run that asked for top-level attributes.
  #
  # A nested pass would want the value handed over unwrapped instead. Not
  # wired up: nothing indexes nested attributes yet.
  project =
    n:
    let
      v = pkgs.${n};
    in
    if (v.type or "") == "derivation" then v else { };
in
builtins.listToAttrs (
  map (n: {
    name = n;
    value = project n;
  }) names
)
