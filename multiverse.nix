# A nixpkgs multiverse: every indexed revision reachable from a single evaluation.
#
# Revisions are *fetched*, not vendored. A revision fetched into the store
# yields byte-identical derivations to a checked-out tree — store paths derive
# from content and basename, never from location or fetcher — so everything
# Hydra built stays a cache hit while the repo itself holds only an index.
#
# Two properties shape this file:
#
#   1. The version axis must never become top-level attributes. Nix parses a
#      file in full before it can look anything up in it, so a flat attrset of
#      every (package, version) pair would be paid for by every evaluation,
#      including ones that touch nothing.
#
#   2. Cost is per *revision touched*, not per package. Revisions are memoised
#      below so that asking for five packages out of one revision instantiates
#      it exactly once. Revisions nobody asks for are never fetched at all.
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
  # One ordered array of every known revision, oldest first. Releases are
  # ordinary entries carrying an extra `release` label ("25.05"); everything
  # else is a nixos-unstable channel bump. There is no separate release list —
  # a release is just a commit someone gave a nice name.
  revisions = builtins.fromJSON (builtins.readFile ./revisions.json);

  # { revisionCount, attrs = { attr = { version = <offset into revisions>; }; } }
  #
  # Only the NEWEST revision shipping each version is recorded. Keeping the full
  # list is what makes an index grow with revision count rather than with
  # content: a package that never changes version would otherwise accumulate one
  # entry per revision — ~47 KB for a single version of a single package at this
  # scale, and ~103 MB across the index. Newest-only projects to ~5.4 MB for the
  # same coverage.
  #
  # Newest is also the build-correct choice: the most patched build, and the one
  # Hydra produced most recently, so the most likely to still substitute.
  # "Which revisions *also* had this version" is a history question — it belongs
  # in tooling built from index/.per-rev, not in a file parsed on every eval.
  index = builtins.fromJSON (builtins.readFile ./index/versions.json);

  nRevs = builtins.length revisions;
  offsets = builtins.genList (i: i) nRevs;
  revAt = i: builtins.elemAt revisions i;

  # The index stores bare offsets, so it is only valid against the revision list
  # it was built from. Appending revisions is safe; reordering is not, and this
  # catches that rather than silently resolving to the wrong commit.
  checkedIndex =
    if (index.revisionCount or null) != nRevs then
      throw ''
        multiverse: index/versions.json was built against ${toString (index.revisionCount or 0)}
        revisions but revisions.json now has ${toString nRevs}. Re-run tools/build-index.sh.
      ''
    else
      index;

  attrIndex = checkedIndex.attrs;

  # A human handle for a revision: its release name if it has one, otherwise
  # date plus short rev, which is what you actually want to see for an
  # unstable bump.
  labelOf =
    i:
    let
      r = revAt i;
    in
    r.release or "${r.date}-${builtins.substring 0 12 r.rev}";

  # Release name -> offset. Only the labelled handful, so this stays small.
  releaseOffsets = builtins.listToAttrs (
    builtins.concatMap (
      i:
      let
        r = revAt i;
      in
      if r ? release then
        [
          {
            name = r.release;
            value = i;
          }
        ]
      else
        [ ]
    ) offsets
  );

  # Newest revision dated on or before `date`. Revisions are date-ordered, so a
  # left fold keeping the last match is enough.
  offsetOnOrBefore =
    date: builtins.foldl' (acc: i: if (revAt i).date <= date then i else acc) null offsets;

  # First revision whose commit hash starts with `sha`.
  offsetOfRev =
    sha:
    builtins.foldl' (
      acc: i:
      if acc != null then
        acc
      else if builtins.substring 0 (builtins.stringLength sha) (revAt i).rev == sha then
        i
      else
        acc
    ) null offsets;

  # `at` accepts a release name, a YYYY-MM-DD date, or a commit hash prefix.
  resolve =
    sel:
    if releaseOffsets ? ${sel} then
      releaseOffsets.${sel}
    else if builtins.match "[0-9]{4}-[0-9]{2}-[0-9]{2}" sel != null then
      let
        i = offsetOnOrBefore sel;
      in
      if i == null then throw "multiverse: no revision on or before ${sel}" else i
    else
      let
        i = offsetOfRev sel;
      in
      if i == null then
        throw "multiverse: '${sel}' is not a release name, a YYYY-MM-DD date, or a known commit"
      else
        i;

  pathFor =
    i:
    let
      r = revAt i;
    in
    if fetcher == "local" then
      builtins.fetchGit {
        url = nixpkgsSource;
        rev = r.rev;
        allRefs = true;
      }
    else if r ? narHash then
      builtins.fetchTree {
        type = "github";
        owner = "NixOS";
        repo = "nixpkgs";
        rev = r.rev;
        inherit (r) narHash;
      }
    else
      throw "multiverse: revision ${labelOf i} has no narHash; re-run tools/build-index.sh or use fetcher = \"local\"";

  # Memoise per revision, keyed by offset. listToAttrs is lazy in its values, so
  # building this costs one thunk per revision and fetches nothing.
  instances = builtins.listToAttrs (
    map (i: {
      name = toString i;
      value = import (pathFor i) { inherit system config overlays; };
    }) offsets
  );

  versionsFor = attr: attrIndex.${attr} or { };

  # `builtins.attrNames` sorts lexicographically, which puts 3.12.10 before
  # 3.12.7. Sort with the version-aware comparator instead. Deliberately uses
  # only builtins: reaching for `lib.sort` would mean instantiating a revision
  # just to order a list of strings.
  sortVersions = builtins.sort (a: b: builtins.compareVersions a b < 0);
