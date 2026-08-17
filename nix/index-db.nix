# The database `mvs` reads: revisions.json, releases.json and
# index/history.json projected into SQLite, one row per run.
#
# Derived at build time and never committed. It is binary, it would change every
# time the hourly job lands a revision, and a committed copy could sit beside
# JSON it no longer matches. Building it here means the data version *is* the
# flake version: a newer index arrives through `nix flake update multiverse` and
# rewraps the binary.
#
# $out is the file itself rather than a directory holding it, so
# `nix build .#index-db` leaves a ./result you can hand straight to sqlite3 —
# 13 years of nixpkgs, queryable with SQL.
{ pkgs, self }:
pkgs.runCommand "multiverse.db"
  {
    nativeBuildInputs = [ pkgs.python3 ];

    # Names the checkout the data came from, so a database found on its own can
    # be traced back. A dirty tree has nothing honest to say.
    MVS_BUILT_FROM = self.rev or "";
  }
  ''
    # build-db.py takes a checkout root; the store paths are individual files,
    # so assemble the layout it expects.
    root=$(mktemp -d)
    mkdir -p "$root/index"
    cp ${../revisions.json} "$root/revisions.json"
    cp ${../releases.json} "$root/releases.json"
    cp ${../index/history.json} "$root/index/history.json"
    cp ${../index/versions.json} "$root/index/versions.json"

    # The store-path artifacts ride in the same way the site build takes them:
    # fetched per-file against data-pins.json, so the binary's answers and the
    # site's views describe one data cut. --data-dir is what turns on
    # `mvs path`/`size`/`deps`/`rdeps`/`identify`; without it the same script
    # builds the index-only database those subcommands then decline to answer
    # from.
    python3 ${../mvs/build-db.py} "$root" $out \
      --data-dir ${pkgs.multiverse-data}
  ''
