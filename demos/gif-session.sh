#!/usr/bin/env bash
# Drives the asciinema recording behind demos/multiverse.gif.
#
#   nix shell nixpkgs#asciinema nixpkgs#asciinema-agg -c bash -c '
#     asciinema rec --overwrite -c "bash demos/gif-session.sh" /tmp/mv.cast
#     agg --font-size 20 --theme asciinema /tmp/mv.cast demos/multiverse.gif'
#
# Run from the repository root, and warm the store first or the recording will
# sit on a cold fetch:
#
#   for v in 3.6.6 3.8.9 3.10.11 3.12.10 3.14.6; do
#     nix shell ".#versions.python3.\"$v\"" -c python3 -V
#   done
#
# Every command is executed for real; nothing here is a canned transcript.
set -u

GREEN=$'\033[32m'
DIM=$'\033[90m'
RESET=$'\033[0m'

# Type a string out one character at a time so the recording reads like someone
# is at the keyboard, rather than snapping between finished lines.
type_out() {
  printf '%s$%s ' "$GREEN" "$RESET"
  local s=$1 i
  for ((i = 0; i < ${#s}; i++)); do
    printf '%s' "${s:i:1}"
    sleep 0.028
  done
  printf '\n'
}

run() {
  type_out "$1"
  # Drop only the "Git tree is dirty" notice, which every nix invocation emits
  # while this repo has uncommitted changes and which is pure noise in a
  # recording. Real warnings and errors still come through.
  eval "$1" 2> >(grep -v 'Git tree .* is dirty' >&2)
  printf '\n'
  sleep 0.7
}

say() {
  printf '%s%s%s\n' "$DIM" "$1" "$RESET"
  sleep 1.1
}

sleep 0.8
say "# every version of python nixpkgs ever shipped, from one flake input"
run "nix eval --raw --apply 'f: toString (builtins.length (f \"python3\"))' .#multiverse.x86_64-linux.versionsOf && echo ' versions'"

say "# run five of them, spanning eight years"
run "for v in 3.6.6 3.8.9 3.10.11 3.12.10 3.14.6; do nix shell \".#versions.python3.\\\"\$v\\\"\" -c python3 -V; done"

say "# nothing compiled. every one substituted from cache.nixos.org."
sleep 2.2
