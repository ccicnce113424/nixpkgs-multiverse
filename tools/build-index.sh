#!/usr/bin/env bash
# Builds index/versions.json from revisions.json.
#
# For each revision: check it out with `git archive` into a temp directory,
# extract {attr: version} for every top-level attribute, and compute the
# revision's narHash from the same checkout. One pass produces both.
#
# The checkout deliberately never enters the nix store. Forcing `drv.version`
# does not copy a tree into the store, so indexing costs one ~280 MB scratch
# directory at a time and zero store growth — measured. Materialising each
# revision into the store instead would need ~519 GB for the full revision set.
#
# Usage:
#   tools/build-index.sh                 # index every revision
#   tools/build-index.sh -n 30           # first 30 revisions only (smoke test)
#   tools/build-index.sh --releases      # only revisions with a release label
#   tools/build-index.sh --merge-only    # rebuild the index from cache, no eval
#   tools/build-index.sh --incremental   # only revisions the index has never
#                                        # covered, merged into the existing one
set -euo pipefail

# Data lives in the checkout, code lives next to this script. Under `nix run`
# those are two different places: the script is a store copy, while
# revisions.json and index/ must stay writable in the caller's checkout, which
# the flake wrapper passes down as MULTIVERSE_ROOT.
MT="${MULTIVERSE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Optional. Point NIXPKGS at a clone to check revisions out of it rather than
# downloading them; with no clone every revision is materialised through
# `nix flake prefetch` instead.
NIXPKGS="${NIXPKGS:-}"
REVFILE="$MT/revisions.json"
OUT="$MT/index/versions.json"
WORK="$MT/index/.per-rev"
LIMIT=0
ONLY_RELEASES=0
MERGE_ONLY=0
INCREMENTAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    -n) LIMIT="${2:-0}"; shift 2 ;;
    --releases) ONLY_RELEASES=1; shift ;;
    --merge-only) MERGE_ONLY=1; shift ;;
    --incremental) INCREMENTAL=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$WORK"
FAILURES=0

# The extraction cache is keyed by the extractor's own hash as well as the
# revision. Without this, editing extract-versions.nix leaves every cached file
# silently stale and a "successful" rebuild quietly reuses the old logic.
EXTRACTOR_HASH=$(sha256sum "$HERE/extract-versions.nix" | cut -c1-8)

