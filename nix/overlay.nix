# Everything this repository builds, as attributes on a package set.
#
# Applied by nix/pkgs.nix to the release revision the flake bootstraps from, so
# each file below takes one `pkgs` and finds its dependencies on it —
# store-data.nix asks for `pkgs.multiverse-data`, site.nix for
# `pkgs.multiverse-site-data` — instead of every derivation being threaded a
# `<thing>For system` function by hand.
#
# `multiverse` is deliberately not used as a name here: multiverse.nix stamps
# provenance onto every package set it hands out under exactly that attribute,
# after overlays have run, so an overlay claiming it would be overwritten.
#
# Plain `import` rather than `callPackage`: some of these are attrsets rather
# than derivations (tools.nix), and makeOverridable would graft `override` onto
# them, which then shows up as a tool named "override".
{ self }:
final: _prev: {
  multiverse-data = import ./data.nix { pkgs = final; };
  multiverse-docs = import ./docs.nix { pkgs = final; };
  multiverse-store-data = import ./store-data.nix { pkgs = final; };
  multiverse-site-data = import ./site-data.nix { pkgs = final; };
  multiverse-site = import ./site.nix {
    pkgs = final;
    inherit self;
  };
  multiverse-index-db = import ./index-db.nix {
    pkgs = final;
    inherit self;
    # The system the database describes, which is the one it is built for: the
    # store-path artifacts are per system and `mvs path` must answer for the
    # machine running it.
    system = final.stdenv.hostPlatform.system;
  };
  multiverse-site-tests = import ./site-tests.nix { pkgs = final; };
  multiverse-serve = import ./serve.nix { pkgs = final; };
  multiverse-formatter = import ./formatter.nix { pkgs = final; };
  multiverse-tools = import ./tools.nix { pkgs = final; };

  mvs = import ./mvs.nix { pkgs = final; };
}
