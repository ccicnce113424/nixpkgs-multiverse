#!/usr/bin/env python3
"""One-shot migration: drop the release branch-off commits from the index.

revisions.json used to carry 22 entries with `channel: "release-commit"` --
the commit each release branch was cut from. They were the addressable form of
`at "16.03"` before releases.json took that over, and commit ef9bf8f stripped
their release labels but left the entries in place, because index/versions.json
addresses revisions by offset and removing one shifts every offset after it.

What was left behind was a revision that no channel ever built. It has no name,
so the nix-releases archive has no directory for it, so there is no
store-paths.xz, so no (attr, version) pair whose newest revision is one of
these can ever have a store path, a size, a closure or a fast path. Every
consumer of `name` carried a branch for that case.

This removes them and renumbers everything that addresses a revision by offset.
It is a remap rather than a rebuild on purpose: the result is exactly today's
data minus the dropped revisions, which is checkable, where a rebuild from
index/.per-rev would also silently absorb any drift between the cache and the
committed files.

The cost, paid once: 3,106 (attr, version) pairs live only at these revisions
and are deleted, taking 152 attributes with them. All of them are eval-only
records -- a version string and a date -- because none of them could have had a
store path in the first place. index/.per-rev still holds all 22 extractions,
keyed by commit, so the data is recoverable if this was ever the wrong call.

Usage:
  tools/drop-release-commits.py            # migrate in place
  tools/drop-release-commits.py --dry-run  # report what would change
"""
import argparse
import glob
import json
import os
import shutil
import sys

# The channel value that marks a release branch-off commit. Every surviving
# revision is a "nixos-unstable" bump.
RELEASE_COMMIT = "release-commit"
UNSTABLE = "nixos-unstable"


def runs_of(v):
    """history.json stores one run bare and several as a list; yield a list."""
    return [v] if v and not isinstance(v[0], list) else (v or [])


def pack_runs(runs):
    """The inverse of runs_of: a lone run is stored bare, several as a list."""
    return runs[0] if len(runs) == 1 else runs


def load_entry(entry, attr, ver):
    """An outpaths entry -> (digest, drv name, offset found at or None).

    Mirrors tools/join-eval-listing.py, which writes the name only when it differs
    from `attr-ver` and the offset only when the digest was found at a revision
    older than the pair's own.
    """
    digest = entry[0]
    name = entry[1] if len(entry) > 1 else f"{attr}-{ver}"
    found_off = entry[2] if len(entry) > 2 else None
    return digest, name, found_off


def entry_of(attr, ver, digest, name, found_off, own_off):
    """(digest, name, found offset) -> the on-disk outpaths entry."""
    entry = [digest]
    if name != f"{attr}-{ver}":
        entry.append(name)
    if own_off is not None and found_off is not None and found_off != own_off:
        if len(entry) == 1:
            entry.append(f"{attr}-{ver}")
        entry.append(found_off)
    return entry


def remap_runs(runsv, old_tip, dropped, newof):
    """Rewrite one pair's runs into the new numbering.

    A run is a contiguous span of revisions the version was present in, so a
    dropped revision inside a run just shortens the numbering rather than
    splitting it. A run that covered nothing but dropped revisions disappears,
    and two runs whose separating gap was entirely dropped revisions become
    adjacent and are merged -- leaving them apart would invent a gap in the
    version's lifetime that the surviving revisions do not show.

    A run ending at the tip stores None for its last offset, which means "still
    current"; the tip always survives, so that encoding is preserved.
    """
    out = []
    for first, last in runs_of(runsv):
        ends_open = last is None
        last = old_tip if ends_open else last
        kept = [o for o in range(first, last + 1) if o not in dropped]
        if not kept:
            continue
        out.append([newof[kept[0]], None if ends_open else newof[kept[-1]]])

    merged = []
    for run in out:
        prev = merged[-1] if merged else None
        # Adjacent after renumbering: the gap between the two runs held nothing
        # but dropped revisions.
        if prev is not None and prev[1] is not None and run[0] <= prev[1] + 1:
            prev[1] = run[1]
            continue
        merged.append(run)
    return merged


