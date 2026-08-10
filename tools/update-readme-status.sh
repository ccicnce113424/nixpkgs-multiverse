#!/usr/bin/env bash
# Rewrites the index-status block in README.md from revisions.json and
# index/versions.json.
#
# The block is delimited by HTML comments, so this is a splice rather than a
# template: everything outside the markers is left exactly as it was written by
# hand. Run after build-index.sh; the update job in CI does both and commits
# whatever moved.
set -euo pipefail

# revisions.json, index/ and README.md all live in the caller's checkout, which
# under `nix run` is not where this script lives; the flake wrapper passes that
# directory down as MULTIVERSE_ROOT.
MT="${MULTIVERSE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

python3 - "$MT" <<'PY'
import json, os, sys

mt = sys.argv[1]
revs = json.load(open(os.path.join(mt, 'revisions.json')))
index = json.load(open(os.path.join(mt, 'index', 'versions.json')))
readme = os.path.join(mt, 'README.md')

BEGIN = '<!-- BEGIN index-status -->'
END = '<!-- END index-status -->'
COMMIT_URL = 'https://github.com/NixOS/nixpkgs/commit/'
CHANNEL_URL = 'https://nix-releases.s3.amazonaws.com/nixos/unstable/'
SHORT_REV = 12

# revisions.json is date-ordered, so the last entry is what multiverse.nix
# exposes as `tip` — the thing a reader actually wants to know the age of.
tip = revs[-1]
attrs = index['attrs']
pairs = sum(len(versions) for versions in attrs.values())

# One line for what the index holds, one for how current it is. Deliberately
# not "N of N revisions indexed": those two numbers agree except in the minutes
# between an append and the run that indexes it, so the healthy case is noise
# and the lagging case gets a line of its own below.
coverage = (
    f"- **{pairs:,} package versions** across **{len(attrs):,} attributes**, "
    f"from **{len(revs):,} revisions**"
)
current = [
    f"- {revs[0]['date']} → {revs[-1]['date']}, newest "
    f"[`{tip['rev'][:SHORT_REV]}`]({COMMIT_URL}{tip['rev']})"
]

# Only revisions discovered through the channel archive carry the S3 object
# that published them; named releases and hand-added entries do not. The hash
# is already on the line, so the link shows just the channel it published as.
if 'name' in tip:
    channel = tip['name'].rsplit('.', 1)[0]
    current.append(f" · [`{channel}`]({CHANNEL_URL}{tip['name']}/)")

lines = [BEGIN, coverage, ''.join(current)]

# Only worth a reader's attention when it is not zero: revisions are on file
# but no version of theirs is reachable yet.
lagging = len(revs) - index['revisionCount']
if lagging:
    lines.append(f"- **{lagging:,} revisions appended since the last indexing run** — "
                 f"reachable through `at`, not yet in the version index")

lines.append(END)

text = open(readme).read()
if BEGIN not in text or END not in text:
    sys.exit(f"README.md has no {BEGIN} / {END} markers to fill")

head, rest = text.split(BEGIN, 1)
_, tail = rest.split(END, 1)
open(readme, 'w').write(head + '\n'.join(lines) + tail)

print(f"README status block: {tip['rev'][:SHORT_REV]} ({tip['date']}), "
      f"{index['revisionCount']:,} revisions covered")
PY
