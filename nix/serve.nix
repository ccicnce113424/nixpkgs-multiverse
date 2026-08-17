# `nix run .#serve [port]` — the built site on a local port, for testing.
#
# The server itself is tools/serve-site.py; this only points it at the store
# path `nix build .#site` would produce.
{ pkgs }:
pkgs.writeShellApplication {
  name = "serve-site";
  runtimeInputs = [ pkgs.python3 ];
  text = ''
    SITE_ROOT=${pkgs.multiverse-site} exec python3 ${../tools/serve-site.py} "$@"
  '';
}
