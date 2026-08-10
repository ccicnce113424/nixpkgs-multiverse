#!/usr/bin/env bash
# Fills in narHash for revisions that lack one.
#
# build-index.sh computes narHash while it has a revision checked out, so this
# is only needed for revisions whose extraction predates that, or which were
# added to revisions.json without being indexed. By default it only visits
# revisions the index actually references, since those are the ones the GitHub
# fetcher needs; pass --all to cover every revision.
#
# The hash comes from a plain `git archive` checkout rather than a downloaded
# tarball. That is sound because nixpkgs sets no `export-ignore` attributes, so
# the archive and the GitHub tarball contain identical files. Verified against
# 25.05: the locally computed narHash was accepted by builtins.fetchTree under
# pure evaluation, and produced a byte-identical derivation.
set -euo pipefail

# revisions.json must stay writable in the caller's checkout, which under
# `nix run` is not where this script lives; the flake wrapper passes that
# directory down as MULTIVERSE_ROOT.
MT="${MULTIVERSE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# Optional. Point NIXPKGS at a clone to hash revisions without downloading
# them; with no clone every revision goes through `nix flake prefetch` instead.
NIXPKGS="${NIXPKGS:-}"
REVFILE="$MT/revisions.json"
ALL=0
[ "${1:-}" = "--all" ] && ALL=1

mapfile -t NEED < <(python3 -c "
import json, os
revs = json.load(open('$REVFILE'))
if $ALL:
    targets = range(len(revs))
else:
    idx = json.load(open('$MT/index/versions.json'))
    targets = sorted(set(v for vs in idx['attrs'].values() for v in vs.values()))
for i in targets:
    if 'narHash' not in revs[i]:
        print(i, revs[i]['rev'])
")

echo "revisions needing a narHash: ${#NEED[@]}"
n=0
for line in "${NEED[@]}"; do
  set -- $line; off=$1; sha=$2; n=$((n+1))

  # Hash a `git archive` checkout when the clone holds the revision, and let
  # `nix flake prefetch` report the hash otherwise. The two agree — that is the
  # premise of the whole file, verified against 25.05 — so which one runs is
  # only a question of whether a download is needed.
  tmp=""
  hash=""
  if [ -n "$NIXPKGS" ] && git -C "$NIXPKGS" cat-file -e "$sha^{commit}" 2>/dev/null; then
    tmp=$(mktemp -d)
    if git -C "$NIXPKGS" archive "$sha" 2>/dev/null | tar -x -C "$tmp"; then
      hash=$(nix hash path --sri --type sha256 "$tmp" 2>/dev/null || true)
    fi
  else
    if prefetched=$(nix flake prefetch --json "github:NixOS/nixpkgs/$sha" 2>/dev/null); then
      hash=$(printf '%s' "$prefetched" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hash"])')
    fi
  fi

  if [ -n "$hash" ]; then
    python3 -c "
import json
p = '$REVFILE'
revs = json.load(open(p))
revs[$off]['narHash'] = '$hash'
json.dump(revs, open(p, 'w'), indent=1)
"
    printf "  [%d/%d] %s %s\n" "$n" "${#NEED[@]}" "${sha:0:12}" "${hash:0:28}..."
  else
    printf "  [%d/%d] %s HASH FAILED (not in clone, and GitHub would not serve it?)\n" \
      "$n" "${#NEED[@]}" "${sha:0:12}"
  fi

  if [ -n "$tmp" ]; then
    rm -rf "$tmp"
  fi
done
