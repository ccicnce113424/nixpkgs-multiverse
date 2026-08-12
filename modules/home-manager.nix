# The home-manager entry point. Everything that decides *what* to install lives
# in multiverse.nix; this file only says where it goes.
#
# `home.packages` rather than an overlay is what makes this work under
# `home-manager.useGlobalPkgs = true`, where every `nixpkgs.*` definition is
# discarded — see the comment at the top of multiverse.nix.
{ config, lib, ... }:

{
  imports = [ ./multiverse.nix ];

  config = lib.mkIf config.multiverse.enable {
    home.packages = config.multiverse.packages;
  };
}
