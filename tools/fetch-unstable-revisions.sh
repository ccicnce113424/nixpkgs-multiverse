#!/usr/bin/env bash
# Refreshes revisions.json with nixos-unstable channel bumps.
#
# Source is the `nix-releases` S3 bucket, which archives every unstable channel
# ever published. That is the right list rather than "every commit on master":
# a directory appears there only once the channel actually advanced, meaning
# Hydra built it and its store paths are on cache.nixos.org. Commits that never
# became a channel were never fully built, so they were never substitutable.
#
# The git revision is embedded in the directory name
# (nixos-26.11pre1049422.f13ff45afd1b), so the whole list costs a few paginated
# listings rather than one fetch per channel.
#
# Existing entries are left alone; only new revisions are appended, and the file
# is re-sorted by date. Appending is safe for index/versions.json only when it
# is rebuilt afterwards, since the index stores offsets into this array.
set -euo pipefail

MT="$(cd "$(dirname "$0")/.." && pwd)"
NIXPKGS="${NIXPKGS:-/home/fmzakari/code/github.com/NixOS/nixpkgs}"
MIN_YEAR="${1:-2017}"

python3 - "$NIXPKGS" "$MIN_YEAR" "$MT/revisions.json" <<'PY'
import json, re, subprocess, sys, urllib.parse, urllib.request

nixpkgs, min_year, revfile = sys.argv[1], int(sys.argv[2]), sys.argv[3]
BASE = 'https://nix-releases.s3.amazonaws.com/'

names, marker = [], ''
while True:
    q = urllib.parse.urlencode({
        'delimiter': '/', 'prefix': 'nixos/unstable/',
        'max-keys': '1000', 'marker': marker,
    })
    with urllib.request.urlopen(BASE + '?' + q, timeout=90) as r:
        xml = r.read().decode()
    got = re.findall(r'<Prefix>nixos/unstable/([^<]+)/</Prefix>', xml)
    if not got:
        break
    names += got
    if '<IsTruncated>true</IsTruncated>' not in xml:
        break
    marker = 'nixos/unstable/' + got[-1] + '/'

revs = json.load(open(revfile))
known = {r['rev'] for r in revs}
added = unresolved = 0

for name in names:
    m = re.search(r'\.([0-9a-f]{11,12})$', name)
    if not m:
        continue
    try:
        full = subprocess.run(
            ['git', '-C', nixpkgs, 'rev-parse', '--verify', f'{m.group(1)}^{{commit}}'],
            capture_output=True, text=True, check=True).stdout.strip()
        date = subprocess.run(
            ['git', '-C', nixpkgs, 'log', '-1', '--format=%cs', full],
            capture_output=True, text=True, check=True).stdout.strip()
    except subprocess.CalledProcessError:
        unresolved += 1
        continue
    if full in known or int(date[:4]) < min_year:
        continue
    revs.append({"rev": full, "date": date, "channel": "nixos-unstable"})
    known.add(full)
    added += 1

revs.sort(key=lambda r: (r['date'], r['rev']))
json.dump(revs, open(revfile, 'w'), indent=1)
print(f"archived channels: {len(names):,}   added: {added}   "
      f"unresolved (clone stale? git fetch): {unresolved}")
print(f"revisions.json now holds {len(revs):,} revisions "
      f"({revs[0]['date']} .. {revs[-1]['date']})")
if added:
    print("offsets changed — re-run tools/build-index.sh to rebuild the index")
PY