if [ "$MERGE_ONLY" -eq 0 ]; then
  # `revisionCount` records how many revisions the committed index was built
  # against, so everything at or past that offset is exactly what an incremental
  # run has never looked at.
  mapfile -t TARGETS < <(python3 -c "
import json, os
revs = json.load(open('$REVFILE'))
sel = [(i, r) for i, r in enumerate(revs) if not $ONLY_RELEASES or r.get('release')]
if $INCREMENTAL:
    covered = json.load(open('$OUT'))['revisionCount'] if os.path.exists('$OUT') else 0
    sel = [(i, r) for i, r in sel if i >= covered]
if $LIMIT: sel = sel[:$LIMIT]
for i, r in sel: print(i, r['rev'], r.get('release') or r['date'])
")
  echo "indexing ${#TARGETS[@]} revisions   extractor=$EXTRACTOR_HASH"

  for line in "${TARGETS[@]}"; do
    set -- $line; off=$1; sha=$2; label=$3
    dest="$WORK/$sha.$EXTRACTOR_HASH.json"
    if [ -s "$dest" ]; then
      echo "  $label: cached"
      continue
    fi

    printf "  %-22s " "$label"
    start=$SECONDS

    # Two ways to get the tree. The clone is preferred: `git archive` into a
    # scratch directory costs no store space and no download. Without a usable
    # clone — CI, or a revision the clone has never fetched — `nix flake
    # prefetch` downloads the GitHub tarball into the store instead and hands
    # back the very narHash that builtins.fetchTree will later expect.
    tmp=""
    if [ -n "$NIXPKGS" ] && git -C "$NIXPKGS" cat-file -e "$sha^{commit}" 2>/dev/null; then
      tmp=$(mktemp -d)
      if ! git -C "$NIXPKGS" archive "$sha" 2>/dev/null | tar -x -C "$tmp"; then
        rm -rf "$tmp"; echo "CHECKOUT FAILED (rev not in clone? try git fetch)"
        FAILURES=$((FAILURES + 1)); continue
      fi
      src="$tmp"
      # narHash from the same checkout: identical to what fetchTree computes for
      # the GitHub tarball, since nixpkgs sets no export-ignore attributes.
      narhash=$(nix hash path --sri --type sha256 "$tmp" 2>/dev/null || true)
    else
      if ! prefetched=$(nix flake prefetch --json "github:NixOS/nixpkgs/$sha" 2>/dev/null); then
        echo "FETCH FAILED (no clone, and GitHub would not serve $sha)"
        FAILURES=$((FAILURES + 1)); continue
      fi
      src=$(printf '%s' "$prefetched" | python3 -c 'import json,sys; print(json.load(sys.stdin)["storePath"])')
      narhash=$(printf '%s' "$prefetched" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hash"])')
    fi

    if nix-instantiate --eval --strict --json \
         --arg revPath "$src" --arg attrs 'null' \
         "$HERE/extract-versions.nix" > "$dest.tmp" 2>"$dest.err"; then
      mv "$dest.tmp" "$dest"
      n=$(python3 -c "import json;print(len(json.load(open('$dest'))))")
      if [ -n "$narhash" ]; then
        python3 -c "
import json
revs = json.load(open('$REVFILE'))
revs[$off]['narHash'] = '$narhash'
json.dump(revs, open('$REVFILE','w'), indent=1)
"
      fi
      echo "$n attrs in $((SECONDS-start))s"
    else
      rm -f "$dest.tmp"
      FAILURES=$((FAILURES + 1))
      echo "EVAL FAILED ($((SECONDS-start))s): $(grep -m1 -o 'error:.*' "$dest.err" | head -c 55)"
    fi
    if [ -n "$tmp" ]; then
      rm -rf "$tmp"
    fi
  done
  echo
fi

# Merge whatever the cache holds into { revisionCount, attrs }.
#
# Values are offsets into revisions.json and only the NEWEST revision shipping
# each version is kept, so the index stays flat as revisions are added rather
# than growing a per-revision entry for every unchanged package.
#
# An incremental merge folds only the new offsets into the committed index
# instead of rebuilding from index/.per-rev. That is what makes the whole thing
# runnable on CI, where the cache does not exist and a rebuild from an empty
# cache would silently produce an empty index.
python3 - "$WORK" "$EXTRACTOR_HASH" "$OUT" "$REVFILE" "$INCREMENTAL" <<'PY'
import json, os, sys
work, ehash, out, revfile, incremental = sys.argv[1:6]
incremental = incremental == "1"
revs = json.load(open(revfile))

# Offsets below this were already folded in by an earlier run; a full rebuild
# reconsiders all of them.
covered = 0
attrs = {}
if incremental and os.path.exists(out):
    prior = json.load(open(out))
    covered, attrs = prior['revisionCount'], prior['attrs']

indexed = 0
for off in range(covered, len(revs)):          # oldest first: later writes win
    p = os.path.join(work, f"{revs[off]['rev']}.{ehash}.json")
    if not os.path.exists(p):
        # An incremental run must not claim coverage past a revision it failed
        # to extract, or that revision is skipped for good. Stop here and let
        # the next run retry it.
        if incremental:
            print(f"stopping at offset {off}: no extraction on disk, will retry next run")
            break
        continue
    indexed += 1
    for attr, version in json.load(open(p)).items():
        attrs.setdefault(attr, {})[version] = off
    covered = off + 1

# A full rebuild has considered every revision, whether or not each one left an
# extraction behind; an incremental run only claims the prefix it got through.
if not incremental:
    covered = len(revs)

json.dump({"revisionCount": covered, "attrs": attrs}, open(out, 'w'), sort_keys=True)
pairs = sum(len(v) for v in attrs.values())
merged = f"{indexed} new" if incremental else f"{indexed}/{len(revs)}"
print(f"index: {merged} revisions merged, covering {covered}/{len(revs)}, "
      f"{len(attrs):,} attrs, {pairs:,} (attr, version) pairs")
print(f"       -> {out} ({os.path.getsize(out)/1e6:.2f} MB)")
PY

# An incremental run indexes revisions that landed on nixos-unstable days ago;
# one of those failing to evaluate is a bug to look at, not a casualty to shrug
# off, and the index that comes out stops short of the revisions.json beside it.
# Failing here is what keeps the update job from committing that pair.
#
# A full rebuild is held to a looser standard on purpose: it reaches back to
# 2015, and a handful of those revisions will never evaluate on a current Nix.
if [ "$INCREMENTAL" -eq 1 ] && [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES revision(s) failed to index; index left behind revisions.json" >&2
  exit 1
fi
