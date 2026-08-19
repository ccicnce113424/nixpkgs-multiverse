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
# The browsable form, and the only one that works: a release directory is a
# key prefix rather than an object, so requesting it as a path is a 404 on the
# bucket and on releases.nixos.org alike. The `?prefix=` query is what both
# serve — as XML from S3, as the rendered channel listing from
# releases.nixos.org, which is also what site/js/config.js links.
CHANNEL_URL = 'https://releases.nixos.org/?prefix=nixos/unstable/'
SHORT_REV = 12

# The newest revision carrying a narHash, which is exactly what multiverse.nix
# hands back as `tip`. A revision appended by fetch-unstable-revisions.sh has
# none until build-index.sh reaches it and cannot be fetched in the meantime,
# so naming the last entry here would advertise a revision that throws.
tip = next((r for r in reversed(revs) if 'narHash' in r), None)
if tip is None:
    sys.exit("no revision has a narHash yet; run tools/build-index.sh first")

attrs = index['attrs']
pairs = sum(len(versions) for versions in attrs.values())

# One line for what the index holds, one for how current it is. Deliberately
# not "N of N revisions indexed": those two numbers agree except in the minutes
# between an append and the run that indexes it, so the healthy case is noise
# and the lagging case gets a line of its own below.
coverage = (
    f"- **{pairs:,} package versions** across **{len(attrs):,} attributes**, "
    f"from **{index['revisionCount']:,} revisions**"
)
current = [
    f"- {revs[0]['date']} → {tip['date']}, newest "
    f"[`{tip['rev'][:SHORT_REV]}`]({COMMIT_URL}{tip['rev']})"
]

# Every revision comes from the channel archive and carries the S3 object that
# published it. The hash is already on the line, so the link shows just the
# channel it published as.
channel = tip['name'].rsplit('.', 1)[0]
current.append(f" · [`{channel}`]({CHANNEL_URL}{tip['name']}/)")

# No line for revisions that are on file but unindexed. build-index.sh fails
# rather than half-finish an incremental run, so the update job never commits
# that pair, and both numbers above stay true of what the repo actually ships.
#
# The blank line after the marker is what `nix fmt` wants: prettier separates a
# list from the HTML comment above it, and without it every hourly commit lands
# a README the next CI run refuses.
lines = [BEGIN, '', coverage, ''.join(current), END]

text = open(readme).read()
if BEGIN not in text or END not in text:
    sys.exit(f"README.md has no {BEGIN} / {END} markers to fill")

head, rest = text.split(BEGIN, 1)
_, tail = rest.split(END, 1)
open(readme, 'w').write(head + '\n'.join(lines) + tail)

print(f"README status block: {tip['rev'][:SHORT_REV]} ({tip['date']}), "
      f"{index['revisionCount']:,} revisions covered")
PY
