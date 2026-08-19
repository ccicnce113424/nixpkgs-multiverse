#!/usr/bin/env python3
"""Sample an artifact's digests and read the machine architecture out of them.

The acceptance check for the per-system artifacts: every digest in
outpaths-x86_64-linux.json must be an x86_64-linux path, and every digest in
the aarch64-linux file an aarch64-linux one. Nothing in the pipeline can assert
that from the inside — the listing has no System column, which is the whole
bug — so this asks the payload.

Each sampled entry's NAR is fetched from cache.nixos.org and scanned for ELF
headers; `e_machine` at offset 18 separates x86-64 (0x3e) from AArch64 (0xb7).
Every header in the NAR votes, since a store path is single-architecture in
practice and the vote makes a stray cross-compiled artefact harmless.

Entries carrying no ELF at all — a man page, a data-only output, a static Go
binary in an unusual format — are skipped rather than counted, so the sample
walks until it has classified --count of them.

  tools/verify-outpath-arch.py --artifact .../tip-outpaths-x86_64-linux.json \\
      --expect x86_64
"""
import argparse
import concurrent.futures as cf
import json
import lzma
import random
import subprocess
import sys
import urllib.request

CACHE = "https://cache.nixos.org"
USER_AGENT = "nixpkgs-multiverse"
TIMEOUT_SECONDS = 90
# ELF e_machine values, at byte 18 of the header.
E_MACHINE = {0x03: "i686", 0x3E: "x86_64", 0xB7: "aarch64", 0x28: "arm", 0xF3: "riscv"}
# Big NARs are slow to fetch and no more informative than small ones, so the
# sampler skips them by default and walks further instead. --max-nar-bytes
# raises the ceiling when a specific path has to be settled — a Go binary is
# tens of MB and would otherwise never be classified.
MAX_FILE_BYTES = 4_000_000
THREADS = 24


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as r:
        return r.read()


def narinfo(digest):
    try:
        text = get(f"{CACHE}/{digest}.narinfo").decode()
    except Exception:
        return None
    return dict(line.partition(": ")[::2] for line in text.splitlines())


def arch_of(digest, max_bytes=MAX_FILE_BYTES):
    """The architecture of the ELF files inside a path, or None."""
    info = narinfo(digest)
    if not info or int(info.get("FileSize", "0")) > max_bytes:
        return None
    try:
        raw = get(f"{CACHE}/{info['URL']}")
    except Exception:
        return None
    if info["URL"].endswith(".xz"):
        raw = lzma.decompress(raw)
    elif info["URL"].endswith(".zst"):
        raw = subprocess.run(["zstd", "-dc"], input=raw, capture_output=True).stdout

    votes = {}
    at = 0
    while True:
        at = raw.find(b"\x7fELF", at)
        if at < 0:
            break
        machine = int.from_bytes(raw[at + 18 : at + 20], "little")
        if machine in E_MACHINE:
            name = E_MACHINE[machine]
            votes[name] = votes.get(name, 0) + 1
        at += 4
    return max(votes, key=votes.get) if votes else None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--artifact", help="an outpaths-<system>.json")
    ap.add_argument("--expect", required=True, help="x86_64 or aarch64")
    ap.add_argument("--count", type=int, default=120, help="entries to classify")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--max-nar-bytes", type=int, default=MAX_FILE_BYTES)
    ap.add_argument(
        "--digest",
        action="append",
        help="classify these digests instead of sampling an artifact",
    )
    args = ap.parse_args()

    # Named digests settle one path each; that is the mode for asking about a
    # specific report rather than about an artifact as a whole.
    if args.digest:
        wrong = 0
        for digest in args.digest:
            arch = arch_of(digest, args.max_nar_bytes)
            print(f"  {digest} -> {arch}")
            wrong += arch != args.expect
        return 1 if wrong else 0

    if not args.artifact:
        print("give --artifact or --digest", file=sys.stderr)
        return 2

    attrs = json.load(open(args.artifact))["attrs"]
    pairs = [(a, v, e[0]) for a, vers in attrs.items() for v, e in vers.items()]
    random.seed(args.seed)
    random.shuffle(pairs)

    classified = []
    with cf.ThreadPoolExecutor(THREADS) as ex:
        # Five times the target, because a good share of entries carry no ELF.
        for (attr, ver, digest), arch in zip(
            pairs,
            ex.map(lambda p: arch_of(p[2], args.max_nar_bytes), pairs[: args.count * 5]),
        ):
            if arch:
                classified.append((attr, ver, digest, arch))
            if len(classified) >= args.count:
                break

    wrong = [c for c in classified if c[3] != args.expect]
    n = len(classified)
    print(f"{args.artifact}: classified {n} sampled entries")
    print(f"  {args.expect:>8}: {n - len(wrong)}")
    print(f"  other   : {len(wrong)}")
    for attr, ver, digest, arch in wrong[:15]:
        print(f"    {attr} {ver} -> /nix/store/{digest}-... [{arch}]")
    if not n:
        print("nothing classified; is the artifact empty?", file=sys.stderr)
        return 1
    return 1 if wrong else 0


if __name__ == "__main__":
    sys.exit(main())
