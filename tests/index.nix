# Tests the index-backed query API — versionsOf, revOf, releases, revisions —
# against the committed JSON files, by evaluating this file strictly:
#
#   nix eval --json -f tests/index.nix --apply 'f: f { }'
#
# Nothing here fetches a tree, so the test runs anywhere, offline included.
{
  system ? "x86_64-linux",
}:
let
  mv = import ../multiverse.nix { inherit system; };

  versions = mv.versionsOf "python3";
  count = builtins.length versions;

  # True when every adjacent pair of `versions` ascends under the
  # version-aware comparator, i.e. versionsOf really is sorted.
  sorted = builtins.all (
    i: builtins.compareVersions (builtins.elemAt versions i) (builtins.elemAt versions (i + 1)) < 0
  ) (builtins.genList (i: i) (count - 1));

  # A revision label is a date plus a 12-character commit prefix.
  labelPattern = "[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{12}";

  # Not reached through multiverse.nix, which never reads it: stats.json exists
  # for the site's charts. It is still committed data derived from the same
  # revisions, so it is held to the same count.
  stats = builtins.fromJSON (builtins.readFile ../index/stats.json);
in

# python3 predates the start of the index, so a thin result here means the
# index is broken, not that the package is niche.
assert count > 10;
assert sorted;

# revOf answers with a revision label for a version the index knows, and with
# null for one it does not.
assert builtins.match labelPattern (mv.revOf "python3" (builtins.head versions)) != null;
assert mv.revOf "python3" "0.0.0-not-a-version" == null;

# Every tracked release appears in the release table.
assert builtins.length mv.releases > 20;
assert builtins.all (r: mv.releaseTips ? ${r}) mv.releases;

# The revision array is date-ordered oldest first, which offsetOnOrBefore
# (and therefore every date selector) depends on.
assert builtins.all (
  i: (builtins.elemAt mv.revisions i).date <= (builtins.elemAt mv.revisions (i + 1)).date
) (builtins.genList (i: i) (builtins.length mv.revisions - 1));

# Every committed file covers exactly the same revisions.
#
# multiverse.nix and mvs both *tolerate* an index that stops short of
# revisions.json, because that is a real intermediate state of a checkout
# between appending a revision and indexing it. Nothing committed is ever
# allowed to be in it: tools/build-index.sh exits non-zero on a partial
# incremental run, which fails the update job before it can commit the pair.
# This is where that stops being a property of the pipeline and starts being a
# property of the repository — the tolerance downstream means a file that falls
# behind produces answers that are merely stale rather than wrong, so nothing
# else would ever fail and say so.
#
# index/stats.json is the one that proved this necessary: nothing rebuilt it for
# a day, and it sat two revisions behind the history it aggregates while every
# other check passed.
assert mv.index.revisionCount == builtins.length mv.revisions;
assert mv.history.revisionCount == builtins.length mv.revisions;
assert stats.revisionCount == builtins.length mv.revisions;

{
  pythonVersions = count;
  releases = builtins.length mv.releases;
  revisions = builtins.length mv.revisions;
}
