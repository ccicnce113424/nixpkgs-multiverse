# The data products for the deployable site: history/versions shards, sitemap,
# census, docs, universe.bin, etc.
#
# Heavy data processing that depends only on index data, revisions, releases and
# docs — isolated from the frontend asset directory (site/) and dirty git state
# so editing html/css/js does not trigger recalculating and re-sharding all
# datasets.
{ pkgs }:
let
  inherit (import ./site-origin.nix) siteOrigin;

  # How many package URLs the sitemap offers. See tools/sitemap.py for why it is
  # a slice rather than every attribute.
  sitemapPackages = 2000;
in
pkgs.runCommand "nixpkgs-multiverse-site-data"
  {
    nativeBuildInputs = [ pkgs.python3 ];
  }
  ''
    mkdir -p $out
    cp ${../revisions.json} $out/revisions.json
    cp ${../releases.json} $out/releases.json
    cp ${../index/stats.json} $out/stats.json

    # The open tip closed once, before anything below reads either file — see
    # tools/close-tip.py. Everything downstream takes these, not the committed
    # originals.
    python3 ${../tools/close-tip.py} ${../index/versions.json} versions.json
    python3 ${../tools/close-tip.py} ${../index/history.json} history.json

    python3 ${../tools/shard-by-attr.py} history.json $out/history
    python3 ${../tools/shard-by-attr.py} versions.json $out/versions
    python3 ${../tools/attr-names.py} versions.json $out/names.json

    # Copy pre-rendered documentation from docs.nix
    mkdir -p $out/docs
    cp -r ${pkgs.multiverse-docs}/* $out/docs/

    # site/robots.txt points a crawler at this.
    python3 ${../tools/sitemap.py} ${siteOrigin} versions.json \
      ${../revisions.json} ${../releases.json} $out/docs $out/sitemap.xml \
      ${toString sitemapPackages}

    # The whole index, which only the revisions tab needs: "what is pinned at
    # this revision" is a question about every attribute at once, and no shard
    # can answer it. Fetched when a revision row is opened, never at boot.
    cp versions.json $out/versions.json

    # Copy pre-rendered store data products from store-data.nix
    cp -r ${pkgs.multiverse-store-data}/* $out/

    # The social-card image the og:/twitter: meta tags point at.
    cp ${../multiverse_lotr.jpg} $out/multiverse_lotr.jpg
  ''
