# The pinned store-path artifacts, assembled into one directory.
#
# Each file is fetched by the {tag, narHash} records in data-pins.json —
# hash-verified, so an overwritten release asset fails closed — and nothing is
# fetched until something builds a site or a database out of this.
{ pkgs }:
let
  pins = builtins.fromJSON (builtins.readFile ../data-pins.json);
  fetched = builtins.mapAttrs (
    name: pin:
    builtins.fetchTree {
      type = "file";
      url = "${pins.baseUrl}/${pin.tag}/${name}";
      inherit (pin) narHash;
    }
  ) pins.files;
in
pkgs.runCommand "multiverse-data" { } ''
  mkdir -p $out
  ${builtins.concatStringsSep "\n" (
    map (name: "cp ${fetched.${name}} $out/${name}") (builtins.attrNames fetched)
  )}
''
