# Design

## The index

`index/versions.json` maps each (attribute, version) to the single newest
revision that shipped it, as an offset into `revisions.json`:

```json
{
  "revisionCount": 1396,
  "attrs": {
    "python3": { "3.8.9": 412, "3.12.10": 1204 }
  }
}
```

Storing one integer rather than every revision a version appeared in keeps the
file flat as revisions are added; otherwise a package that never changes version
accumulates an entry per revision.

Measured across encodings at 109 revisions:

| encoding | size | grows with revision count? |
|---|---|---|
| full revision list, names | 63.9 MB | yes |
| `[first, last]`, offsets | 4.1 MB | no |
| newest only, offset | **3.3 MB** | no |

Newest is also the build-correct choice: the most patched build, and the one Hydra produced most recently, so the most likely to still substitute.

## Revisions are not flake inputs

`flake.nix` has `inputs = { }` on purpose. Flake inputs are fetched eagerly: a flake with three nixpkgs inputs whose output referenced only the first still materialised all three, ~378 MB each. At 1,396 revisions that does not work.

Revisions are fetched with `builtins.fetchTree`, pinned by `narHash`, only when touched. Secondary reason: nixpkgs had no `flake.nix` before 20.03, so older revisions cannot be flake inputs at all.

## Performance

| what | cpu | values |
|---|---|---|
| `versionsOf` — index only, 0 revisions | 0.30s | 175k |
| one version via `versions.…` | 0.46s | 700k |
| 1 revision | 0.37s | 758k |
| 3 revisions | 0.62s | 1.22M |
| 3 packages, all same revision | **0.29s** | 767k |

Cost is per revision touched, not per package — revisions are memoised, so three packages from one revision cost the same as one. Each revision actually used costs ~378 MB of store, fetched once.