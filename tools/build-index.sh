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
set -euo pipefail

MT="$(cd "$(dirname "$0")/.." && pwd)"
NIXPKGS="${NIXPKGS:-/home/fmzakari/code/github.com/NixOS/nixpkgs}"
REVFILE="$MT/revisions.json"
OUT="$MT/index/versions.json"
WORK="$MT/index/.per-rev"
LIMIT=0
ONLY_RELEASES=0
MERGE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    -n) LIMIT="${2:-0}"; shift 2 ;;
    --releases) ONLY_RELEASES=1; shift ;;
    --merge-only) MERGE_ONLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$WORK"

# The extraction cache is keyed by the extractor's own hash as well as the
# revision. Without this, editing extract-versions.nix leaves every cached file
# silently stale and a "successful" rebuild quietly reuses the old logic.
EXTRACTOR_HASH=$(sha256sum "$MT/tools/extract-versions.nix" | cut -c1-8)

if [ "$MERGE_ONLY" -eq 0 ]; then
  mapfile -t TARGETS < <(python3 -c "
import json
revs = json.load(open('$REVFILE'))
sel = [(i, r) for i, r in enumerate(revs) if not $ONLY_RELEASES or r.get('release')]
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
    tmp=$(mktemp -d)
    if ! git -C "$NIXPKGS" archive "$sha" 2>/dev/null | tar -x -C "$tmp"; then
      rm -rf "$tmp"; echo "CHECKOUT FAILED (rev not in clone? try git fetch)"; continue
    fi

    # narHash from the same checkout: identical to what fetchTree computes for
    # the GitHub tarball, since nixpkgs sets no export-ignore attributes.
    narhash=$(nix hash path --sri --type sha256 "$tmp" 2>/dev/null || true)

    if nix-instantiate --eval --strict --json \
         --arg revPath "$tmp" --arg attrs 'null' \
         "$MT/tools/extract-versions.nix" > "$dest.tmp" 2>"$dest.err"; then
      mv "$dest.tmp" "$dest"
      n=$(python3 -c "import json;print(len(json.load(open('$dest'))))")
      [ -n "$narhash" ] && python3 -c "
import json
revs = json.load(open('$REVFILE'))
revs[$off]['narHash'] = '$narhash'
json.dump(revs, open('$REVFILE','w'), indent=1)
"
      echo "$n attrs in $((SECONDS-start))s"
    else
      rm -f "$dest.tmp"
      echo "EVAL FAILED ($((SECONDS-start))s): $(grep -m1 -o 'error:.*' "$dest.err" | head -c 55)"
    fi
    rm -rf "$tmp"
  done
  echo
fi

# Merge whatever the cache holds into { revisionCount, attrs }.
#
# Values are offsets into revisions.json and only the NEWEST revision shipping
# each version is kept, so the index stays flat as revisions are added rather
# than growing a per-revision entry for every unchanged package.
python3 - "$WORK" "$EXTRACTOR_HASH" "$OUT" "$REVFILE" <<'PY'
import json, os, sys
work, ehash, out, revfile = sys.argv[1:5]
revs = json.load(open(revfile))

attrs, indexed = {}, 0
for off, r in enumerate(revs):                 # oldest first: later writes win
    p = os.path.join(work, f"{r['rev']}.{ehash}.json")
    if not os.path.exists(p):
        continue
    indexed += 1
    for attr, version in json.load(open(p)).items():
        attrs.setdefault(attr, {})[version] = off

json.dump({"revisionCount": len(revs), "attrs": attrs}, open(out, 'w'), sort_keys=True)
pairs = sum(len(v) for v in attrs.values())
print(f"index: {indexed}/{len(revs)} revisions indexed, {len(attrs):,} attrs, "
      f"{pairs:,} (attr, version) pairs")
print(f"       -> {out} ({os.path.getsize(out)/1e6:.2f} MB)")
PY
