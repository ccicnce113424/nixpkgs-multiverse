#!/usr/bin/env python3
"""Resolve the open tip of index/versions.json or index/history.json.

Both index files leave whatever is current at the newest revision they cover
open-ended — a null offset in versions.json, a run ending in null in
history.json — so that appending a revision does not rewrite every entry that
did not change. See "the open tip" in docs/design.md.

The browser is never told about that. The site build runs this first and
everything downstream — the shards, the sitemap, the whole-file copy — reads
what it writes, so the encoding is known in exactly one place on this side and
app.js only ever sees plain offsets.

    close-tip.py <src.json> <dest.json>
"""
import json
import sys

src, dest = sys.argv[1:3]
data = json.load(open(src))

# Against the file's own count, never len(revisions): between an append and the
# indexing run that catches up to it, the newest revision is one this file has
# never looked at.
tip = data["revisionCount"] - 1


def close(value):
    if value is None:  # versions.json offset
        return tip
    if isinstance(value, list):  # history.json run(s)
        if value and isinstance(value[0], list):
            return [close(run) for run in value]
        first, last = value
        return [first, tip if last is None else last]
    return value


data["attrs"] = {
    attr: {v: close(value) for v, value in vers.items()}
    for attr, vers in data["attrs"].items()
}
json.dump(data, open(dest, "w"), separators=(",", ":"), sort_keys=True)
