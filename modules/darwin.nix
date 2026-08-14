# The nix-darwin entry point. Everything that decides *what* to install lives
# in multiverse.nix; this file only says where it goes.
#
# nix-darwin spells the system package list exactly as NixOS does, so this file
# and modules/nixos.nix are identical. Both exist so that each flake output
# points at a file named for the module system it belongs to.
{ config, lib, ... }:

{
  imports = [ ./multiverse.nix ];

  config = lib.mkIf config.multiverse.enable {
    environment.systemPackages = config.multiverse.packages;
  };
}
