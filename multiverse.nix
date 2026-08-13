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
  # Only consulted by the "local" fetcher, which cannot guess where a clone
  # lives, so there is no default worth having.
  nixpkgsSource ? null,
}:

let
  # One ordered array of every known revision, oldest first: every entry is a
  # nixos-unstable channel bump. Append-only and immutable, because
  # index/versions.json addresses it by offset — see checkedIndex below.
  revisions = builtins.fromJSON (builtins.readFile ./revisions.json);

  # { "26.05" = { rev, date, build, name }; ... } — the current tip of each
  # release channel, which is a different kind of thing entirely.
  #
  # A release moves. Backports land on release-26.05 for the whole life of the
  # release, and `at "26.05"` follows them, exactly as
  # github:NixOS/nixpkgs/nixos-26.05 does. That is why these are not entries in
  # revisions.json: an offset there must mean the same tree forever, or every
  # version the index recorded against it becomes a claim about a tree that has
  # moved on. Nothing here is ever indexed, so nothing here can go stale.
  releaseTable = builtins.fromJSON (builtins.readFile ./releases.json);

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
  #
  # Covering *fewer* revisions than revisions.json holds is the ordinary state
  # between an append and the indexing run that catches up to it — the offsets
  # already recorded still point where they did. Only a count that runs past the
  # end of the array proves the two files disagree about what offset 0 is.
  checkedIndex =
    if (index.revisionCount or null) == null || index.revisionCount > nRevs then
      throw ''
        multiverse: index/versions.json was built against ${toString (index.revisionCount or 0)}
        revisions but revisions.json now has ${toString nRevs}. Re-run tools/build-index.sh.
      ''
    else
      index;

  attrIndex = checkedIndex.attrs;

  # A human handle for a revision: date plus short rev. Release names are
  # deliberately not used here — a release name resolves to a moving channel
  # tip, so labelling a fixed offset with one would name a tree that `at` no
  # longer returns.
  labelOf =
    i:
    let
      r = revAt i;
    in
    "${r.date}-${builtins.substring 0 12 r.rev}";

  # Newest revision dated on or before `date`. Revisions are date-ordered, so a
  # left fold keeping the last match is enough.
  offsetOnOrBefore =
    date: builtins.foldl' (acc: i: if (revAt i).date <= date then i else acc) null offsets;

  # "08" is not valid JSON — leading zeros are forbidden — so the month and day
  # fields cannot go straight through fromJSON.
  toInt =
    s:
    builtins.fromJSON (
      if builtins.substring 0 1 s == "0" && builtins.stringLength s > 1 then
        builtins.substring 1 (builtins.stringLength s - 1) s
      else
        s
    );

  # A YYYY-MM-DD date as a day number, so two dates can be subtracted. This is
  # Howard Hinnant's days_from_civil: shift the year to start in March, which
  # puts the leap day last and makes the month-length pattern regular, then
  # count eras of 400 years. Nix divides integers by truncation, and every date
  # here is well after 1970, so the negative-year branch never runs.
  dayOf =
    date:
    let
      parts = builtins.match "([0-9]{4})-([0-9]{2})-([0-9]{2})" date;
      y0 = toInt (builtins.elemAt parts 0);
      m = toInt (builtins.elemAt parts 1);
      d = toInt (builtins.elemAt parts 2);
      y = if m <= 2 then y0 - 1 else y0;
      era = y / 400;
      yoe = y - era * 400;
      doy = (153 * (m + (if m > 2 then -3 else 9)) + 2) / 5 + d - 1;
      doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    in
    if parts == null then
      throw "multiverse: '${date}' is not a YYYY-MM-DD date"
    else
      era * 146097 + doe - 719468;

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

  # Offset for a YYYY-MM-DD date, a commit hash prefix, or a revision label
  # (`YYYY-MM-DD-<hex>`, the handle revOf and revs hand out, so their output
  # feeds straight back in). Release names never reach here — `at` resolves
  # those against releases.json, which is not part of this array.
  resolve =
    sel:
    let
      labelParts = builtins.match "([0-9]{4}-[0-9]{2}-[0-9]{2})-([0-9a-f]+)" sel;
    in
    if labelParts != null then
      # A label names an exact revision, so resolve the commit prefix and
      # ignore the date half — decoration, not a search key.
      let
        i = offsetOfRev (builtins.elemAt labelParts 1);
      in
      if i == null then throw "multiverse: no revision matches label '${sel}'" else i
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
        throw "multiverse: '${sel}' is not a release name, a YYYY-MM-DD date, a revision label, or a known commit"
      else
        i;

  pathFor =
    i:
    let
      r = revAt i;
    in
    if fetcher == "local" && nixpkgsSource == null then
      throw "multiverse: fetcher = \"local\" needs nixpkgsSource set to a nixpkgs clone"
    else if fetcher == "local" then
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

  # Whether a revision can be turned into a tree at all. The github fetcher
  # needs a narHash, and a revision appended by fetch-unstable-revisions.sh has
  # none until build-index.sh reaches it. Asking for such a revision by name is
  # still an error — pathFor says so plainly — but nothing should *land* on one
  # by walking off the end of the array.
  materialisable = i: fetcher == "local" || (revAt i) ? narHash;

  newestMaterialisable = builtins.foldl' (acc: i: if materialisable i then i else acc) null offsets;

  # The offset `tip` and `flakeAt "tip"` resolve to, with the empty-index
  # failure named once instead of at every call site.
  checkedTipOffset =
    if newestMaterialisable == null then
      throw "multiverse: no revision has a narHash; run tools/build-index.sh"
    else
      newestMaterialisable;

  # A selector's date, read straight out of revisions.json or releases.json.
  # Nothing is materialised to answer this, which is the whole reason a window
  # takes a selector rather than a package set: provenance rides *on* a package
  # set, so reading a date off one means fetching that entire revision first.
  dateOfSelector =
    sel:
    if sel == "tip" then
      if newestMaterialisable == null then
        throw "multiverse: no revision has a narHash; run tools/build-index.sh"
      else
        (revAt newestMaterialisable).date
    else if releaseTable ? ${sel} then
      releaseTable.${sel}.date
    else
      (revAt (resolve sel)).date;

  # Newest materialisable revision at least `days` older than `date`, as an
  # instance. Always searches the unstable revision list: an anchor only
  # supplies the date, so `behind "26.05" 7` means "unstable as it stood a week
  # before the 26.05 channel tip", not a walk back along release-26.05.
  instanceBehind =
    date: days:
    let
      cutoff = dayOf date - days;
      i = builtins.foldl' (
        acc: i: if materialisable i && dayOf (revAt i).date <= cutoff then i else acc
      ) null offsets;
    in
    if i == null then
      throw "multiverse: nothing is ${toString days} days before ${date}; the index reaches back to ${(revAt 0).date}"
    else
      instances.${toString i};

  # nixpkgs only grew an `overlays` argument in 17.03 — 16.09 takes exactly
  # { config, system } — and handing a function an argument it does not declare
  # is a hard error, not an ignored extra. Every revision is imported through
  # here so that the argument is offered only where it is accepted.
  importRevision =
    path:
    let
      entry = import path;
      accepted = builtins.functionArgs entry;
    in
    if accepted ? overlays then
      entry { inherit system config overlays; }
    else if overlays == [ ] then
      entry { inherit system config; }
    else
      throw "multiverse: this revision predates the `overlays` argument, which nixpkgs gained in 17.03, so it cannot take the overlays you passed";

  # Every package set carries where it came from. An imported nixpkgs has no
  # idea which revision produced it — `lib.version` reads "26.11pre-git" for a
  # fetched tree, and `path` is content-addressed — so without this, `at` hands
  # back something you cannot ask any further questions about, and `behind`
  # could only ever take a selector rather than a package set.
  tagged = provenance: pkgs: pkgs // { multiverse = provenance; };

  # Memoise per revision, keyed by offset. listToAttrs is lazy in its values, so
  # building this costs one thunk per revision and fetches nothing.
  instances = builtins.listToAttrs (
    map (i: {
      name = toString i;
      value = tagged {
        inherit (revAt i) rev date;
        label = labelOf i;
      } (importRevision (pathFor i));
    }) offsets
  );

  # Release tips carry no narHash and need none: for type = "github" a full
  # commit hash is itself the lock, and fetchTree accepts it under pure
  # evaluation. That is what keeps refreshing releases.json free — it never has
  # to download a tree just to hash it.
  pathForRelease =
    r:
    if fetcher == "local" && nixpkgsSource == null then
      throw "multiverse: fetcher = \"local\" needs nixpkgsSource set to a nixpkgs clone"
    else if fetcher == "local" then
      builtins.fetchGit {
        url = nixpkgsSource;
        rev = r.rev;
        allRefs = true;
      }
    else
      builtins.fetchTree {
        type = "github";
        owner = "NixOS";
        repo = "nixpkgs";
        rev = r.rev;
      };

  # Memoised the same way as instances, and just as lazy: naming a release
  # costs a thunk, forcing one costs a fetch.
  releaseInstances = builtins.mapAttrs (
    name: r: tagged (r // { release = name; }) (importRevision (pathForRelease r))
  ) releaseTable;

  # A fetched revision as a *flake* attrset: the value `inputs.nixpkgs` would
  # have been, had the revision been declared as a flake input. Shaped after
  # what Nix's own call-flake.nix constructs — outputs first, then sourceInfo,
  # so source metadata wins any collision, then the bookkeeping attributes.
  # `pathFor` and `pathForRelease` both return a fetcher result, which is
  # exactly the sourceInfo attrset this needs (outPath, rev, narHash,
  # lastModified, ...).
  #
  # config and overlays deliberately do NOT apply here: a real flake input
  # never sees the consumer's nixpkgs config, so neither does this one. Use
  # `at` for a configured package set.
  mkFlakeInstance =
    provenance: sourceInfo:
    let
      # nixpkgs' own flake.nix has taken exactly `{ self }` since it appeared
      # in 20.03, so this fix-point is all call-flake.nix does for it. Trees
      # older than that get the two outputs the nixpkgs flake is consumed
      # through, synthesised the same vanilla way the real flake.nix builds
      # them.
      outputs =
        if builtins.pathExists (sourceInfo.outPath + "/flake.nix") then
          (import (sourceInfo.outPath + "/flake.nix")).outputs { self = result; }
        else
          {
            lib = import (sourceInfo.outPath + "/lib");
            legacyPackages.${system} = import sourceInfo.outPath { inherit system; };
          };

      result =
        outputs
        // sourceInfo
        // {
          inherit (sourceInfo) outPath;
          inputs = { };
          inherit outputs sourceInfo;
          _type = "flake";
          multiverse = provenance;
        };
    in
    result;

  # Memoised like `instances`, and for the same reason: two flakeAt calls that
  # land on the same offset share one import.
  flakeInstances = builtins.listToAttrs (
    map (i: {
      name = toString i;
      value = mkFlakeInstance {
        inherit (revAt i) rev date;
        label = labelOf i;
      } (pathFor i);
    }) offsets
  );

  releaseFlakeInstances = builtins.mapAttrs (
    name: r: mkFlakeInstance (r // { release = name; }) (pathForRelease r)
  ) releaseTable;

  # Releases as a two-level tree, split at the dot: "25.05" becomes
  # "25"."05". A release name cannot be a single flake attrpath segment
  # without quoting — the CLI splits on dots — so the split is what makes
  # `nix run .#25.05.python3` parse. A name that is not NN.NN-shaped is
  # skipped rather than crashing the whole tree over one odd channel.
  releaseTree = builtins.foldl' (
    acc: name:
    let
      parts = builtins.match "([0-9]+)\\.([0-9]+)" name;
      major = builtins.elemAt parts 0;
      minor = builtins.elemAt parts 1;
    in
    if parts == null then
      acc
    else
      acc
      // {
        ${major} = (acc.${major} or { }) // {
          ${minor} = releaseInstances.${name};
        };
      }
  ) { } (builtins.attrNames releaseTable);

  # Every revision under three exact-match keys: the full commit (what a
  # GitHub URL or a lock file hands you), the 12-character prefix (what
  # labels and `revs` display), and the label itself. All three alias the
  # memoised instance, so the whole set costs thunks, not fetches. Exact
  # match is the deal here — arbitrary prefixes and date rounding stay with
  # `at`, which can search; an attrset can only look up.
  revisionKeys = builtins.listToAttrs (
    builtins.concatMap (
      i:
      let
        r = revAt i;
        value = instances.${toString i};
      in
      [
        {
          name = r.rev;
          inherit value;
        }
        {
          name = builtins.substring 0 12 r.rev;
          inherit value;
        }
        {
          name = labelOf i;
          inherit value;
        }
      ]
    ) offsets
  );

  versionsFor = attr: attrIndex.${attr} or { };

  # `builtins.attrNames` sorts lexicographically, which puts 3.12.10 before
  # 3.12.7. Sort with the version-aware comparator instead. Deliberately uses
  # only builtins: reaching for `lib.sort` would mean instantiating a revision
  # just to order a list of strings.
  sortVersions = builtins.sort (a: b: builtins.compareVersions a b < 0);

  # When each version was present, as run-length ranges of revision offsets —
  # the timeline `index` deliberately does not carry, since it keeps only the
  # newest revision per version.
  history = builtins.fromJSON (builtins.readFile ./index/history.json);

  # Same offsets-are-only-valid-against-the-list-they-were-built-from guard the
  # index gets. History is written by tools/build-history.sh from the same
  # extraction cache, so the two files should agree; disagreeing with
  # revisions.json is what proves one of them is stale.
  checkedHistory =
    if (history.revisionCount or null) == null || history.revisionCount > nRevs then
      throw ''
        multiverse: index/history.json was built against ${toString (history.revisionCount or 0)}
        revisions but revisions.json now has ${toString nRevs}. Re-run tools/build-history.sh.
      ''
    else
      history;

  # On disk a version with one unbroken run is stored as [first, last] and one
  # with gaps as a list of those pairs — 91.6% of pairs are single-run, so the
  # collapse is most of a megabyte. Everything below works on the expanded form.
  runsOf =
    attr: ver:
    let
      raw = (checkedHistory.attrs.${attr} or { }).${ver} or null;
    in
    if raw == null then
      null
    else if builtins.isList (builtins.head raw) then
      raw
    else
      [ raw ];

  # Revisions inside the covered prefix that were never extracted, so a gap in a
  # run can be told apart from a revision nobody ever looked at.
  skipped = checkedHistory.skipped;
