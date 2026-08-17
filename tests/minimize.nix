# Tests pinPlan and solvePins — the fewest revisions serving a set of pins —
# against the committed index/history.json, by evaluating this file strictly:
#
#   nix eval --json -f tests/minimize.nix --apply 'f: f { }'
#
# Nothing here fetches a tree. A plan is decided entirely from the history
# file, which is what lets a configuration assert on one before anything is
# built.
#
# Every pin below is a version whose runs are closed, so the revisions these
# plans name are settled and cannot move as the index grows.
{
  system ? "x86_64-linux",
}:
let
  mv = import ../multiverse.nix { inherit system; };

  # The grouped-pin example from issue #9. All three versions were current on
  # 2023-09-25, and jq 1.6 is the one that ended first, so it forces the
  # revision and the other two are pulled back to it.
  grouped = mv.pinPlan {
    ripgrep = "13.0.0";
    fd = "8.7.0";
    jq = "1.6";
  };

  # Two pins that were never current at the same time. This used to be an
  # error; it is now a two-revision plan whose minimality the pins themselves
  # prove.
  split = mv.pinPlan {
    python3 = "3.6.1";
    ripgrep = "14.1.1";
  };

  single = mv.pinPlan { jq = "1.6"; };

  offsetsOf = plan: map (g: g.revision.off) plan.groups;
  pinsAt = group: map (p: p.attr) group.pins;
in

# Pins that can share a revision do, and the plan says so with one group.
assert grouped.revisions == 1;
assert
  pinsAt (builtins.head grouped.groups) == [
    "fd"
    "jq"
    "ripgrep"
  ];
assert (builtins.head grouped.groups).revision.label == "2023-09-25-6500b4580c2a";

# Minimising decides which revision serves a version, never which version is
# served: every pin comes back at exactly the version asked for.
assert
  map (p: p.version) (builtins.head grouped.groups).pins == [
    "8.7.0"
    "1.6"
    "13.0.0"
  ];

# The pin that forced the revision is the one that moved nowhere, and the
# others moved back by a stated amount. This is the cost of grouping, and it
# is reported per pin rather than left to be discovered at build time.
assert (builtins.head grouped.certificate) == "jq 1.6";
assert builtins.all (
  p: if p.attr == "jq" then p.movedDays == 0 else p.movedDays > 0
) (builtins.head grouped.groups).pins;

# A pin can never be moved outside its own version's run, so the displacement
# is bounded by how long that version was current.
assert builtins.all (p: p.movedRevisions >= 0) (builtins.head grouped.groups).pins;

# Two pins that never overlapped need two revisions, oldest group first.
assert split.revisions == 2;
assert
  offsetsOf split == [
    88
    1424
  ];
assert split.why == "python3 3.6.1 and ripgrep 14.1.1 never overlapped";

# The certificate names one pin per revision — the proof that a smaller plan
# cannot exist, checkable from the dates alone.
assert builtins.length split.certificate == split.revisions;

# One pin is one revision, at the newest that ships it, which is exactly what
# `version` resolves to on its own. Grouping must not change the answer for a
# set of one.
assert single.revisions == 1;
assert (builtins.head single.groups).revision.off == mv.index.attrs.jq."1.6";
assert single.why == "one revision serves every pin";

# solvePins hands back the derivations the plan describes, at the versions
# asked for.
assert
  (mv.solvePins {
    ripgrep = "13.0.0";
    jq = "1.6";
  }).ripgrep.version == "13.0.0";

# A version nothing ever shipped is an error rather than an empty plan: a
# caller must not get a plan that silently omits a pin. Forced through
# `revisions`, since tryEval on the attrset alone would never reach the throw.
assert !(builtins.tryEval (mv.pinPlan { ripgrep = "0.0.0"; }).revisions).success;

{
  grouped = {
    inherit (grouped) revisions why;
    offsets = offsetsOf grouped;
  };
  split = {
    inherit (split) revisions why certificate;
    offsets = offsetsOf split;
  };
}
