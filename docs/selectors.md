# Selectors

A selector is how you name a revision. It is one vocabulary, shared by the Nix
API and by `mvs`, so a selector that works in `nix build .#<sel>.<attr>` works
in `mvs query at <sel> <attr>` and vice versa.

```console
$ nix run github:fzakaria/nixpkgs-multiverse#2022-03-15.hello
$ nix run github:fzakaria/nixpkgs-multiverse#mvs -- query at 2022-03-15 hello
```

## The five forms

| selector | example                   | resolves to                                          |
| -------- | ------------------------- | ---------------------------------------------------- |
| `tip`    | `tip`                     | the newest indexed revision that can be materialised |
| release  | `26.05`                   | that channel's current tip, it **moves**             |
| date     | `2022-03-15`              | the newest indexed revision on or before that date   |
| label    | `2021-07-18-967d40bec14b` | the revision that commit names                       |
| commit   | `967d40bec14b`            | the revision that commit names                       |

They are tried in that order, which is what settles the cases where a string
could be read two ways.

### Tip

The newest revision the _index_ knows is the `tip`. It is
frozen at whatever the last indexing run captured and drifts further behind the
live channel until the index is rebuilt.

`tip` means the same revision everywhere, including on the [fast
path](./nix-api.md#the-fast-path).

### Releases

A release name is a `major.minor` from the release table: `26.05`, `24.11`,
back to `13.10`. It resolves to the current tip of that channel, which means
**it is not a snapshot**. Backports land on `release-26.05` for the whole life
of the release and a release selector follows them, exactly as
`github:NixOS/nixpkgs/nixos-26.05` does.

If you need a result that cannot drift, select by date or by commit. This is
the one distinction in the whole vocabulary that will surprise you later if you
skip it — see [releases move, revisions do
not](./nix-api.md#releases-move-revisions-do-not).

### Dates

A date is exactly `YYYY-MM-DD`, ten characters, zero-padded. `2022-3-15` is not
a date, and it is not valid hex either, so it is rejected outright rather than
quietly searched for as something else.

It resolves to the newest indexed revision **on or before** that date, so a date
with no channel bump on it still resolves to whatever was current that day.
A date earlier than the index reaches is an error rather than a silent clamp.

### Labels

A label is `YYYY-MM-DD-<commit prefix>`, the form `revOf` and `mvs` hand back:

```console
nix-repl> multiverse.x86_64-linux.revOf "python3" "3.8.9"
"2021-07-18-967d40bec14b"
```

Only the commit half is a search key. The date half is decoration for the
reader and is ignored when resolving, so a label whose date is wrong still
resolves, and a label whose _commit_ is unknown is an error even if the date
is fine.

### Commits

A commit is lowercase hex, either a prefix or the full 40 characters. Twelve is
the conventional length and what the index hands back.

Uppercase is rejected rather than folded: the index writes commits in
lowercase, and accepting uppercase would make a prefix search silently miss.

The index holds nixos-unstable channel bumps, not every commit in nixpkgs.
A commit that exists in nixpkgs but not in the index is expected and is an
error, not an empty result.

## Where the forms collide

Two overlaps are worth knowing, and both are settled by the resolution order
above:

- **A release beats a commit.** `26.05` is checked against the release table
  before anything else, so it is the channel. A bare `26` is not a release
  name, and _is_ valid hex, so it is a commit prefix search.
- **A label beats a date.** `2021-07-18-967d40bec14b` starts with something
  that looks like a date, but the label shape is tested first, so the trailing
  commit is what resolves it.

## Where releases are not accepted

Anything that reads _history_ rejects a release selector. A release tip is a
moving channel head and not a revision the index holds an offset for.

| accepts releases                             | rejects releases                 |
| -------------------------------------------- | -------------------------------- |
| `at`, `flakeAt`, `daysBehind` (as an anchor) | `versionAt`, `fast.*`            |
| `mvs query rev`                              | `mvs query at`, `mvs query diff` |

`fast.*` refuses for its own reason, which is not that the paths are missing —
release channels publish listings just as unstable does. The store-path index
is keyed by `(attribute, version)`, and that pair names a different build on
each branch, so unstable's digest is the wrong path for a release even at an
identical version. See [why releases have no fast
path](./nix-api.md#why-releases-have-no-fast-path).

The error tells you what to do instead: select by date or commit, or read the
version off the package set:

```console
$ nix run github:fzakaria/nixpkgs-multiverse#mvs -- query at 26.05 hello
mvs: 26.05 is a release: a channel tip that moves, not a revision the index has an offset for.
Its head as of 2026-08-12 is 9f78f44a8794. Select by date or by commit instead — `mvs query at 2026-08-12 <attr>`.
```

## Selectors as an anchor

`daysBehind` takes any selector `at` takes, but uses it only for its _date_:

```nix
mv.daysBehind "26.05" 7
```

That reads "unstable as it stood a week before the 26.05 channel tip", not a
walk back along `release-26.05`. The anchor supplies a date; the search always
runs over the unstable revision list. See [a soak
period](./nix-api.md#a-soak-period).

## Resolving one without using it

`mvs query rev` turns any selector into the commit, date and label it names,
which is the quickest way to check that a selector means what you think:

```console
$ nix run github:fzakaria/nixpkgs-multiverse#mvs -- query rev 2022-03-15
73ad5f9e147c0d2a2061f1d4bd91e05078dc0b58
  date    2022-03-14
  label   2022-03-14-73ad5f9e147c
  offset  740
  channel nixos-22.05pre360796.73ad5f9e147
  narHash sha256-ulGq3W5XsrBMU/u5k9d4oPy65pQTkunR4HKKtTq0RwY=
```

The Nix side answers the same question through provenance, which every package
set from the multiverse carries:

```console
nix-repl> (mv.at "2022-03-15").multiverse
{ date = "2022-03-14"; label = "2022-03-14-73ad5f9e147c";
  rev = "73ad5f9e147c0d2a2061f1d4bd91e05078dc0b58"; }
```

Note in both cases that `2022-03-15` resolved to a revision dated the 14th —
the newest one on or before the date asked for.
