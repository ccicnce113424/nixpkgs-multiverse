# The system-independent half of the flake's API: `multiverse.lib`.
#
# Nothing here touches a package set of its own — each entry imports
# multiverse.nix with whatever system, config and overlays the caller passes —
# so this file is usable from outside any per-system scope.
{
  # `mkMultiverse` for callers who need to pass config/overlays through.
  mkMultiverse = args: import ../multiverse.nix args;

  # A `multiverse.lock` written by `mvs lock`, resolved to derivations:
  #
  #   multiverse.lib.readLock { system = "x86_64-linux"; file = ./multiverse.lock; }
  #   => { helix = <derivation>; ripgrep = <derivation>; }
  #
  # The same function `multiverse.<system>.readLock` exposes, taking the system
  # as an argument for callers who are outside a per-system scope — a
  # home-manager module reading a lock beside its flake, typically.
  readLock =
    {
      system,
      file,
      config ? { },
      overlays ? [ ],
    }:
    (import ../multiverse.nix { inherit system config overlays; }).readLock file;

  # An overlay that rewrites `pkgs.<attr>` to a pinned version, for the cases the
  # modules deliberately do not cover: making every *other* module see the pin,
  # so that `programs.<name>.package` and friends pick it up without being named
  # individually.
  #
  # Handed out rather than set from inside the modules, because
  # `nixpkgs.overlays` is discarded wherever home-manager runs with
  # `useGlobalPkgs = true` — applying it is the caller's job, at the layer that
  # honours it. See the comment at the top of modules/multiverse.nix.
  #
  # The system comes off `final` rather than being an argument: reading it from
  # the package set being extended is what keeps this usable inside
  # `nixpkgs.overlays` without a second source of truth for the platform.
  pinOverlay =
    {
      pins,
      config ? { },
      overlays ? [ ],
    }:
    final: _prev:
    let
      mv = import ../multiverse.nix {
        system = final.stdenv.hostPlatform.system;
        inherit config overlays;
      };
    in
    builtins.mapAttrs (attr: version: mv.version attr version) pins;
}
