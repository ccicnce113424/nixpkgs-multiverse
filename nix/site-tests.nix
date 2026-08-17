# The browser suite: tests/site/*.spec.js, run by Playwright's Chromium against
# a built site on a local port.
#
# What it tests is a `nix build .#site` store path, not the site/ source
# directory — so the data files, the js.<hash> rename and the import map are all
# under test, which is most of what a browser test is here for. SITE_ROOT
# overrides the tree, for iterating against a build of your own.
#
# The suite needs the network while it *runs*, not merely to fetch its inputs:
# every page imports Preact from jsdelivr through that import map, and the graph
# explorer imports cytoscape the same way. Vendoring both into the tree under
# test would make it hermetic at the cost of no longer testing the artifact
# GitHub Pages serves. Hence __noChroot on checks.site rather than a
# sandbox-friendly rewrite.
{ pkgs }:
pkgs.writeShellApplication {
  name = "test-site";
  runtimeInputs = [
    pkgs.playwright-test
    pkgs.python3
  ];
  text = ''
    export SITE_ROOT="''${SITE_ROOT:-${pkgs.multiverse-site}}"

    # Playwright's default is to download its own browsers, which is neither
    # possible nor wanted on NixOS. Point it at the nixpkgs build instead, and
    # stop it auditing the host for the distro packages it expects to find
    # beside them.
    export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
    export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true

    # Chromium wants a writable home for its profile, and Playwright writes
    # traces and failure screenshots beside its config — which is a read-only
    # store path, so run from a copy.
    HOME="$(mktemp -d)"
    export HOME
    work="$(mktemp -d)"
    cp -r ${../tests/site}/* "$work"/
    cd "$work"

    exec playwright test "$@"
  '';
}
