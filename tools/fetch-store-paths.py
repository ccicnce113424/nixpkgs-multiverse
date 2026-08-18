#!/usr/bin/env python3
"""Fetch the channel's store-path listing for named revisions.

Every nixos-unstable channel bump published a store-paths.xz (or, in the
pre-2017 era, a MANIFEST) listing every path Hydra built for it. Each named
revision in revisions.json is fetched into a per-offset pickle of
{drv name -> store digest} under the paths directory.

Two files come out of each offset. `<off>.pkl` is the {drv name -> digest}
map the name-keyed matcher reads, and `<off>.digests.pkl` is the set of every
digest the listing holds, which is what the evaluation-driven join uses
instead: a listing cannot say which system a path belongs to, so it can only
be asked whether a digest it was handed is one Hydra built (PLAN-issue12.md).

MANIFEST-era files also carry NarSize/Size/References/System per path; those
are saved alongside so the old era needs no narinfo crawl at all. Only
x86_64-linux entries are kept from manifests — the one era where the listing
does carry a System column, and the one era the name map is therefore honest.

Incremental by construction: an offset whose pickle already exists is
skipped, so the hourly job pays for exactly the bumps it has never seen.
"""
import argparse
import bz2
import json
import lzma
import os
import pickle
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

RELEASES_BASE = "https://nix-releases.s3.amazonaws.com/nixos/unstable/"
STORE_PREFIX = "/nix/store/"
DIGEST_LEN = 32
USER_AGENT = "nixpkgs-multiverse"
TIMEOUT_SECONDS = 120


def split_base(path):
    """/nix/store/<digest>-<name> -> (digest, name)."""
    base = path[len(STORE_PREFIX) :]
    return base[:DIGEST_LEN], base[DIGEST_LEN + 1 :]


def parse_storepaths(raw):
    m, digests = {}, set()
    for line in lzma.decompress(raw).decode().splitlines():
        line = line.strip()
        if not line.startswith(STORE_PREFIX):
            continue
        digest, name = split_base(line)
        # Whichever of a name's paths sorts first, which for anything built for
        # more than one system is a coin flip. Kept for the matcher that still
        # reads it; the digest set below is the honest half of this file.
        m.setdefault(name, digest)
        digests.add(digest)
    return m, None, digests


MANIFEST_FIELD = re.compile(
    r"^\s*(StorePath|NarURL|Size|NarSize|References|System):\s*(.*)$"
)


def parse_manifest(text):
    m, meta, cur, digests = {}, {}, {}, set()
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.endswith("{"):
            cur = {}
        elif stripped == "}":
            sp = cur.get("StorePath")
            if sp and cur.get("System", "x86_64-linux") == "x86_64-linux":
                digest, name = split_base(sp)
                m.setdefault(name, digest)
                digests.add(digest)
                refs = [
                    split_base(p)
                    for p in cur.get("References", "").split()
                    if p.startswith(STORE_PREFIX)
                ]
                meta[digest] = {
                    "narSize": int(cur["NarSize"]) if cur.get("NarSize") else None,
                    "fileSize": int(cur["Size"]) if cur.get("Size") else None,
                    "narUrl": cur.get("NarURL"),
                    "refs": refs,
                }
        else:
            f = MANIFEST_FIELD.match(line)
            if f:
                cur[f.group(1)] = f.group(2)
    return m, meta, digests


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as r:
        return r.read()


def digests_path(outdir, off):
    return f"{outdir}/{off}.digests.pkl"


def load_digests(outdir, off):
    """The set of every digest the offset's listing holds."""
    with open(digests_path(outdir, off), "rb") as f:
        return pickle.load(f)["digests"]


def fetch(outdir, job):
    off, r = job
    out = f"{outdir}/{off}.pkl"
    if os.path.exists(out) and os.path.exists(digests_path(outdir, off)):
        return off, "cached"

    # store-paths.xz first; 404 falls back through the two MANIFEST spellings
    # the pre-2017 channels used.
    prefix = RELEASES_BASE + r["name"] + "/"
    try:
        try:
            m, meta, digests = parse_storepaths(get(prefix + "store-paths.xz"))
            kind = "store-paths"
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            try:
                text = bz2.decompress(get(prefix + "MANIFEST.bz2")).decode()
            except urllib.error.HTTPError as e2:
                if e2.code != 404:
                    raise
                text = get(prefix + "MANIFEST").decode()
            m, meta, digests = parse_manifest(text)
            kind = "manifest"
    except Exception as e:
        return off, f"FAIL {e}"

    with open(out + ".tmp", "wb") as f:
        pickle.dump({"names": m, "meta": meta, "kind": kind}, f, protocol=4)
    os.replace(out + ".tmp", out)

    # Separate file rather than another key in the one above, so that an
    # already-fetched offset gains the digest set without its name map being
    # rewritten, and so that retiring the name map is a matter of deleting a
    # file rather than a format migration.
    dout = digests_path(outdir, off)
    with open(dout + ".tmp", "wb") as f:
        pickle.dump({"digests": digests, "kind": kind}, f, protocol=4)
    os.replace(dout + ".tmp", dout)

    return off, f"{kind} {len(m)} names {len(digests)} paths"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--revisions", required=True, help="revisions.json")
    ap.add_argument("--outdir", required=True, help="per-offset pickle directory")
    ap.add_argument("--threads", type=int, default=16)
    ap.add_argument(
        "--min-offset",
        type=int,
        default=0,
        help="skip revisions below this offset — the hourly job passes the "
        "previous artifacts' coverage so a fresh runner fetches only the new "
        "bumps, not thirteen years of listings",
    )
    ap.add_argument(
        "--limit", type=int, default=0, help="fetch at most this many (smoke test)"
    )
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    revs = json.load(open(args.revisions))

    # Every revision is a published channel bump and so has a listing to fetch;
    # the cached ones cost a stat each, so an up-to-date run is effectively free.
    jobs = [(i, r) for i, r in enumerate(revs) if i >= args.min_offset]
    jobs = [
        j
        for j in jobs
        if not (
            os.path.exists(f"{args.outdir}/{j[0]}.pkl")
            and os.path.exists(digests_path(args.outdir, j[0]))
        )
    ]
    if args.limit:
        jobs = jobs[: args.limit]
    print(f"{len(jobs)} listings to fetch", flush=True)

    fails = 0
    with ThreadPoolExecutor(args.threads) as ex:
        for i, (off, status) in enumerate(
            ex.map(lambda j: fetch(args.outdir, j), jobs)
        ):
            if status.startswith("FAIL"):
                fails += 1
                print(f"{off} {revs[off]['name']} {status}", flush=True)
            if i and i % 100 == 0:
                print(f"... {i}/{len(jobs)}", file=sys.stderr, flush=True)
    print(f"done: {len(jobs)} fetched, {fails} failures", flush=True)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
