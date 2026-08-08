# A nixpkgs multiverse: every indexed revision reachable from a single evaluation.
#
# Revisions are *fetched*, not vendored. `builtins.fetchGit` against a nixpkgs
# clone yields byte-identical derivations to a checked-out tree — store paths
# derive from content and basename, never from location — so everything Hydra
# built stays a cache hit while the repo itself holds only an index.
#
# Two properties shape this file:
#
#   1. The version axis must never become top-level attributes. Nix parses a
#      file in full before it can look anything up in it, so a flat attrset of
#      every (package, version) pair would be paid for by every evaluation,
#      including ones that touch nothing. The index is JSON, read lazily.
#
#   2. Cost is per *revision touched*, not per package. Revisions are memoised
#      below so that asking for five packages out of 24.11 instantiates 24.11
#      exactly once. Revisions nobody asks for are never fetched at all.
{
  system ? builtins.currentSystem,
  config ? { },
  overlays ? [ ],
  # How to materialise a revision.
  #   "github" — builtins.fetchTree against NixOS/nixpkgs, pinned by narHash.
  #              Pure-eval safe and portable, so this is what flake.nix uses.
  #   "local"  — builtins.fetchGit against a local clone. Fully offline, and
  #              faster when a clone is already on disk, but an absolute path
  #              outside the tree is rejected under pure evaluation.
  # Both produce byte-identical derivations; verified against 25.05.
  fetcher ? "github",
  nixpkgsSource ? "/home/fmzakari/code/github.com/NixOS/nixpkgs",
}:

let
  # {name -> {rev, date}} — the set of revisions this multiverse knows about.
  revisions = builtins.fromJSON (builtins.readFile ./revisions.json);

  # {attr -> {version -> [revname, ...]}}, revisions ascending.
  # Nothing below forces this unless a version lookup actually happens.
  index = builtins.fromJSON (builtins.readFile ./index/versions.json);

  revNames = builtins.attrNames revisions;

  # Resolve a revision name to a store path. Fetches land in the store and are
  # reused across evaluations, so the second use of a revision costs nothing.
  pathFor =
    name:
    let
      meta = revisions.${name};
    in
    if fetcher == "local" then
      builtins.fetchGit {
        url = nixpkgsSource;
        rev = meta.rev;
        allRefs = true;
      }
    else if meta ? narHash then
      builtins.fetchTree {
        type = "github";
        owner = "NixOS";
        repo = "nixpkgs";
        rev = meta.rev;
        inherit (meta) narHash;
      }
    else
      throw "multiverse: revision '${name}' has no narHash; run tools/add-narhashes.sh or use fetcher = \"local\"";

  importRev =
    name:
    if !(revisions ? ${name}) then
      throw "multiverse: unknown revision '${name}'. Known: ${builtins.concatStringsSep ", " revNames}"
    else
      import (pathFor name) { inherit system config overlays; };

  # Memoise per revision. listToAttrs is lazy in its values, so building this
  # map costs one thunk per revision and fetches nothing.
  instances = builtins.listToAttrs (
    map (name: {
      name = name;
      value = importRev name;
    }) revNames
  );

  versionsFor = attr: if index ? ${attr} then index.${attr} else { };

  # `builtins.attrNames` sorts lexicographically, which puts 3.12.10 before
  # 3.12.7. Sort with the version-aware comparator instead. Deliberately uses
  # only builtins: reaching for `lib.sort` would mean instantiating a revision
  # just to order a list of strings.
  sortVersions = builtins.sort (a: b: builtins.compareVersions a b < 0);
in
rec {
  # Revision names, and the full {rev, date} metadata.
  revs = revNames;
  inherit revisions index;

  # A whole nixpkgs, as it was at that release.
  at = name: instances.${name};

  # Every known version of an attribute, oldest first.
  versionsOf = attr: sortVersions (builtins.attrNames (versionsFor attr));

  # Which revisions provide a given version.
  revsFor = attr: version: (versionsFor attr).${version} or [ ];

  # The headline operation: a specific version of a package, taken from the
  # newest revision that shipped it. Distinct graphs coexist happily — Nix
  # keeps them disjoint, so several versions can sit in one buildEnv.
  version =
    attr: ver:
    let
      candidates = revsFor attr ver;
      known = versionsOf attr;
    in
    if candidates == [ ] then
      throw ''
        multiverse: no revision provides ${attr} ${ver}.
        Known versions: ${
          if known == [ ] then "(attribute not in index)" else builtins.concatStringsSep " " known
        }
      ''
    else
      (at (builtins.elemAt candidates (builtins.length candidates - 1))).${attr};

  # Materialised {attr -> {version -> derivation}}.
  #
  # This exists so the multiverse works with plain flake installable syntax —
  # `nix shell .#versions.python3."3.8.9"` — which the function-based API above
  # cannot express, because a flake attribute path cannot take arguments.
  #
  # It does not reintroduce the cost this design avoids: `mapAttrs` is lazy in
  # its values, so forcing one version instantiates exactly one revision and
  # leaves the other ~117k (attr, version) pairs as untouched thunks. The only
  # fixed cost is parsing the index, which `versionsOf` already pays.
  versions = builtins.mapAttrs (
    attr: vers: builtins.mapAttrs (ver: _: version attr ver) vers
  ) index;

  # Latest known version of an attribute.
  latest =
    attr:
    let
      vs = versionsOf attr;
    in
    if vs == [ ] then throw "multiverse: '${attr}' is not in the index" else version attr (builtins.elemAt vs (builtins.length vs - 1));
}
