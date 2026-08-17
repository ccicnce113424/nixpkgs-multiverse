# The package set everything in this flake is built out of.
#
# The dev shell, the tool wrappers and every derivation under nix/ come out of a
# multiverse revision. That keeps `inputs = { }` intact: nothing is fetched
# unless somebody actually asks for a shell or runs a tool.
#
# The newest *release* rather than `tip`, for two reasons. Bash and python from
# last Tuesday's channel bump are no better than bash and python from the
# release, and pinning to something that moves twice a year means the hourly
# update job reuses one closure instead of building a fresh one every time
# nixos-unstable advances.
#
# The multiverse's own derivations ride in through overlay.nix, so everything
# below reaches for them as `pkgs.multiverse-site`, `pkgs.mvs` and friends
# rather than threading a second attrset alongside the package set.
{ self, system }:
let
  mv = import ../multiverse.nix {
    inherit system;
    overlays = [ (import ./overlay.nix { inherit self; }) ];
  };
in
mv.at (builtins.elemAt mv.releases (builtins.length mv.releases - 1))
