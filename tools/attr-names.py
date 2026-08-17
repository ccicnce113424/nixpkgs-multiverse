#!/usr/bin/env python3
"""Project versions.json down to every attribute name and its version count.

486 KB against versions.json's 5.3 MB, and all the search box ever reads. The
search box is the landing page, so this one loads at boot — the per-attribute
shards shard-by-attr.py writes cover everything after a package is chosen.

    attr-names.py <versions.json> <dest.json>
"""
import json
import sys

src, dest = sys.argv[1:3]
index = json.load(open(src))
json.dump(
    {"attrs": {a: len(v) for a, v in index["attrs"].items()}},
    open(dest, "w"),
    separators=(",", ":"),
    sort_keys=True,
)
