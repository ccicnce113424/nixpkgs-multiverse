# Building the index

```sh
# refresh revisions.json from the channel archive
nix run .#fetch-unstable-revisions
# point releases.json at the current tip of every release channel
nix run .#fetch-releases
# extract versions + narHashes for every revision
nix run .#build-index
# only revisions the index has never covered
nix run .#build-index -- --incremental
# smoke test on the first 30
nix run .#build-index -- -n 30
# rebuild the index from cache, no evaluation
nix run .#build-index -- --merge-only
# extract this many revisions at once
nix run .#build-index -- -j 40
# fold version lifetimes out of the same extractions
nix run .#build-history
# only what the history has never covered
nix run .#build-history -- --incremental
# rewrite the status block at the top of the README
nix run .#update-readme-status
```

None of this needs a nixpkgs clone: revisions are resolved through the GitHub API and materialised with `nix flake prefetch`, which is what lets [the update workflow](../.github/workflows/update-index.yml) run hourly and commit whatever moved.

Set `NIXPKGS=/path/to/nixpkgs` to use a clone instead, which trades the download for a `git archive` and keeps the tree out of the store.