in
rec {
  # `history` is the raw file; forcing it is what parses it, so naming it here
  # costs nothing until something reads it.
  inherit revisions index history;

  # Human handles for every revision, oldest first.
  revs = map labelOf offsets;

  # Every release channel being tracked, oldest first.
  releases = builtins.attrNames releaseTable;

  # The raw release table: what commit each channel is currently at, and when.
  releaseTips = releaseTable;

  # A whole nixpkgs.
  #   at "25.05"        the release channel as it stands TODAY, backports and
  #                     all — a moving target, like nixos-25.05 itself
  #   at "2024-06-12"   newest revision on or before that date — fixed forever
  #   at "aae12a743f75" commit hash prefix — fixed forever
  #   at "2021-07-18-967d40bec14b"
  #                     a revision label, as revOf and revs hand out — fixed
  #                     forever, so revOf's answer feeds straight back in
  at =
    sel:
    if sel == "tip" then
      tip
    else if releaseTable ? ${sel} then
      releaseInstances.${sel}
    else
      instances.${toString (resolve sel)};

  # The newest revision this index knows, as a real nixpkgs — `lib`,
  # `callPackage`, and a package set that is internally consistent, which is
  # what `latest` deliberately is not.
  #
  # Named for the tip of the *index*, not the tip of the channel. It is frozen
  # at whatever the last indexing run captured and drifts further behind
  # nixos-unstable every day until the index is rebuilt. If you want the live
  # channel, add a nixpkgs input; multiverse is for reaching backwards.
  #
  # The newest *materialisable* revision rather than the last one on file:
  # between an append and the indexing run that catches up to it, the last few
  # entries have no narHash and cannot be fetched. `tip` is a promise to hand
  # back a working nixpkgs, so it walks back to the newest one that is.
  tip = instances.${toString checkedTipOffset};

  # A whole nixpkgs as the flake attrset `inputs.nixpkgs` would have been —
  # same selectors as `at`, but the flake shape instead of a package set:
  #
  #   (flakeAt "26.05").lib.nixosSystem { ... }
  #   (flakeAt "26.05").legacyPackages.${system}.hello
  #
  # This is what flake-world entry points consume. `nixosSystem` in particular
  # only exists on the nixpkgs *flake* — a package set's `lib` does not have
  # it — and it stamps `nixpkgs.flake.source` from `self`, so registry and
  # NIX_PATH pinning point at the real fetched tree. Source metadata (rev,
  # narHash, lastModified) rides along for the same reason.
  flakeAt =
    sel:
    if sel == "tip" then
      flakeInstances.${toString checkedTipOffset}
    else if releaseTable ? ${sel} then
      releaseFlakeInstances.${sel}
    else
      flakeInstances.${toString (resolve sel)};

  # A soak period: the whole of nixos-unstable as it stood some number of days
  # before an anchor. The anchor is any selector `at` takes:
  #
  #   daysBehind "tip" 7            a week behind the newest indexed revision
  #   daysBehind "26.05" 7          a week before the 26.05 channel tip
  #   daysBehind "2026-05-30" 7     a week before that date
  #   daysBehind "aae12a743f75" 30  a month before that commit landed
  daysBehind = sel: days: instanceBehind (dateOfSelector sel) days;

  # Every known version of an attribute, oldest first.
  versionsOf = attr: sortVersions (builtins.attrNames (versionsFor attr));

  # ---------------------------------------------------------------------------
  # History. Everything below reads index/history.json rather than the index,
  # and nothing above touches it — see the `history` binding for why that split
  # is load-bearing rather than tidiness.
  # ---------------------------------------------------------------------------

  # When a version was present, as dates and labels rather than raw offsets:
  #
  #   lifetimeOf "python3" "3.8.9"
  #   => { earliest = "2021-03-02"; latest = "2021-11-14";
  #        earliestLabel = "2021-03-02-…"; latestLabel = "2021-11-14-…";
  #        runs = [ { first = …; last = …; … } ]; }
  #
  # null for a pair the history does not know.
  #
  # Two levels, named apart because they claim different things. `earliest` and
  # `latest` are the outer bounds of every sighting — the version was seen at
  # each of those dates, and nothing is asserted about the span between them.
  # `runs` are the unbroken stretches, so a run's `first`/`last` really are the
  # ends of a range the version held throughout.
  lifetimeOf =
    attr: ver:
    let
      rs = runsOf attr ver;
      spans = map (r: {
        first = (revAt (builtins.elemAt r 0)).date;
        last = (revAt (builtins.elemAt r 1)).date;
        firstLabel = labelOf (builtins.elemAt r 0);
        lastLabel = labelOf (builtins.elemAt r 1);
      }) (if rs == null then [ ] else rs);
      firstRun = builtins.head spans;
      lastRun = builtins.elemAt spans (builtins.length spans - 1);
    in
    if rs == null then
      null
    else
      {
        earliest = firstRun.first;
        earliestLabel = firstRun.firstLabel;
        latest = lastRun.last;
        latestLabel = lastRun.lastLabel;
        runs = spans;
      };

  # Every version an attribute ever had, with its lifetime, oldest version
  # first. The timeline for one package, answered without fetching anything.
  historyOf =
    attr:
    map (ver: { inherit ver; } // lifetimeOf attr ver) (
      sortVersions (builtins.attrNames (checkedHistory.attrs.${attr} or { }))
    );

  # What version an attribute had at a given revision — the question the
  # newest-only index cannot answer at all, and which otherwise costs a ~378 MB
  # fetch of the whole revision just to read one `.version`.
  #
  #   versionAt "python3" "2022-03-15"  => "3.9.10"
  #
  # Takes the same selectors `at` does, minus releases: a release tip is a
  # moving channel head rather than an indexed offset, so there is no honest
  # answer to give for one.
  versionAt =
    attr: sel:
    let
      off = if sel == "tip" then checkedTipOffset else resolve sel;
      vers = builtins.attrNames (checkedHistory.attrs.${attr} or { });
      covers =
        ver: builtins.any (r: builtins.elemAt r 0 <= off && off <= builtins.elemAt r 1) (runsOf attr ver);
      hits = builtins.filter covers vers;
    in
    if releaseTable ? ${sel} then
      throw ''
        multiverse: versionAt cannot take the release "${sel}". A release is a channel
        tip that moves, not a revision the index has an offset for. Select by date or
        commit, or read the version off the package set: (at "${sel}").${attr}.version
      ''
    else if hits == [ ] then
      null
    else
      builtins.head hits;

  # When an attribute was last seen, or null if it is still in the newest
  # revision the history covers. This is what makes "whatever happened to
  # `foo`" answerable, and the label it returns feeds straight back into `at`
  # to get a working derivation out of the last revision that had it:
  #
  #   goneSince "python2"  => { date = "2026-05-30"; label = "2026-05-30-…";
  #                             version = "2.7.18.12"; }
  #
  # An attribute the history has never seen throws rather than answering null.
  # Null has to mean "still here", and quietly returning it for a name that was
  # never in nixpkgs — or for a package set like `gnome3`, which has no
  # `.version` and so was never indexed — would report the two as the same.
  goneSince =
    attr:
    let
      vers = builtins.attrNames (checkedHistory.attrs.${attr} or { });
      lastOffOf =
        ver:
        let
          rs = runsOf attr ver;
        in
        builtins.elemAt (builtins.elemAt rs (builtins.length rs - 1)) 1;
      newest = builtins.foldl' (
        acc: v: if acc == null || lastOffOf v > lastOffOf acc then v else acc
      ) null vers;
    in
    if vers == [ ] then
      throw ''
        multiverse: ${attr} is not in the history index, so there is no last sighting
        to report. Attributes without a `.version` — package sets such as `gnome3` —
        are never indexed, and neither are nested sets like `python3Packages.*`.
      ''
    else if lastOffOf newest >= checkedHistory.revisionCount - 1 then
      null
    else
      {
        date = (revAt (lastOffOf newest)).date;
        label = labelOf (lastOffOf newest);
        version = newest;
      };

  # Revisions inside the covered prefix that were never extracted. A gap in a
  # run means "absent"; an offset in here means "never looked", and the two are
  # not the same claim.
  skippedRevisions = map labelOf skipped;

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

  # A lock file written by `mvs lock`, resolved to derivations:
  #
  #   readLock ./multiverse.lock  =>  { helix = <derivation>; ripgrep = <derivation>; }
  #
  # Each pin names one revision by commit and is resolved on its own, which is
  # the property a flake input cannot have: `mvs lock update helix` moves exactly
  # that entry and leaves every other pin where it was.
  #
  # `mapAttrs` is lazy in its values, so a lock with twenty pins materialises
  # only the revisions behind the packages actually built.
  readLock =
    file:
    let
      lock = builtins.fromJSON (builtins.readFile file);

      # A pin is only ever a commit plus decoration. `label`, `version` and
      # `date` are there for the reader and for `mvs lock status`; `rev` is the
      # only field that decides which tree comes back, so a hand-edited version
      # string cannot quietly change what gets built.
      resolvePin =
        attr: pin:
        let
          pkgs = at pin.rev;
        in
        if !(pin ? rev) then
          throw "multiverse: the pin for ${attr} in ${toString file} has no `rev`"
        else if !(pkgs ? ${attr}) then
          throw ''
            multiverse: ${attr} is pinned to ${pin.rev} but that revision has no such
            attribute. Only top-level attributes can be pinned — nested sets like
            python3Packages.* are not in the index and cannot be named in a lock file.
          ''
        else
          pkgs.${attr};
    in
    if (lock.version or null) != lockVersion then
      throw ''
        multiverse: ${toString file} is lock format version ${toString (lock.version or 0)},
        and this multiverse reads version ${toString lockVersion}.
      ''
    else
      builtins.mapAttrs resolvePin (lock.pins or { });

  # The lock format `readLock` accepts and `mvs lock` writes. Bumped only for a
  # change an older reader would misinterpret; a new optional field is not one.
  lockVersion = 1;

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

  # Exact-match keys for flake attrpaths. flake.nix merges these into
  # legacyPackages, which is what lets plain installable syntax name a
  # revision — every key below avoids dots, so none of it needs quoting:
  #
  #   nix run .#25.05.python3                                  release
  #   nix run .#2021-07-18-967d40bec14b.python3                label
  #   nix run .#967d40bec14b.python3                           12-char prefix
  #   nix run .#967d40bec14be87262b21ab901dbace23b7365db.hello full commit
  #
  # A sibling attrset rather than keys in the API itself, so `builtins.attrNames`
  # on a multiverse stays readable and repl completion stays usable.
  installables = releaseTree // revisionKeys;
}
