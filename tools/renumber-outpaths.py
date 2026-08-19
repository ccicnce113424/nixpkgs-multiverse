#!/usr/bin/env python3
"""Renumber the store-path artifacts after revisions.json gained older entries.

index/versions.json and index/history.json are rebuilt from the extraction
cache, which is keyed by commit and so does not care where a revision sits in
the array. The store-path artifacts are not rebuilt that way: matching a pair
to a digest costs a listing fetch per revision, so the results are carried
between runs and only the new pairs are resolved. That carried state addresses
revisions by offset, in two places:

  outpaths.json   entry[2], the offset a digest was found at when it differs
                  from the pair's own newest revision
  paths/<n>.pkl   one cached channel listing per revision, named by offset

Both are wrong the moment a revision is inserted anywhere but the end. This
maps them through, matching revisions by commit so an entry follows its own
tree rather than its old position.

Usage:
  tools/renumber-outpaths.py --from <revisions.json before the insert>
"""
import argparse
import json
import os
import shutil
import sys


def load_entry(entry, attr, ver):
    """An outpaths entry -> (digest, drv name, offset found at or None)."""
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


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--from",
        dest="before",
        required=True,
        help="revisions.json as it was before the insert",
    )
    ap.add_argument(
        "--root",
        default=os.path.join(os.path.dirname(__file__), ".."),
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    J = lambda *p: os.path.join(root, *p)

    before = json.load(open(args.before))
    after = json.load(open(J("revisions.json")))
    now_at = {r["rev"]: i for i, r in enumerate(after)}

    missing = [r["rev"] for r in before if r["rev"] not in now_at]
    if missing:
        sys.exit(
            f"refusing: {len(missing)} revisions on the old list are gone from "
            f"the new one, e.g. {missing[0][:12]}. This tool only renumbers; "
            f"a removal changes which revision a pair belongs to."
        )

    newof = {i: now_at[r["rev"]] for i, r in enumerate(before)}
    shifts = {new - old for old, new in newof.items()}
    print(f"{len(before)} -> {len(after)} revisions, offset shifts: {sorted(shifts)}")

    # index/versions.json is already rebuilt against the new array, so it is
    # the authority on where each pair's newest revision now sits -- which is
    # what decides whether a found offset still needs recording at all.
    versions = json.load(open(J("index/versions.json")))
    tip = versions["revisionCount"] - 1
    own_of = {
        (attr, ver): tip if off is None else off
        for attr, vers in versions["attrs"].items()
        for ver, off in vers.items()
    }

    data = J("index/.outpaths/data")
    for name in ("outpaths.json", "tip-outpaths.json"):
        for path in (J(data, name), J("index/.outpaths", "prev-" + name)):
            if not os.path.exists(path):
                continue
            doc = json.load(open(path))
            out, dropped = {}, 0
            for attr, vers in doc["attrs"].items():
                for ver, entry in vers.items():
                    digest, drv, found = load_entry(entry, attr, ver)
                    # A pair the rebuilt index no longer knows has no newest
                    # revision to record a found offset against.
                    if (attr, ver) not in own_of:
                        dropped += 1
                        continue
                    if found is not None:
                        found = newof[found]
                    out.setdefault(attr, {})[ver] = entry_of(
                        attr, ver, digest, drv, found, own_of[(attr, ver)]
                    )
            print(
                f"{os.path.relpath(path, root)}: "
                f"{sum(len(v) for v in out.values()):,} pairs"
                + (f", {dropped:,} dropped as unknown to the index" if dropped else "")
            )
            if not args.dry_run:
                json.dump(
                    {"revisionCount": len(after), "attrs": out},
                    open(path, "w"),
                    separators=(",", ":"),
                    sort_keys=True,
                )

    # The listing pickles move with their revision. Renamed in descending order
    # of the new offset so a rename never lands on a file not yet moved.
    paths_dir = J("index/.outpaths/paths")
    if os.path.isdir(paths_dir):
        pkls = [int(f[:-4]) for f in os.listdir(paths_dir) if f.endswith(".pkl")]
        for off in sorted(pkls, key=lambda o: newof.get(o, o), reverse=True):
            if off not in newof:
                print(f"  leaving {off}.pkl: no revision held that offset before")
                continue
            if not args.dry_run and newof[off] != off:
                shutil.move(
                    J(paths_dir, f"{off}.pkl"), J(paths_dir, f"{newof[off]}.pkl")
                )
        print(f"paths/: {len(pkls)} pickles renumbered")

    if args.dry_run:
        print("\ndry run: nothing written")


if __name__ == "__main__":
    main()
