# Comparisons

Several tools in the Nix ecosystem look adjacent to this one, and a few share
its mechanism outright. The useful way to tell them apart is to ask what
question each one indexes an answer to.


| | indexes | across | data lives | needs a nixpkgs? |
|---|---|---|---|---|
| nix-index / comma | file → attribute | one channel snapshot | downloaded database | no, to query |
| fastpkgs | attribute → store path | the current tree | release assets, pinned | no |
| devbox / Nixhub | version → commit, store path | nixpkgs history | hosted API | no, to resolve |
| flox | version → commit | nixpkgs history | hosted catalog | no, to resolve |
| **multiverse** | version → revision, store path | 13 years of unstable | JSON in the flake | no, on the fast road |

## nix-index and comma

[nix-index](https://github.com/nix-community/nix-index) builds a file listing
for a nixpkgs snapshot, so `nix-locate bin/rg` says `ripgrep.out`.
[comma](https://github.com/nix-community/comma) puts a command line on it: `, rg`
finds the attribute providing `rg` and runs it, installing nothing.

This is the perpendicular axis. nix-index scans **wide** every attribute at
one revision whereas multiverse scans **deep**, one attribute over every
revision.

Neither answers the other's question. `nix-locate` cannot tell you which revision had ripgrep 13, and `mvs query search` cannot tell you that the
binary you want is called `rg` and lives in `ripgrep`.

They compose in the obvious direction: comma answers *what provides this
command*, and the answer is an attribute name, which is exactly what
[`mvs`](./cli.md) takes as input.

```console
# which package?  -> ripgrep.out
$ nix-locate bin/rg
# which versions? -> 13.0.0 … 15.2.0
$ mvs query versions ripgrep
# that one.
$ mvs run ripgrep@13.0.0
```

The version comma gives you is whichever one its database's channel carries.


## fastpkgs

[fastpkgs](https://github.com/tomberek/fastpkgs) is the closest relative by
*mechanism*, and this project takes its fast path from it directly. It scrapes
`nix-eval-jobs` over nixpkgs, keeps the entries the binary cache actually has,
and rebuilds them as **fake derivations**, so Nix treats them as substitutable without
evaluating anything.

`multiverse.fast.*` and the fast road in `mvs run` are the same trick, credited
in `multiverse.nix`. See
[the store-path index](./store-paths.md).

The difference is the key. fastpkgs is keyed by **attribute at the current
tree**: it makes today's nixpkgs fast to reach. The multiverse store-path index
is keyed by **(attribute, version) across thirteen years**, plus the reference
graph between the paths, which is what makes `mvs deps`, `mvs size` and
`mvs rdeps` possible.

## devbox and Nixhub

[devbox](https://www.jetify.com/devbox) is the closest relative by *intent*.
`devbox add python@3.8` resolves the version through
[Nixhub](https://www.nixhub.io/), Jetify's index built from Hydra's build outputs.

Where they differ:
* Nixhub is a service. `mvs` resolves from JSON that works offline.
* devbox is an environment manager.

## flox

[flox](https://flox.dev/) is an environment manager over a hosted catalog with
its own binary cache: `flox init`, `flox install python@3.8`, `flox activate`,
plus publishing and sharing on top.

The interesting overlap is **package groups** which is what [`mvs solve`](./cli.md#one-revision-for-several-packages) computes.

Where they differ:
* flox is a service. `mvs` resolves from JSON that works offline.
* flox is an environment manager.


## What this is not

* **Not an environment manager.** No activation, no services, no shell to
  enter, no containers. `mvs shell` is a thin wrapper over `nix shell`, and for
  a development environment `solve` gives you a revision to pin, not a runtime.
* **Not a build service.** Nothing here compiles anything: every version the
  store-path index matched is a [cache.nixos.org](https://cache.nixos.org)
  hit that Hydra produced when it was current. Unfree and broken attributes
  are the ones Hydra never built, so they have no store path and [no fast
  path](./nix-api.md#attributes-with-no-fast-path) however the eval path still
  serves them, given the `config` to allow it.
* **Not a file index.** "Which package has this binary" is nix-index's purpose.
* **Only nixos-unstable.** The revision list is computed from the unstable channel's bump. Release branches appear as [releases](./nix-api.md#releases-move-revisions-do-not), which are moving tips rather than indexed history. They are served by the eval path only: the store-path index is keyed per version rather than per branch, and a release builds nearly every package to a different path than unstable does. See [why releases have no fast path](./nix-api.md#why-releases-have-no-fast-path).
