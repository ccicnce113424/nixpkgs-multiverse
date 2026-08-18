#!/usr/bin/env bash
# Evaluates nixpkgs revisions with nix-eval-jobs to get exact store paths.
#
# One file per (revision, system) under index/.eval, holding every top-level
# attribute's outputs. This is the digest source the store-path artifacts are
# joined from: the channel listing says what Hydra built, and an evaluation at
# an explicit `system` says which path that is — see PLAN-issue12.md, where the
# name-keyed listing lookup this replaces is measured handing x86_64 users
# aarch64 binaries for two thirds of the index.
#
# Revisions are materialised into the store rather than into a scratch
# directory, unlike tools/build-index.sh. Forcing `outPath` hashes the tree the
# expression was imported from, so a temp directory whose name changes per run
# would change the digests with it; `nix flake prefetch` gives every runner the
# same `-source` path. Budget disk accordingly and collect garbage between
# batches.
#
# Usage:
#   tools/eval-outpaths.sh                        every revision, x86_64-linux
#   tools/eval-outpaths.sh --system aarch64-linux
#   tools/eval-outpaths.sh --offsets 1500:        offset range (python slice)
#   tools/eval-outpaths.sh --offsets 14,154,939   named offsets, comma separated
#   tools/eval-outpaths.sh -n 5                   first 5 revisions (smoke test)
#   tools/eval-outpaths.sh -j 8                   that many revisions at once
#   tools/eval-outpaths.sh --workers 4 --max-memory 4096
set -euo pipefail

# Data lives in the checkout, code lives next to this script. Under `nix run`
# those are two different places: the script is a store copy, while index/ must
# stay writable in the caller's checkout, which the flake wrapper passes down as
# MULTIVERSE_ROOT. Exported because -j re-invokes this script per revision.
MT="${MULTIVERSE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
export MULTIVERSE_ROOT="$MT"
HERE="$(cd "$(dirname "$0")" && pwd)"
# The evaluator this script drives nix-eval-jobs with lives in nix/, which
# `nix run` copies in as its own store path. See build-index.sh.
NIXDIR="${MULTIVERSE_NIX:-$(cd "$(dirname "$0")/../nix" && pwd)}"
export MULTIVERSE_NIX="$NIXDIR"
REVFILE="$MT/revisions.json"
WORK="$MT/index/.eval"

# -j re-invokes this script per revision and the children re-run this parsing,
# so every setting the child also needs is read back out of the environment the
# parent exported it into rather than reset to the default here.
SYSTEM="${SYSTEM:-x86_64-linux}"
OFFSETS=":"
LIMIT=0
JOBS=1
# Per-revision evaluation is split across nix-eval-jobs workers, each of which
# recycles when it hits --max-memory. Six at 3 GB walks the whole top level of a
# 2026 revision in ~50 seconds; the defaults are sized for one revision on a
# laptop, and -j on a big machine wants them lower.
WORKERS="${WORKERS:-6}"
MAXMEM="${MAXMEM:-3072}"
SUBCOMMAND=""
while [ $# -gt 0 ]; do
  case "$1" in
    --system) SYSTEM="$2"; shift 2 ;;
    --offsets) OFFSETS="$2"; shift 2 ;;
    -n) LIMIT="${2:-0}"; shift 2 ;;
    -j) JOBS="${2:-1}"; shift 2 ;;
    --workers) WORKERS="$2"; shift 2 ;;
    --max-memory) MAXMEM="$2"; shift 2 ;;
    # Internal: how -j hands one revision to a child invocation.
    --eval-one) SUBCOMMAND=eval-one; EVAL_SHA="$2"; EVAL_LABEL="$3"; shift 3 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
export SYSTEM WORKERS MAXMEM

if ! command -v nix-eval-jobs >/dev/null 2>&1; then
  echo "eval-outpaths: nix-eval-jobs is not on PATH." >&2
  echo "Enter the dev shell (nix develop), or run through nix run .#eval-outpaths." >&2
  exit 1
fi

mkdir -p "$WORK"

# The cache is keyed by the evaluator's own hash as well as by revision and
# system. Without it, editing eval-outpaths.nix leaves every cached file
# silently stale and a "successful" rerun quietly reuses the old logic.
EVALUATOR_HASH=$(sha256sum "$NIXDIR/eval-outpaths.nix" | cut -c1-8)
export EVALUATOR_HASH

