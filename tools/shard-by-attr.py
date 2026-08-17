#!/usr/bin/env python3
"""Split an {"attrs": {...}} index file into per-attribute-prefix shards.

Sharded by the first two characters of the attribute name, so a package page
fetches only the shard holding the one attribute it is about. history.json and
versions.json have the same shape and both go through here.

A timeline needs the history of exactly one attribute, and a version table
needs the versions of exactly one attribute; serving either whole file to
render one package would cost more than every other request on the page
combined. Two characters puts the median history shard at 2 KB and the median
versions shard at 1.4 KB.

Build artifacts rather than committed data: the repo keeps the two files
multiverse.nix reads, and the deploy gets the pieces. That also means the split
can be retuned without a data commit.

    shard-by-attr.py <src.json> <dest-dir>
"""
import json
import os
import sys

src, dest = sys.argv[1:3]
data = json.load(open(src))
os.makedirs(dest, exist_ok=True)

# Everything that is not the per-attribute map is small and gets copied into
# every shard, so a shard stands on its own.
common = {k: v for k, v in data.items() if k != "attrs"}

buckets = {}
for attr, vers in data["attrs"].items():
    # Anything not alphanumeric folds to _, so the shard name is always a safe
    # filename and the site can compute it with the same one-liner.
    key = "".join(c if c.isalnum() else "_" for c in attr[:2].lower()) or "_"
    buckets.setdefault(key, {})[attr] = vers

for key, attrs in buckets.items():
    json.dump(
        {**common, "attrs": attrs},
        open(os.path.join(dest, key + ".json"), "w"),
        separators=(",", ":"),
        sort_keys=True,
    )
print(f"sharded {len(data['attrs'])} attrs into {len(buckets)} files")
