# The scripts in tools/, as things a caller can run.
#
# Three pieces come out of here: the runtime dependencies (which the dev shell
# hands out directly), the description each tool's app surfaces through
# `nix flake show` and `nix flake check`, and the wrapper that makes
# `nix run .#<tool>` act on the caller's checkout.
{ pkgs }:
let
  # What tools/*.sh reach for. `bash` is in the list because the scripts use
  # `mapfile`, which is bash 4+ — the bash 3.2 macOS still ships fails on it.
  #
  # `nix` is deliberately absent: the scripts call `nix hash path` and
  # `nix-instantiate` against the caller's own store, so the host's nix is the
  # correct one to use.
  deps = [
    pkgs.bash
    pkgs.python3
    pkgs.gitMinimal
    pkgs.gnutar
    pkgs.gnugrep
    pkgs.coreutils
  ];

  # `nix run` executes a copy of tools/ out of the store, but every script
  # rewrites revisions.json and index/ in place, so they need a checkout to act
  # on. The wrapper hands the caller's directory over as MULTIVERSE_ROOT and
  # refuses to guess when it is not a checkout.
  #
  # MULTIVERSE_NIX names the other half of the code: the evaluators in nix/,
  # which arrive as a separate store path, so a script cannot find them by
  # walking up from its own $0 the way it does in a checkout.
  wrap =
    name:
    pkgs.writeShellApplication {
      inherit name;
      runtimeInputs = deps;
      text = ''
        if [ ! -f "$PWD/revisions.json" ]; then
          echo "${name}: run this from a nixpkgs-multiverse checkout (no revisions.json in $PWD)" >&2
          exit 1
        fi
        export MULTIVERSE_ROOT="$PWD"
        export MULTIVERSE_NIX="${./.}"
        exec bash ${../tools}/${name}.sh "$@"
      '';
    };

  descriptions = {
    build-index = "Build index/versions.json (and narHashes) from revisions.json";
    build-history = "Build index/history.json (version lifetimes) from the extraction cache";
    build-stats = "Build index/stats.json (the aggregates the site's charts draw) from index/history.json";
    fetch-unstable-revisions = "Append new nixos-unstable channel bumps to revisions.json";
    update-outpaths = "Update the store-path artifacts: fetch listings, match digests, crawl the cache";
    bump-data-pin = "Repoint data-pins.json at a dated release cut's assets";
    fetch-releases = "Refresh releases.json with the current tip of every release channel";
    add-narhashes = "Fill in narHash for revisions that lack one";
    update-readme-status = "Rewrite the status block at the top of README.md";
  };
in
{
  inherit deps descriptions;

  # { <tool> = <wrapped executable>; } for every described tool.
  wrappers = builtins.mapAttrs (name: _description: wrap name) descriptions;
}