# One revision: materialise it, walk every top-level attribute, reduce the run
# to the per-revision file. Touches no shared state, so -j can run as many of
# these at once as the machine has memory for.
eval_one() {
  local sha=$1 label=$2
  local dest="$WORK/$sha.$SYSTEM.$EVALUATOR_HASH.json"
  local src start=$SECONDS

  if [ -s "$dest" ]; then
    echo "  $label: cached"
    return 0
  fi

  if ! src=$(nix flake prefetch --json "github:NixOS/nixpkgs/$sha" 2>/dev/null \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["storePath"])'); then
    echo "  $label: FETCH FAILED (GitHub would not serve $sha)"
    return 1
  fi

  # nix-eval-jobs reports a failing attribute as a JSON line and carries on, so
  # a non-zero exit here means the run itself died — a revision modern Nix
  # cannot read at all, which keeps no file rather than a partial one.
  if ! nix-eval-jobs \
      --workers "$WORKERS" --max-memory-size "$MAXMEM" --no-instantiate \
      --arg revPath "$src" --argstr system "$SYSTEM" \
      "$NIXDIR/eval-outpaths.nix" > "$dest.jsonl" 2> "$dest.err"; then
    # The partial JSONL goes; the stderr stays, since a revision modern Nix
    # cannot read is exactly what phase 1 of PLAN-issue12.md wants recorded.
    rm -f "$dest.jsonl"
    echo "  $label: EVAL FAILED ($((SECONDS - start))s): $(grep -m1 -o 'error:.*' "$dest.err" | head -c 55)"
    return 1
  fi

  python3 "$HERE/reduce-eval-jobs.py" \
    --jobs "$dest.jsonl" --rev "$sha" --system "$SYSTEM" \
    --out "$dest" --errors "$WORK/$sha.$SYSTEM.$EVALUATOR_HASH.errors.json" \
    > "$dest.count"
  # The raw run is worth keeping only while it is unreduced: the JSONL is a
  # few hundred MB across a backfill and the stderr trace is larger still, and
  # the per-attribute reason survives in the errors file either way.
  rm -f "$dest.jsonl" "$dest.err"

  # One line per revision, emitted whole: with -j these interleave, and a
  # half-written line from another worker lands in the middle otherwise.
  echo "  $label: $(cat "$dest.count") in $((SECONDS - start))s"
  rm -f "$dest.count"
  return 0
}

# Re-entry point for -j: the parallel driver below runs this script once per
# revision, and each of those invocations lands here.
if [ "$SUBCOMMAND" = "eval-one" ]; then
  eval_one "$EVAL_SHA" "$EVAL_LABEL"
  exit $?
fi

# --offsets is a comma-separated list of python slices and bare indices, so
# that a validation run can name the four revisions it cares about and a
# backfill can hand over a contiguous range.
mapfile -t TARGETS < <(python3 -c "
import json
revs = list(enumerate(json.load(open('$REVFILE'))))
sel = []
for part in '$OFFSETS'.split(','):
    sel += revs[slice(*[int(x) if x else None for x in part.split(':')])] if ':' in part else [revs[int(part)]]
if $LIMIT: sel = sel[:$LIMIT]
for i, r in sel: print(r['rev'], f\"{i}:{r['date']}\")
")
echo "evaluating ${#TARGETS[@]} revisions   system=$SYSTEM evaluator=$EVALUATOR_HASH"

FAILURES=0
if [ "$JOBS" -gt 1 ]; then
  # xargs exits 123 when any child did, which is all the failure signal needed
  # here — the children report their own revisions by name.
  if ! printf '%s\n' "${TARGETS[@]}" | xargs -P "$JOBS" -L 1 bash "$0" --eval-one; then
    FAILURES=1
  fi
else
  for line in "${TARGETS[@]}"; do
    # shellcheck disable=SC2086
    set -- $line
    eval_one "$1" "$2" || FAILURES=$((FAILURES + 1))
  done
fi

echo "eval-outpaths: per-revision files in $WORK"
[ "$FAILURES" -eq 0 ]
