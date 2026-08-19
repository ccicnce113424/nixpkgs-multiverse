#!/usr/bin/env python3
"""Check evaluated store paths against the channel listing that shipped them.

Before spending a machine on a backfill, confirm
that evaluating a revision at an explicit system lands on paths the channel
actually published. Every attribute an evaluation resolved falls into one of
three buckets against its revision's listing:

  built      the exact digest is in the listing — Hydra built this path
  differs    the derivation NAME is in the listing but under other digests, so
             either the listing's copy is another system's build of the same
             name, or the revision has drifted evaluating under a modern Nix
  absent     the name is not in the listing at all — unfree, unsupported, or
             never built for this system, and correctly carries no entry

`built` is the number that matters; `differs` is the drift signal the
name-keyed pipeline could not produce at all, since it took whatever digest
sat next to the name and called it a match.

Wants the per-revision eval files from tools/eval-outpaths.sh and the listing
pickles from tools/fetch-store-paths.py.
"""
import argparse
import json
import os
import pickle
import sys

DIGEST_LEN = 32


def load_listing(paths_dir, off):
    """(digests, names) for one offset, or None when it was never fetched."""
    dpath = f"{paths_dir}/{off}.digests.pkl"
    npath = f"{paths_dir}/{off}.pkl"
    if not (os.path.exists(dpath) and os.path.exists(npath)):
        return None
    with open(dpath, "rb") as f:
        digests = pickle.load(f)["digests"]
    with open(npath, "rb") as f:
        names = pickle.load(f)["names"]
    return digests, names


def out_digest(entry):
    """The `out` output's digest, or None for a derivation without one."""
    out = entry["outputs"].get("out")
    if out is None:
        return None
    return out[:DIGEST_LEN]


def check(evaluation, digests, names, examples):
    """Bucket every attribute of one revision's evaluation."""
    counts = {"built": 0, "differs": 0, "absent": 0, "noOut": 0}
    differs, absent = [], []
    for attr, entry in evaluation["attrs"].items():
        digest = out_digest(entry)
        if digest is None:
            counts["noOut"] += 1
            continue
        if digest in digests:
            counts["built"] += 1
        elif entry["name"] in names:
            counts["differs"] += 1
            if len(differs) < examples:
                differs.append(f"{attr} ({entry['name']})")
        else:
            counts["absent"] += 1
            if len(absent) < examples:
                absent.append(f"{attr} ({entry['name']})")
    return counts, differs, absent


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--revisions", required=True, help="revisions.json")
    ap.add_argument("--eval-dir", required=True, help="index/.eval")
    ap.add_argument("--paths-dir", required=True, help="the listing pickles")
    ap.add_argument("--system", default="x86_64-linux")
    ap.add_argument("--examples", type=int, default=5)
    ap.add_argument("--json", help="write the per-revision report here")
    args = ap.parse_args()

    revs = json.load(open(args.revisions))
    # Whatever tools/eval-outpaths.sh has produced for this system, whichever
    # evaluator hash wrote it: the validation is about the revisions on disk,
    # not about a range someone remembered to ask for.
    have = {}
    for f in os.listdir(args.eval_dir):
        parts = f.split(".")
        if len(parts) != 4 or parts[3] != "json" or parts[1] != args.system:
            continue
        have[parts[0]] = f"{args.eval_dir}/{f}"

    offsets = [i for i, r in enumerate(revs) if r["rev"] in have]
    if not offsets:
        print(f"no evaluations for {args.system} in {args.eval_dir}", file=sys.stderr)
        return 1

    report, missing_listings = [], 0
    print(f"{'off':>5} {'date':10} {'attrs':>7} {'built':>7} {'%':>6} {'differs':>8} {'absent':>7}")
    for off in offsets:
        rev = revs[off]["rev"]
        listing = load_listing(args.paths_dir, off)
        if listing is None:
            missing_listings += 1
            continue
        evaluation = json.load(open(have[rev]))
        counts, differs, absent = check(evaluation, *listing, args.examples)

        resolved = counts["built"] + counts["differs"] + counts["absent"]
        share = 100.0 * counts["built"] / resolved if resolved else 0.0
        print(
            f"{off:>5} {revs[off]['date']:10} {resolved:>7} {counts['built']:>7} "
            f"{share:>5.1f}% {counts['differs']:>8} {counts['absent']:>7}"
        )
        report.append(
            {
                "offset": off,
                "rev": rev,
                "date": revs[off]["date"],
                "system": args.system,
                "errorCount": evaluation["errorCount"],
                **counts,
                "builtShare": round(share, 2),
                "differsExamples": differs,
                "absentExamples": absent,
            }
        )

    if missing_listings:
        print(
            f"\n{missing_listings} revisions skipped: no listing fetched for them.\n"
            f"Run tools/fetch-store-paths.py --revisions {args.revisions} "
            f"--outdir {args.paths_dir} first.",
            file=sys.stderr,
        )
    if args.json and report:
        with open(args.json, "w") as f:
            json.dump(report, f, indent=1)
        print(f"\nreport: {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
