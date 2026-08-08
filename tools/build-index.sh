#!/usr/bin/env bash
# Builds index/versions.json by evaluating every revision named in
# revisions.json and recording which revisions provide which version of which
# attribute.
#
# Revisions are materialised with builtins.fetchGit, which produces
# byte-identical derivations to a checked-out tree, so nothing here perturbs
# cache hits. Each materialised revision costs ~378 MB of store; they are
# ordinary garbage-collectable paths once the index is built.
#
# Usage:
#   tools/build-index.sh curated   # ~30 demo packages, seconds per revision
#   tools/build-index.sh full      # every top-level attribute, ~8s per revision
set -euo pipefail

MT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-curated}"
NIXPKGS="${NIXPKGS:-/home/fmzakari/code/github.com/NixOS/nixpkgs}"
OUT="$MT/index/versions.json"
WORK="$MT/index/.per-rev"
mkdir -p "$WORK"

CURATED='[ "hello" "python3" "python2" "gcc" "clang" "nodejs" "go" "rustc"
           "ruby" "perl" "php" "openjdk" "postgresql" "mysql" "redis" "sqlite"
           "git" "curl" "openssl" "zlib" "jq" "cmake" "ninja" "bash"
           "coreutils" "vim" "emacs" "ffmpeg" "imagemagick" "tmux" ]'

mapfile -t REVS < <(python3 -c "
import json;print('\n'.join(json.load(open('$MT/revisions.json')).keys()))")
echo "revisions: ${#REVS[@]} (${REVS[0]} .. ${REVS[-1]})"

for rev in "${REVS[@]}"; do
  dest="$WORK/$rev.$MODE.json"
  if [ -s "$dest" ]; then
    echo "  $rev: cached ($(python3 -c "import json;print(len(json.load(open('$dest'))))") attrs)"
    continue
  fi

  sha=$(python3 -c "import json;print(json.load(open('$MT/revisions.json'))['$rev']['rev'])")
  printf "  %-6s " "$rev"
  start=$SECONDS

  # Materialise the revision into the store. Indexing uses fetchGit against a
  # local clone rather than the GitHub fetcher: it needs every revision, and a
  # clone already has them all without 22 tarball downloads.
  revpath=$(nix-instantiate --eval --raw -E \
    "builtins.fetchGit { url = $NIXPKGS; rev = \"$sha\"; allRefs = true; }" 2>/dev/null || true)
  if [ -z "$revpath" ]; then echo "FETCH FAILED"; continue; fi

  if [ "$MODE" = "full" ]; then argexpr=(--arg attrs 'null'); else argexpr=(--arg attrs "$CURATED"); fi

  if nix-instantiate --eval --strict --json \
       --arg revPath "$revpath" \
       "${argexpr[@]}" \
       "$MT/tools/extract-versions.nix" > "$dest.tmp" 2>"$dest.err"; then
    mv "$dest.tmp" "$dest"
    echo "$(python3 -c "import json;print(len(json.load(open('$dest'))))") attrs in $((SECONDS-start))s"
  else
    rm -f "$dest.tmp"
    echo "EVAL FAILED ($((SECONDS-start))s): $(grep -m1 -o 'error:.*' "$dest.err" | head -c 80)"
  fi
done

# Merge per-revision maps into {attr: {version: [rev, ...]}}, revisions in
# ascending order so consumers can take the last entry as the newest.
python3 - "$WORK" "$MODE" "$OUT" "$MT/revisions.json" <<'PY'
import json, os, sys
work, mode, out, revfile = sys.argv[1:5]
order = list(json.load(open(revfile)).keys())

index = {}
for rev in order:
    p = os.path.join(work, f'{rev}.{mode}.json')
    if not os.path.exists(p):
        continue
    for attr, version in json.load(open(p)).items():
        index.setdefault(attr, {}).setdefault(version, []).append(rev)

json.dump(index, open(out, 'w'), indent=1, sort_keys=True)
total = sum(len(v) for v in index.values())
print(f"index: {len(index)} attrs, {total} distinct (attr, version) pairs "
      f"-> {out} ({os.path.getsize(out)/1e6:.1f} MB)")
PY
