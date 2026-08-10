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
# A short revision is expanded to a full commit and a date through the local
# nixpkgs clone when there is one, and through the GitHub API when there is not.
# The API path is what lets this run on CI, where a 5 GB clone is not worth its
# minutes; only genuinely new channels are ever looked up, because everything
# already in revisions.json is matched by short-hash prefix first.
#
# Existing entries keep their offset — only new revisions are appended, and the
# file is re-sorted by date. Reordering would invalidate index/versions.json,
# which stores offsets into this array, so it is refused rather than performed.
set -euo pipefail

# revisions.json must stay writable in the caller's checkout, which under
# `nix run` is not where this script lives; the flake wrapper passes that
# directory down as MULTIVERSE_ROOT.
MT="${MULTIVERSE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# Optional. Point NIXPKGS at a clone to resolve new revisions locally; with no
# clone they are resolved through the GitHub API instead.
NIXPKGS="${NIXPKGS:-}"
MIN_YEAR="${1:-2017}"

python3 - "$NIXPKGS" "$MIN_YEAR" "$MT/revisions.json" <<'PY'
import json, os, re, subprocess, sys, urllib.parse, urllib.request

nixpkgs, min_year, revfile = sys.argv[1], int(sys.argv[2]), sys.argv[3]
BASE = 'https://nix-releases.s3.amazonaws.com/'
API = 'https://api.github.com/repos/NixOS/nixpkgs/commits/'

# A ceiling on GitHub API lookups per run. Only channels this file has never
# seen reach the API, so a healthy run spends one or two; a much larger number
# means the prefix match is broken and the run should stop rather than spend an
# hour's rate limit finding out.
MAX_API_LOOKUPS = 50

# The clone is optional. Without one — CI, or a fresh checkout — every lookup
# goes through the API instead.
have_clone = bool(nixpkgs) and os.path.isdir(os.path.join(nixpkgs, '.git'))

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

# Short hash -> existing entry. The channel name embeds 11 or 12 hex digits, so
# both lengths are indexed and a channel already on file is recognised without
# git or a network round trip. This is what keeps an incremental run cheap.
by_prefix = {}
for r in revs:
    by_prefix[r['rev'][:11]] = r
    by_prefix[r['rev'][:12]] = r


def resolve_git(short):
    """Full commit and commit date from the local clone, or None."""
    try:
        full = subprocess.run(
            ['git', '-C', nixpkgs, 'rev-parse', '--verify', f'{short}^{{commit}}'],
            capture_output=True, text=True, check=True).stdout.strip()
        date = subprocess.run(
            ['git', '-C', nixpkgs, 'log', '-1', '--format=%cs', full],
            capture_output=True, text=True, check=True).stdout.strip()
    except subprocess.CalledProcessError:
        return None
    return full, date


def resolve_api(short):
    """Same, from the GitHub commits API. GITHUB_TOKEN lifts the rate limit."""
    req = urllib.request.Request(API + short, headers={
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'nixpkgs-multiverse',
    })
    token = os.environ.get('GITHUB_TOKEN')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            commit = json.load(r)
    except Exception:
        return None
    return commit['sha'], commit['commit']['committer']['date'][:10]


added = unresolved = named = api_calls = 0
original_order = [r['rev'] for r in revs]

for name in names:
    m = re.search(r'\.([0-9a-f]{11,12})$', name)
    if not m:
        continue
    short = m.group(1)

    # Already on file: record which S3 object published it, which is what the
    # README status block links to, and move on.
    known = by_prefix.get(short)
    if known is not None:
        if known.get('name') != name:
            known['name'] = name
            named += 1
        continue

    if have_clone:
        got = resolve_git(short)
    elif api_calls < MAX_API_LOOKUPS:
        api_calls += 1
        got = resolve_api(short)
    else:
        got = None
    if got is None:
        unresolved += 1
        continue

    full, date = got
    if int(date[:4]) < min_year:
        continue
    entry = {"rev": full, "date": date, "channel": "nixos-unstable", "name": name}
    revs.append(entry)
    by_prefix[full[:11]] = entry
    by_prefix[full[:12]] = entry
    added += 1

revs.sort(key=lambda r: (r['date'], r['rev']))

# index/versions.json stores offsets into this array, so an entry that lands
# anywhere other than the end silently repoints every version recorded after it.
# That is a full rebuild, not an append, and it is the caller's decision to make.
if [r['rev'] for r in revs][:len(original_order)] != original_order:
    sys.exit("revisions.json: a new revision sorted before an existing one; "
             "offsets would shift. Nothing written — rebuild the index by hand.")

json.dump(revs, open(revfile, 'w'), indent=1)
source = 'clone' if have_clone else f'GitHub API ({api_calls} lookups)'
print(f"archived channels: {len(names):,}   added: {added}   "
      f"named: {named}   unresolved: {unresolved}   via: {source}")
print(f"revisions.json now holds {len(revs):,} revisions "
      f"({revs[0]['date']} .. {revs[-1]['date']})")
if added:
    print("new revisions appended — run tools/build-index.sh --incremental to index them")
PY
