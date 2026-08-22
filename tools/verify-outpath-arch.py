#!/usr/bin/env python3
"""Sample an artifact's digests and read the machine architecture out of them.

The acceptance check for the per-system artifacts: every digest in
outpaths-<system>.json must be a path for that system. Nothing in the pipeline
can assert that from the inside — the listing has no System column, which is
the whole bug — so this asks the payload.

Each sampled entry's NAR is fetched from cache.nixos.org and scanned for
executable headers. ELF `e_machine` (byte 18) and Mach-O `cputype` (byte 4)
give the architecture; the format itself gives the OS, and it has to, since
aarch64-linux and aarch64-darwin differ only in container. Reading `e_machine`
alone would call them the same thing and pass a darwin artifact full of Linux
paths.

Every header in the NAR votes, since a store path is single-system in practice
and the vote makes a stray cross-compiled artefact harmless.

Entries carrying no executable at all — a man page, a data-only output, a
static Go binary in an unusual format — are skipped rather than counted, so the
sample walks until it has classified --count of them.

  tools/verify-outpath-arch.py --artifact .../tip-outpaths-aarch64-darwin.json \\
      --expect aarch64-darwin
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

# Anything in this index carrying an ELF is a Linux path: the channel builds no
# other ELF platform.
ELF_MAGIC = b"\x7fELF"
ELF_MACHINE = {
    0x03: "i686-linux",
    0x3E: "x86_64-linux",
    0xB7: "aarch64-linux",
    0x28: "armv7l-linux",
    0xF3: "riscv64-linux",
}

# The 64-bit magic as it sits on disk. The 32-bit magic and the fat-binary
# container are deliberately unread — nothing the channel builds for darwin is
# either, and guessing would be the kind of claim this file exists to avoid.
MACHO_MAGIC_64 = b"\xcf\xfa\xed\xfe"
MACHO_CPUTYPE = {
    0x01000007: "x86_64-darwin",
    0x0100000C: "aarch64-darwin",
}

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


def count_systems(raw, magic, header_len, read_system):
    """One vote per header of a single format found anywhere in a NAR."""
    votes = {}
    at = 0
    while True:
        at = raw.find(magic, at)
        if at < 0:
            return votes
        system = read_system(raw[at : at + header_len])
        if system:
            votes[system] = votes.get(system, 0) + 1
        at += len(magic)


def system_of(digest, max_bytes=MAX_FILE_BYTES):
    """The system of the executables inside a path, or None."""
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

    # Both formats over the same NAR rather than one tried first, so a path
    # holding both is settled by weight of evidence.
    votes = count_systems(
        raw,
        ELF_MAGIC,
        20,
        lambda h: ELF_MACHINE.get(int.from_bytes(h[18:20], "little")),
    )
    votes |= count_systems(
        raw,
        MACHO_MAGIC_64,
        8,
        lambda h: MACHO_CPUTYPE.get(int.from_bytes(h[4:8], "little")),
    )
    return max(votes, key=votes.get) if votes else None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--artifact", help="an outpaths-<system>.json")
    ap.add_argument("--expect", required=True, help="the system, e.g. aarch64-darwin")
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
            system = system_of(digest, args.max_nar_bytes)
            print(f"  {digest} -> {system}")
            wrong += system != args.expect
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
        # Five times the target, because a good share of entries carry no
        # executable.
        for (attr, ver, digest), system in zip(
            pairs,
            ex.map(
                lambda p: system_of(p[2], args.max_nar_bytes), pairs[: args.count * 5]
            ),
        ):
            if system:
                classified.append((attr, ver, digest, system))
            if len(classified) >= args.count:
                break

    wrong = [c for c in classified if c[3] != args.expect]
    n = len(classified)
    print(f"{args.artifact}: classified {n} sampled entries")
    print(f"  {args.expect:>16}: {n - len(wrong)}")
    print(f"  other{' ':>11}: {len(wrong)}")
    for attr, ver, digest, system in wrong[:15]:
        print(f"    {attr} {ver} -> /nix/store/{digest}-... [{system}]")
    if not n:
        print("nothing classified; is the artifact empty?", file=sys.stderr)
        return 1
    return 1 if wrong else 0


if __name__ == "__main__":
    sys.exit(main())
