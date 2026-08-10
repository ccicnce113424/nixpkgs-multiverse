#!/usr/bin/env bash
# Refreshes releases.json with the current tip of every NixOS release channel.
#
# Unlike revisions.json, this file is MUTABLE. A release channel advances as
# backports land on its branch — 26.05 was ten weeks and several hundred
# commits past its release commit within one release cycle — and `at "26.05"`
# is meant to follow it, exactly like github:NixOS/nixpkgs/nixos-26.05 does.
#
# That mutability is why releases live in their own file. index/versions.json
# records each (attr, version) against an OFFSET into revisions.json, so an
# entry there can never change meaning: a backport that bumps a package version
# would silently invalidate every version recorded against that offset. Nothing
# in releases.json is ever indexed, so nothing here can invalidate anything.
#
# Source is the nix-releases bucket the unstable list also comes from:
#
#   nixos/<rel>/                     a release name is a top-level prefix that
#                                    looks like YY.MM, which excludes -small,
#                                    -aarch64, unstable and the virtualbox
#                                    image buckets
#   nixos-<rel>.<build>.<sha>/       a published bump; <build> is the Hydra
#                                    evaluation id and rises monotonically
#   nixos-<rel>beta<build>.<sha>/    a bump of the release branch from before
#                                    release day, skipped so that a release
#                                    appears here only once it has shipped
#
# The bump with the highest <build> is the channel tip. That ordering must be
# numeric: as text, nixos-26.05.590 sorts after nixos-26.05.1183.
set -euo pipefail

# releases.json lives in the caller's checkout, which under `nix run` is not
# where this script lives; the flake wrapper passes it down as MULTIVERSE_ROOT.
MT="${MULTIVERSE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

python3 - "$MT/releases.json" <<'PY'
import json, os, re, sys, urllib.parse, urllib.request

relfile = sys.argv[1]
BASE = 'https://nix-releases.s3.amazonaws.com/'
API = 'https://api.github.com/repos/NixOS/nixpkgs/commits/'

# A release name: exactly YY.MM. The bucket also holds 26.05-small,
# 21.05-aarch64, unstable, unstable-small and two virtualbox image sets.
RELEASE = re.compile(r'^\d\d\.\d\d$')

# Releases older than this are on the far side of enough nixpkgs churn that
# they are not worth carrying; 15.09 through 16.09 predate `overlays` and are
# already reachable through revisions.json by date or commit.
OLDEST = '17.03'


def prefixes(prefix):
    """Every immediate child 'directory' of an S3 prefix."""
    out, marker = [], ''
    while True:
        q = urllib.parse.urlencode({
            'delimiter': '/', 'prefix': prefix,
            'max-keys': '1000', 'marker': marker,
        })
        with urllib.request.urlopen(BASE + '?' + q, timeout=90) as r:
            xml = r.read().decode()
        got = re.findall(r'<Prefix>' + re.escape(prefix) + r'([^<]+)/</Prefix>', xml)
        if not got:
            break
        out += got
        if '<IsTruncated>true</IsTruncated>' not in xml:
            break
        marker = prefix + got[-1] + '/'
    return out


def expand(short):
    """Short hash -> (full commit, commit date) via the GitHub API."""
    req = urllib.request.Request(API + short, headers={
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'nixpkgs-multiverse',
    })
    token = os.environ.get('GITHUB_TOKEN')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(req, timeout=90) as r:
        commit = json.load(r)
    return commit['sha'], commit['commit']['committer']['date'][:10]


known = json.load(open(relfile)) if os.path.exists(relfile) else {}
names = sorted(n for n in prefixes('nixos/') if RELEASE.match(n) and n >= OLDEST)

out, moved, held, lookups = {}, [], 0, 0
for name in names:
    bump = re.compile(rf'^nixos-{re.escape(name)}\.(\d+)\.([0-9a-f]{{11,12}})$')
    published = [
        (int(m.group(1)), m.group(2))
        for d in prefixes(f'nixos/{name}/') if (m := bump.match(d))
    ]
    if not published:
        continue                                  # betas only: not shipped yet

    build, short = max(published)

    # An unchanged channel costs nothing: the short hash already on file
    # identifies the same commit, so neither the API nor a rewrite is needed.
    prior = known.get(name)
    if prior and prior['rev'].startswith(short) and prior.get('build') == build:
        out[name] = prior
        held += 1
        continue

    lookups += 1
    rev, date = expand(short)
    out[name] = {'rev': rev, 'date': date, 'build': build,
                 'name': f'nixos-{name}.{build}.{short}'}
    if prior:
        moved.append(f"{name} {prior['rev'][:12]} -> {rev[:12]} ({prior['date']} -> {date})")

json.dump(out, open(relfile, 'w'), indent=1, sort_keys=True)

print(f"releases: {len(out)} tracked   unchanged: {held}   "
      f"resolved: {lookups} GitHub API lookup(s)")
for line in moved:
    print(f"  advanced: {line}")
if not moved and lookups:
    print(f"  first run: recorded {lookups} release tips")
PY
