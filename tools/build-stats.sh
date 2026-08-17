#!/usr/bin/env bash
# Builds index/stats.json: the aggregates the site's charts draw.
#
# Everything here is derivable in the browser from history.json — and must not
# be. That file is 8 MB (2.1 MB gzipped) and answering "how many attributes did
# nixpkgs have each month" from it means walking 300k runs. Precomputing leaves
# the site a ~30 KB file it can fetch before anything else, so the charts render
# on first paint instead of waiting on the index.
#
# Unlike build-history.sh this needs no extraction cache: it reads the two
# committed files and nothing else, so it runs anywhere, including a fresh
# clone.
#
# Aggregated by month rather than per revision. 1,532 points is more than a
# 700px-wide chart can resolve, and a month is the smallest bucket where
# "commits per day" is not dominated by whether a bump happened to land on a
# Tuesday.
#
# Usage:
#   tools/build-stats.sh
set -euo pipefail

MT="${MULTIVERSE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
REVFILE="$MT/revisions.json"
HISTFILE="$MT/index/history.json"
OUT="$MT/index/stats.json"

if [ ! -f "$HISTFILE" ]; then
  echo "build-stats: no $HISTFILE; run tools/build-history.sh first" >&2
  exit 1
fi

python3 - "$REVFILE" "$HISTFILE" "$OUT" <<'PY'
import json, re, sys
from collections import defaultdict
from datetime import date

revfile, histfile, out = sys.argv[1:4]
revs = json.load(open(revfile))
hist = json.load(open(histfile))
N = hist['revisionCount']

# A run still open at the newest revision covered ends in null rather than in
# N - 1, so that appending a revision does not rewrite every version that is
# still current; see docs/design.md. Closed here, so everything below counts
# plain offsets.
def unpack(v):
    runs = [v] if v and not isinstance(v[0], list) else v
    return [[first, N - 1 if last is None else last] for first, last in runs]

# --- attribute presence over time -------------------------------------------
#
# An attribute is in nixpkgs at a revision if any of its versions is. Union the
# per-version runs, collapse to per-attribute runs, then walk those as a
# difference array — O(runs) rather than O(attrs x revisions).
delta = [0] * (N + 2)
added = [0] * (N + 2)
removed = [0] * (N + 2)

for vers in hist['attrs'].values():
    present = set()
    for runs in vers.values():
        for s, e in unpack(runs):
            present.update(range(s, e + 1))
    ordered = sorted(present)
    blocks = [[ordered[0], ordered[0]]]
    for o in ordered[1:]:
        if o == blocks[-1][1] + 1:
            blocks[-1][1] = o
        else:
            blocks.append([o, o])
    for s, e in blocks:
        delta[s] += 1
        delta[e + 1] -= 1
        # Offset 0 is the index reaching back to 2012, not 2,513 packages
        # landing that day; likewise a run ending at the newest revision is
        # still present, not removed.
        if s > 0:
            added[s] += 1
        if e + 1 < N:
            removed[e + 1] += 1

attrs_at = []
running = 0
for i in range(N):
    running += delta[i]
    attrs_at.append(running)

# --- commit velocity ---------------------------------------------------------
#
# Channel bump cadence is flat at ~2 days and says nothing. The interesting
# number is hiding in the revision name: `nixos-26.05pre977467` carries
# nixpkgs' own commit counter, so the delta between two bumps is the commits
# that landed between them. A released bump is named `nixos-26.05.7813` with
# no `pre`, and carries no counter, so it is skipped.
counted = []
for i, r in enumerate(revs[:N]):
    m = re.search(r'pre(\d+)', r['name'])
    if m:
        counted.append((i, r['date'], int(m.group(1))))

commits = defaultdict(int)
span_days = defaultdict(int)
for (_, d1, c1), (_, d2, c2) in zip(counted, counted[1:]):
    days = (date.fromisoformat(d2) - date.fromisoformat(d1)).days
    # A counter that goes backwards means the two bumps came off branches that
    # do not share a count; skip rather than record a negative month.
    if days <= 0 or c2 <= c1:
        continue
    commits[d2[:7]] += c2 - c1
    span_days[d2[:7]] += days

# --- monthly rollup ----------------------------------------------------------
months = {}
for i, r in enumerate(revs[:N]):
    m = r['date'][:7]
    row = months.setdefault(m, {
        'month': m, 'revisions': 0, 'attrs': 0, 'added': 0, 'removed': 0,
        'commitsPerDay': None,
    })
    row['revisions'] += 1
    row['added'] += added[i]
    row['removed'] += removed[i]
    # The count as the month ended, since revisions are walked in order.
    row['attrs'] = attrs_at[i]

for m, row in months.items():
    if span_days.get(m):
        row['commitsPerDay'] = round(commits[m] / span_days[m], 1)

monthly = [months[m] for m in sorted(months)]

versions = sum(len(v) for v in hist['attrs'].values())
stats = {
    'revisionCount': N,
    # Per revision, against the one before it: [attributes added, removed].
    # Indexed by offset, so the revisions table can read row `off` directly.
    # ~12 KB as pairs — small enough to ride along in a file the site already
    # fetches, and the alternative is making that page load the 8 MB history.
    'churn': [[added[i], removed[i]] for i in range(N)],
    'totals': {
        'attrs': attrs_at[N - 1],
        'attrsEverSeen': len(hist['attrs']),
        'versions': versions,
        'revisions': N,
        'additions': sum(added[:N]),
        'removals': sum(removed[:N]),
        'firstDate': revs[0]['date'],
        'lastDate': revs[N - 1]['date'],
    },
    'monthly': monthly,
}
json.dump(stats, open(out, 'w'), sort_keys=True)

import os
print(f"stats: {len(monthly)} months, {N} revisions")
print(f"       {stats['totals']['attrs']:,} attrs now, "
      f"{stats['totals']['additions']:,} added / {stats['totals']['removals']:,} removed all time")
print(f"       -> {out} ({os.path.getsize(out) / 1e3:.1f} KB)")
PY