def newest_of(runs, new_tip):
    """The newest offset a remapped run list covers."""
    return max(new_tip if last is None else last for _, last in runs)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--root", default=os.path.join(os.path.dirname(__file__), ".."),
        help="the nixpkgs-multiverse checkout to migrate",
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    root = os.path.abspath(args.root)

    J = lambda *p: os.path.join(root, *p)
    load = lambda p: json.load(open(p))

    def dump(obj, path, indent=None):
        if args.dry_run:
            return
        json.dump(
            obj, open(path, "w"),
            separators=None if indent else (",", ":"),
            sort_keys=not indent, indent=indent,
        )

    revisions = load(J("revisions.json"))
    dropped = {
        i for i, r in enumerate(revisions) if r.get("channel") == RELEASE_COMMIT
    }
    if not dropped:
        sys.exit("nothing to do: revisions.json holds no release-commit entries")

    survivors = [i for i in range(len(revisions)) if i not in dropped]
    newof = {old: new for new, old in enumerate(survivors)}
    old_tip, new_tip = len(revisions) - 1, len(survivors) - 1
    if old_tip in dropped:
        sys.exit("refusing: the newest revision is a release-commit")

    print(f"dropping {len(dropped)} revisions: {sorted(dropped)}")
    print(f"revisions: {len(revisions)} -> {len(survivors)}")

    # index/history.json is the source of truth for the remap: it holds every
    # revision each version was present in, so it is the only file that can say
    # where a pair moves when its newest revision is one of the dropped ones.
    history = load(J("index/history.json"))
    if history["revisionCount"] != len(revisions):
        sys.exit(
            f"refusing: history.json covers {history['revisionCount']} revisions "
            f"but revisions.json has {len(revisions)}. Rebuild first."
        )

    new_hist, new_off = {}, {}
    vanished = set()
    for attr, vers in history["attrs"].items():
        for ver, runsv in vers.items():
            runs = remap_runs(runsv, old_tip, dropped, newof)
            if not runs:
                vanished.add((attr, ver))
                continue
            new_hist.setdefault(attr, {})[ver] = pack_runs(runs)
            new_off[(attr, ver)] = newest_of(runs, new_tip)

    print(
        f"pairs: {sum(len(v) for v in history['attrs'].values()):,} -> "
        f"{len(new_off):,} ({len(vanished):,} deleted)"
    )
    print(f"attrs: {len(history['attrs']):,} -> {len(new_hist):,}")

    # index/versions.json records only the newest revision shipping each
    # version, written as null when that revision is the newest the file covers.
    versions = load(J("index/versions.json"))
    new_versions = {}
    for attr, vers in versions["attrs"].items():
        for ver in vers:
            if (attr, ver) in vanished:
                continue
            off = new_off[(attr, ver)]
            new_versions.setdefault(attr, {})[ver] = None if off == new_tip else off

    dump(
        {"revisionCount": len(survivors), "attrs": new_versions},
        J("index/versions.json"),
    )
    dump(
        {
            "revisionCount": len(survivors),
            "attrs": new_hist,
            "skipped": history.get("skipped", []),
        },
        J("index/history.json"),
    )
    dump([revisions[i] for i in survivors], J("revisions.json"), indent=1)

    # The store-path files. Only outpaths.json carries offsets -- the offset a
    # digest was found at, recorded when it differs from the pair's own newest
    # revision. A listing only exists for a revision with a name, so a found
    # offset is never one of the dropped ones.
    # One pair of files per system, plus whatever the previous cut left in
    # data/prev for the join to carry over from.
    data = J("index/.outpaths/data")
    names = sorted(
        os.path.basename(p)
        for p in glob.glob(J(data, "outpaths-*.json")) + glob.glob(J(data, "tip-outpaths-*.json"))
    )
    for name in names:
        for path in (J(data, name), J(data, "prev", name)):
            if not os.path.exists(path):
                continue
            doc = load(path)
            out = {}
            for attr, vers in doc["attrs"].items():
                for ver, entry in vers.items():
                    if (attr, ver) in vanished:
                        continue
                    digest, drv, found = load_entry(entry, attr, ver)
                    if found is not None:
                        if found in dropped:
                            sys.exit(
                                f"refusing: {attr} {ver} was matched at offset "
                                f"{found}, which is a release-commit and can "
                                f"have no store-paths listing"
                            )
                        found = newof[found]
                    own = new_off.get((attr, ver))
                    out.setdefault(attr, {})[ver] = entry_of(
                        attr, ver, digest, drv, found, own
                    )
            n_before = sum(len(v) for v in doc["attrs"].values())
            n_after = sum(len(v) for v in out.values())
            print(f"{os.path.relpath(path, root)}: {n_before:,} -> {n_after:,} pairs")
            dump({"revisionCount": len(survivors), "attrs": out}, path)

    misses_path = J(data, "misses.json")
    if os.path.exists(misses_path):
        misses = [p for p in load(misses_path) if tuple(p[:2]) not in vanished]
        print(f"misses.json: {len(load(misses_path)):,} -> {len(misses):,}")
        dump(misses, misses_path)

    # The per-revision store-paths pickles are named by offset, so every one of
    # them has to move; a dropped revision never had one, having no listing.
    paths_dir = J("index/.outpaths/paths")
    if os.path.isdir(paths_dir):
        pkls = sorted(
            (int(f[:-4]), f) for f in os.listdir(paths_dir) if f.endswith(".pkl")
        )
        stale = [f for off, f in pkls if off in dropped]
        for f in stale:
            print(f"  removing {f}: its revision is being dropped")
            if not args.dry_run:
                os.remove(J(paths_dir, f))
        # Renamed newest-first so a rename never lands on a file not yet moved:
        # offsets only ever decrease.
        for off, f in sorted(pkls, reverse=True):
            if off in dropped:
                continue
            if not args.dry_run:
                shutil.move(J(paths_dir, f), J(paths_dir, f"{newof[off]}.pkl"))
        print(f"paths/: {len(pkls) - len(stale)} pickles renumbered")

    if args.dry_run:
        print("\ndry run: nothing written")
        return

    print("\nrewritten. Now regenerate the derived files:")
    print("  tools/build-stats.sh")


if __name__ == "__main__":
    main()
