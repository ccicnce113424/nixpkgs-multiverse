# The store-data products: meta/revdeps/identify shards, census.json,
# universe.bin. Built from the pinned artifacts, so the site's store views and
# the fast evaluation path always describe the same data cut.
#
# tools/build-site-data.py reads the committed index files itself (it closes the
# open tip on its own), so it gets an assembled checkout root the way mvs'
# build-db.py does.
{ pkgs }:
pkgs.runCommand "nixpkgs-multiverse-store-data"
  {
    nativeBuildInputs = [ pkgs.python3 ];
  }
  ''
    mkdir -p $out
    root=$(mktemp -d)
    mkdir -p "$root/index"
    cp ${../revisions.json} "$root/revisions.json"
    cp ${../index/versions.json} "$root/index/versions.json"
    cp ${../index/history.json} "$root/index/history.json"
    python3 ${../tools/build-site-data.py} "$root" ${pkgs.multiverse-data} $out
  ''
