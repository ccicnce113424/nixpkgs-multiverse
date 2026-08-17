# `nix run .#<name>` — the tools without entering a shell first:
#   nix run .#build-index -- -n 30
{ pkgs }:
builtins.mapAttrs (name: description: {
  type = "app";
  program = "${pkgs.multiverse-tools.wrappers.${name}}/bin/${name}";
  meta = { inherit description; };
}) pkgs.multiverse-tools.descriptions
// {
  # `nix run .#mvs -- query versions python3`
  mvs = {
    type = "app";
    program = "${pkgs.mvs}/bin/mvs";
    meta.description = "Read the nixpkgs multiverse index";
  };

  # `nix run .#test-site` — the browser suite, and the way to run it that asks
  # nothing of the host's nix.conf. Arguments reach Playwright, so a single spec
  # or a headed run is
  #   nix run .#test-site -- --headed router.spec.js
  # checks.site runs this very script inside a __noChroot build, so
  # `nix flake check` covers it wherever the sandbox setting allows.
  test-site = {
    type = "app";
    program = "${pkgs.multiverse-site-tests}/bin/test-site";
    meta.description = "Run the browser tests against the built site";
  };

  # `nix run .#serve [port]` — the built site on a local port.
  serve = {
    type = "app";
    program = "${pkgs.multiverse-serve}/bin/serve-site";
    meta.description = "Serve the built site locally for testing";
  };
}
