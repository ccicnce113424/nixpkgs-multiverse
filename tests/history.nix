# Tests the history API — lifetimeOf, historyOf, versionAt, goneSince — against
# the committed index/history.json, by evaluating this file strictly:
#
#   nix eval --json -f tests/history.nix --apply 'f: f { }'
#
# Nothing here fetches a tree. That is the whole point of the history file: it
# answers when a version existed, and what a revision held, without
# materialising the revision to look.
{
  system ? "x86_64-linux",
}:
let
  mv = import ../multiverse.nix { inherit system; };

  # A version old enough that its lifetime is settled, so the expectations below
  # never have to move as the index grows.
  py = mv.lifetimeOf "python3" "3.8.9";

  # R cycled its default version back and forth in early 2019, so 3.5.2 has a
  # gap — two runs rather than one. This is why history stores a list of ranges
  # instead of the single [first, last] pair the design notes first considered:
  # that encoding would have claimed four unbroken months here.
  r = mv.lifetimeOf "R" "3.5.2";

  timeline = mv.historyOf "python3";

  labelPattern = "[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{12}";
  datePattern = "[0-9]{4}-[0-9]{2}-[0-9]{2}";
in

# History and the index must cover the same revisions. They are built from one
# extraction cache by two tools, and the CI job advances them in the same run —
# if they ever disagree, one of the two was committed without the other.
assert mv.history.revisionCount == mv.index.revisionCount;
assert mv.skippedRevisions == [ ];

# A lifetime reports earliest and latest sighting as dates, with the labels that
# feed back into `at`.
assert builtins.match datePattern py.earliest != null;
assert builtins.match labelPattern py.latestLabel != null;
assert py.earliest <= py.latest;
assert builtins.length py.runs == 1;

# For a single-run lifetime the outer bounds and the run's own ends are the same
# dates — the two only diverge once there is a gap, which is the next block.
assert py.earliest == (builtins.head py.runs).first;
assert py.latest == (builtins.head py.runs).last;

# A version the index does not know has no lifetime, rather than an empty one.
assert mv.lifetimeOf "python3" "0.0.0-not-a-version" == null;
assert mv.lifetimeOf "not-a-package-at-all" "1.0" == null;

# Gaps are real and are preserved: R 3.5.2 left nixpkgs and came back, so its
# outer bounds span more than the runs it is actually present for. This is the
# case the two naming levels exist for — `latest` is four months after
# `earliest`, and the version was absent for most of the middle.
assert builtins.length r.runs > 1;
assert r.earliest < r.latest;
assert (builtins.head r.runs).last < r.latest;

# Every run is ordered within itself, and the runs ascend without touching —
# two adjacent runs would have been merged into one.
assert builtins.all (run: run.first <= run.last) r.runs;
assert builtins.all (i: (builtins.elemAt r.runs i).last < (builtins.elemAt r.runs (i + 1)).first) (
  builtins.genList (i: i) (builtins.length r.runs - 1)
);

# The whole timeline for a package, oldest version first, every entry carrying
# both its version and its lifetime.
assert builtins.length timeline > 10;
assert (builtins.head timeline).ver == builtins.head (mv.versionsOf "python3");
assert builtins.all (e: e ? ver && e ? earliest && e ? latest && e ? runs) timeline;

# versionAt answers what a revision held, from the index alone. The version it
# names for a date must itself be live at that date.
assert mv.versionAt "python3" "2022-03-15" != null;
assert (mv.lifetimeOf "python3" (mv.versionAt "python3" "2022-03-15")).earliest <= "2022-03-15";

# The revision that revOf names for a version is one that version was live at,
# which ties the two indexes together.
assert mv.versionAt "python3" (mv.revOf "python3" "3.8.9") == "3.8.9";

# A release is a moving channel tip rather than an indexed offset, so there is
# no honest answer and versionAt says so instead of guessing.
assert !(builtins.tryEval (mv.versionAt "python3" "26.05")).success;

# goneSince: null while an attribute is still in the newest covered revision,
# a last sighting once it is not.
assert mv.goneSince "python3" == null;
assert
  (mv.goneSince "python2").date < (builtins.elemAt mv.revisions (mv.history.revisionCount - 1)).date;
assert builtins.match labelPattern (mv.goneSince "python2").label != null;

# An attribute that was never indexed is not the same claim as one that was
# removed, so it throws rather than answering null.
assert !(builtins.tryEval (mv.goneSince "gnome3")).success;

{
  revisionCount = mv.history.revisionCount;
  pythonLifetime = "${py.earliest}..${py.latest}";
  pythonVersionsWithHistory = builtins.length timeline;
  rRuns = builtins.length r.runs;
  python2GoneSince = (mv.goneSince "python2").date;
}
