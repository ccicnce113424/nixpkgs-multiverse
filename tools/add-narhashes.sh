#!/usr/bin/env bash
# Adds a narHash to every entry in revisions.json.
#
# The hash is computed from a local git checkout rather than by downloading
# each GitHub tarball. That is sound because nixpkgs sets no `export-ignore`
# attributes, so `git archive` output and the GitHub tarball contain exactly
# the same files, and therefore hash identically. Verified against 25.05:
# the locally computed narHash was accepted by builtins.fetchTree under pure
# evaluation, and the resulting python3 derivation matched the fetchGit one
# byte for byte.
set -euo pipefail

MT="$(cd "$(dirname "$0")/.." && pwd)"
NIXPKGS="${NIXPKGS:-/home/fmzakari/code/github.com/NixOS/nixpkgs}"
REVFILE="$MT/revisions.json"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

python3 -c "import json;print('\n'.join(json.load(open('$REVFILE')).keys()))" | while read -r rev; do
  sha=$(python3 -c "import json;print(json.load(open('$REVFILE'))['$rev']['rev'])")
  printf "  %-6s " "$rev"

  # fetchGit materialises the revision in the store (cached after first use).
  path=$(nix-instantiate --eval --raw -E \
    "builtins.fetchGit { url = $NIXPKGS; rev = \"$sha\"; allRefs = true; }" 2>/dev/null || true)
  if [ -z "$path" ]; then echo "FETCH FAILED"; continue; fi

  hash=$(nix hash path --sri --type sha256 "$path" 2>/dev/null \
      || nix hash-path --sri --type sha256 "$path" 2>/dev/null || true)
  if [ -z "$hash" ]; then echo "HASH FAILED"; continue; fi

  echo "$rev $hash" >> "$TMP"
  echo "$hash"
done

python3 - "$REVFILE" "$TMP" <<'PY'
import json, sys
revfile, hashfile = sys.argv[1], sys.argv[2]
revs = json.load(open(revfile))
n = 0
for line in open(hashfile):
    parts = line.split()
    if len(parts) == 2 and parts[0] in revs and parts[1].startswith('sha256-'):
        revs[parts[0]]['narHash'] = parts[1]
        n += 1
json.dump(revs, open(revfile, 'w'), indent=1)
print(f"{n}/{len(revs)} revisions now carry a narHash")
PY