in
rec {
  inherit revisions index;

  # Human handles for every revision, oldest first.
  revs = map labelOf offsets;

  # Just the named releases.
  releases = builtins.attrNames releaseOffsets;

  # A whole nixpkgs, as it was at that revision.
  #   at "25.05"        release name
  #   at "2024-06-12"   newest revision on or before that date
  #   at "aae12a743f75" commit hash prefix
  at = sel: instances.${toString (resolve sel)};

  # The newest revision this index knows, as a real nixpkgs — `lib`,
  # `callPackage`, and a package set that is internally consistent, which is
  # what `latest` deliberately is not.
  #
  # Named for the tip of the *index*, not the tip of the channel. It is frozen
  # at whatever the last indexing run captured and drifts further behind
  # nixos-unstable every day until the index is rebuilt. If you want the live
  # channel, add a nixpkgs input; multiverse is for reaching backwards.
  tip = instances.${toString (nRevs - 1)};

  # Every known version of an attribute, oldest first.
  versionsOf = attr: sortVersions (builtins.attrNames (versionsFor attr));

  # The revision a given version resolves to, as a human handle.
  revOf =
    attr: ver:
    let
      i = (versionsFor attr).${ver} or null;
    in
    if i == null then null else labelOf i;

  # The headline operation: a specific version of a package. Distinct graphs
  # coexist happily — Nix keeps them disjoint, so several versions of the same
  # package can sit in one buildEnv.
  version =
    attr: ver:
    let
      i = (versionsFor attr).${ver} or null;
      known = versionsOf attr;
    in
    if i == null then
      throw ''
        multiverse: no revision provides ${attr} ${ver}.
        Known versions: ${
          if known == [ ] then "(attribute not in index)" else builtins.concatStringsSep " " known
        }
      ''
    else
      instances.${toString i}.${attr};

  # Materialised {attr -> {version -> derivation}}, so plain flake installable
  # syntax works — `nix shell .#versions.python3."3.8.9"` — which the function
  # API above cannot express, because a flake attribute path takes no arguments.
  #
  # `mapAttrs` is lazy in its values, so forcing one version instantiates
  # exactly one revision and leaves every other pair an untouched thunk.
  versions = builtins.mapAttrs (
    attr: vers: builtins.mapAttrs (ver: _: version attr ver) vers
  ) attrIndex;

  # Newest known version of each attribute, as a plain attrset so it works as a
  # flake installable:
  #
  #   nix run 'github:fzakaria/nixpkgs-multiverse#latest.python3'
  #   mv.latest.python3
  #
  # A sibling attrset rather than a `latest` key inside `versions.<pkg>`: that
  # would mix an alias into keys that are otherwise version strings, and would
  # collide with any package whose upstream literally ships a version called
  # "latest" (`relibc` does). Here the two namespaces never touch.
  #
  # `mapAttrs` is lazy in its values, so this costs one thunk per attribute and
  # resolves nothing until asked.
  latest = builtins.mapAttrs (
    attr: vers:
    let
      sorted = sortVersions (builtins.attrNames vers);
    in
    version attr (builtins.elemAt sorted (builtins.length sorted - 1))
  ) attrIndex;
}
