{
  description = "Every nixpkgs revision, reachable from a single evaluation";

  # Deliberately empty.
  #
  # It is tempting to declare each indexed revision as a flake input. Do not:
  # flake inputs are fetched EAGERLY. Measured on this repo, a flake with three
  # nixpkgs inputs whose output referenced only the first still materialised all
  # three (~378 MB of store each). At 13 revisions that is ~4.9 GB fetched
  # before any evaluation can begin, and it grows linearly with every revision
  # added — which would defeat the entire point of a multiverse.
  #
  # Revisions are instead fetched lazily from index/versions.json via
  # builtins.fetchTree, so only the revisions actually touched are ever
  # materialised, and the number of indexed revisions can grow without bound.
  inputs = { };

  outputs =
    { self, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      # nixpkgs' lib is not available here — the whole point is that this flake
      # has no inputs — so genAttrs is spelled out with builtins.
      forAllSystems =
        f:
        builtins.listToAttrs (
          map (system: {
            name = system;
            value = f system;
          }) systems
        );

      # The dev shell and the tool wrappers are built out of a multiverse
      # revision. That keeps `inputs = { }` intact: nothing is fetched unless
      # somebody actually asks for a shell or runs a tool.
      #
      # The newest *release* rather than `tip`, for two reasons. Bash and python
      # from last Tuesday's channel bump are no better than bash and python from
      # the release, and pinning to something that moves twice a year means the
      # hourly update job reuses one closure instead of building a fresh one
      # every time nixos-unstable advances.
      pkgsFor =
        system:
        let
          mv = import ./multiverse.nix { inherit system; };
        in
        mv.at (builtins.elemAt mv.releases (builtins.length mv.releases - 1));

      # What tools/*.sh reach for. `bash` is in the list because the scripts use
      # `mapfile`, which is bash 4+ — the bash 3.2 macOS still ships fails on it.
      #
      # `nix` is deliberately absent: the scripts call `nix hash path` and
      # `nix-instantiate` against the caller's own store, so the host's nix is
      # the correct one to use.
      toolDeps = pkgs: [
        pkgs.bash
        pkgs.python3
        pkgs.gitMinimal
        pkgs.gnutar
        pkgs.gnugrep
        pkgs.coreutils
      ];

      # `nix run` executes a copy of tools/ out of the store, but every script
      # rewrites revisions.json and index/ in place, so they need a checkout to
      # act on. The wrapper hands the caller's directory over as
      # MULTIVERSE_ROOT and refuses to guess when it is not a checkout.
      wrapTool =
        pkgs: name:
        pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = toolDeps pkgs;
          text = ''
            if [ ! -f "$PWD/revisions.json" ]; then
              echo "${name}: run this from a nixpkgs-multiverse checkout (no revisions.json in $PWD)" >&2
              exit 1
            fi
            export MULTIVERSE_ROOT="$PWD"
            exec bash ${./tools}/${name}.sh "$@"
          '';
        };

      # The database `mv` reads: revisions.json, releases.json and
      # index/history.json projected into SQLite, one row per run.
      #
      # Derived at build time and never committed. It is binary, it would change
      # every time the hourly job lands a revision, and a committed copy could
      # sit beside JSON it no longer matches. Building it here means the data
      # version *is* the flake version: a newer index arrives through
      # `nix flake update multiverse` and rewraps the binary.
      #
      # $out is the file itself rather than a directory holding it, so
      # `nix build .#index-db` leaves a ./result you can hand straight to
      # sqlite3 — 13 years of nixpkgs, queryable with SQL.
      indexDbFor =
        system:
        let
          pkgs = pkgsFor system;
        in
        pkgs.runCommand "multiverse.db"
          {
            nativeBuildInputs = [ pkgs.python3 ];

            # Names the checkout the data came from, so a database found on its
            # own can be traced back. A dirty tree has nothing honest to say.
            MV_BUILT_FROM = self.rev or "";
          }
          ''
            # build-db.py takes a checkout root; the store paths are individual
            # files, so assemble the layout it expects.
            root=$(mktemp -d)
            mkdir -p "$root/index"
            cp ${./revisions.json} "$root/revisions.json"
            cp ${./releases.json} "$root/releases.json"
            cp ${./index/history.json} "$root/index/history.json"

            python3 ${./mv/build-db.py} "$root" $out
          '';

      # `mv`, the consumer tool: read the index without materialising anything.
      #
      # The binary is wrapped with MV_DB pointing at the database built above,
      # which is what makes the data version *be* the flake version. There is
      # no download path and no cache directory on purpose — a second source of
      # truth would drift from the pinned input, and two people running the same
      # `nix run` would get different answers.
      #
      # Built from `pkgsFor system` — itself a multiverse revision — so
      # `inputs = { }` stays intact.
      mvFor =
        system:
        let
          pkgs = pkgsFor system;

          unwrapped = pkgs.rustPlatform.buildRustPackage {
            pname = "mv";
            version = "0.1.0";
            src = ./mv;
            cargoLock.lockFile = ./mv/Cargo.lock;

            # The unit tests run here. The differential test against
            # builtins.compareVersions cannot: it needs a `nix` to ask, and
            # there is none inside the sandbox, so it skips and CI runs it.
            meta = {
              description = "Read the nixpkgs multiverse index";
              mainProgram = "mv";
            };
          };
        in
        pkgs.runCommand "mv"
          {
            nativeBuildInputs = [ pkgs.makeWrapper ];
            inherit (unwrapped) meta;
          }
          ''
            mkdir -p $out/bin
            makeWrapper ${unwrapped}/bin/mv $out/bin/mv --set MV_DB ${indexDbFor system}
          '';

      # The deployable site: the static files from site/ plus the three data
      # files the page fetches at runtime. The data is copied in rather than
      # fetched from raw.githubusercontent.com so that versions.json and
      # revisions.json always deploy atomically — the offsets in one are only
      # valid against the other.
      #
      # app.js is renamed to app.<content-hash>.js and index.html rewritten to
      # match, so the served HTML and script can never be a mismatched pair
      # across deploys, and the script could be cached immutably.
      siteFor =
        system:
        let
          pkgs = pkgsFor system;

          # The commit stamped into the footer. From a clean checkout self.rev
          # names exactly the tree the data files came from; a dirty tree gets
          # dirtyRev; anything else keeps the placeholder and the footer stays
          # hidden.
          commit = self.rev or self.dirtyRev or "__COMMIT__";

          # history.json split by the first two characters of the attribute
          # name, so a package page fetches only the shard holding it.
          #
          # A timeline needs the history of exactly one attribute; serving the
          # whole 8 MB file to draw it would cost more than every other request
          # on the page combined. Two characters puts the median shard at 2 KB
          # and the 90th percentile at 26 KB.
          #
          # A build artifact rather than committed data: the repo keeps the one
          # file multiverse.nix reads, and the deploy gets the 792 pieces. That
          # also means the split can be retuned without a data commit.
          shardHistory = pkgs.writeText "shard-history.py" ''
            import json, os, sys

            src, dest = sys.argv[1:3]
            hist = json.load(open(src))
            os.makedirs(dest, exist_ok=True)

            buckets = {}
            for attr, vers in hist["attrs"].items():
                # Anything not alphanumeric folds to _, so the shard name is
                # always a safe filename and the site can compute it with the
                # same one-liner.
                key = "".join(c if c.isalnum() else "_" for c in attr[:2].lower()) or "_"
                buckets.setdefault(key, {})[attr] = vers

            for key, attrs in buckets.items():
                json.dump(
                    {"revisionCount": hist["revisionCount"], "attrs": attrs},
                    open(os.path.join(dest, key + ".json"), "w"),
                    separators=(",", ":"),
                    sort_keys=True,
                )
            print(f"sharded {len(hist['attrs'])} attrs into {len(buckets)} files")
          '';
        in
        pkgs.runCommand "nixpkgs-multiverse-site" { nativeBuildInputs = [ pkgs.python3 ]; } ''
          mkdir -p $out
          cp ${./site}/* $out/
          cp ${./revisions.json} $out/revisions.json
          cp ${./releases.json} $out/releases.json
          cp ${./index/versions.json} $out/versions.json
          cp ${./index/stats.json} $out/stats.json
          python3 ${shardHistory} ${./index/history.json} $out/history

          # The social-card image the og:/twitter: meta tags point at.
          cp ${./multiverse_lotr.jpg} $out/multiverse_lotr.jpg

          chmod -R u+w $out
          substituteInPlace $out/app.js --replace-quiet "__COMMIT__" "${commit}"

          # The output path is known before building, so the page can name
          # the very store path it is served out of (a benign self-reference).
          substituteInPlace $out/app.js --replace-fail "__STORE_PATH__" "$out"

          hash=$(sha256sum $out/app.js | cut -c1-12)
          mv $out/app.js "$out/app.$hash.js"
          substituteInPlace $out/index.html --replace-fail "app.js" "app.$hash.js"
        '';

      # The scripts behind `nix run .#<tool>`, each with the description its
      # app surfaces through `nix flake show` and `nix flake check`.
      tools = {
        build-index = "Build index/versions.json (and narHashes) from revisions.json";
        build-history = "Build index/history.json (version lifetimes) from the extraction cache";
        fetch-unstable-revisions = "Append new nixos-unstable channel bumps to revisions.json";
        fetch-releases = "Refresh releases.json with the current tip of every release channel";
        add-narhashes = "Fill in narHash for revisions that lack one";
        update-readme-status = "Rewrite the status block at the top of README.md";
      };
    in
    {
      # The multiverse API, per system.
      #   nix eval .#multiverse.x86_64-linux.versionsOf --apply 'f: f "python3"'
      multiverse = forAllSystems (system: import ./multiverse.nix { inherit system; });

      lib = {
        # `mkMultiverse` for callers who need to pass config/overlays through.
        mkMultiverse = args: import ./multiverse.nix args;

        # A `multiverse.lock` written by `mv lock`, resolved to derivations:
        #
        #   multiverse.lib.readLock { system = "x86_64-linux"; file = ./multiverse.lock; }
        #   => { helix = <derivation>; ripgrep = <derivation>; }
        #
        # The same function `multiverse.<system>.readLock` exposes, taking the
        # system as an argument for callers who are outside a per-system scope
        # — a home-manager module reading a lock beside its flake, typically.
        readLock =
          {
            system,
            file,
            config ? { },
            overlays ? [ ],
          }:
          (import ./multiverse.nix { inherit system config overlays; }).readLock file;

        # An overlay that rewrites `pkgs.<attr>` to a pinned version, for the
        # cases the modules deliberately do not cover: making every *other*
        # module see the pin, so that `programs.<name>.package` and friends pick
        # it up without being named individually.
        #
        # Handed out rather than set from inside the modules, because
        # `nixpkgs.overlays` is discarded wherever home-manager runs with
        # `useGlobalPkgs = true` — applying it is the caller's job, at the layer
        # that honours it. See the comment at the top of modules/multiverse.nix.
        #
        # The system comes off `final` rather than being an argument: reading it
        # from the package set being extended is what keeps this usable inside
        # `nixpkgs.overlays` without a second source of truth for the platform.
        pinOverlay =
          {
            pins,
            config ? { },
            overlays ? [ ],
          }:
          final: _prev:
          let
            mv = import ./multiverse.nix {
              system = final.stdenv.hostPlatform.system;
              inherit config overlays;
            };
          in
          builtins.mapAttrs (attr: version: mv.version attr version) pins;
      };

      # One shared core, two entry points. The wrappers differ only in which
      # package list they append to; see modules/multiverse.nix for why neither
      # of them goes anywhere near `nixpkgs.overlays`.
      nixosModules = rec {
        multiverse = ./modules/nixos.nix;
        default = multiverse;
      };

      homeManagerModules = rec {
        multiverse = ./modules/home-manager.nix;
        default = multiverse;
      };

      # `nix build .#site` assembles the exact tree the pages workflow
      # deploys; `nix run .#serve` (below, in apps) serves it for testing.
      packages = forAllSystems (system: rec {
        site = siteFor system;
        mv = mvFor system;
        index-db = indexDbFor system;
        default = site;
      });

      # legacyPackages is the conventional escape hatch for a non-flat package
      # set, which is exactly what a multiverse is. The demo rides here rather
      # than in `packages` because `nix flake check` evaluates every package,
      # and evaluating every-python means fetching the ~60 revisions it draws
      # from — legacyPackages is the one output flake check never enumerates.
      # `nix build .#every-python` resolves identically from either output.
      #
      # `installables` merges in the exact-match revision keys, which is what
      # makes `nix run .#25.05.python3` and `nix run .#<commit>.python3` work
      # as plain attrpaths. Collision-free: every key starts with a digit and
      # nothing in the API does.
      legacyPackages = forAllSystems (
        system:
        let
          mv = import ./multiverse.nix { inherit system; };
        in
        mv
        // mv.installables
        // {
          every-python = import ./demos/every-python.nix { inherit system; };
        }
      );

      # `nix flake check` runs the test suite. The eval tests return a small
      # summary attrset only after their assertions hold, so serialising the
      # summary into a derivation makes *evaluation* the test — the build step
      # just writes it out. compose is a real build: three Pythons from three
      # revisions in one buildEnv.
      checks = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          evalTest =
            name: file:
            pkgs.runCommand name {
              summary = builtins.toJSON (import file { inherit system; });
            } ''echo "$summary" > $out'';
        in
        {
          index = evalTest "test-index" ./tests/index.nix;
          flake-at = evalTest "test-flake-at" ./tests/flake-at.nix;
          installables = evalTest "test-installables" ./tests/installables.nix;
          module = evalTest "test-module" ./tests/module.nix;
          history = evalTest "test-history" ./tests/history.nix;
          lock = evalTest "test-lock" ./tests/lock.nix;
          compose = (import ./tests/compose.nix { inherit system; }).env;
        }
      );

      # `nix fmt`. The tree wrapper rather than bare `nixfmt`, which now
      # deprecates being handed a directory and formats stdin when `nix fmt` is
      # called with no paths at all. Extended with prettier so the site's
      # html/css/js is held to a formatter too, not just the Nix code.
      formatter = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        pkgs.nixfmt-tree.override {
          runtimeInputs = [ pkgs.prettier ];
          settings = {
            formatter.prettier = {
              command = "prettier";
              options = [ "--write" ];
              includes = [
                "*.css"
                "*.js"
              ];
            };
            # HTML separately: the default whitespace-sensitive mode emits
            # `></a\n>` gymnastics to keep inline spacing byte-identical.
            # This page keeps its inline spacing in text nodes, so the
            # insensitive mode is safe and far more readable.
            formatter.prettier-html = {
              command = "prettier";
              options = [
                "--write"
                "--html-whitespace-sensitivity"
                "ignore"
                "--print-width"
                "100"
              ];
              includes = [ "*.html" ];
            };
          };
        }
      );

      # Everything tools/*.sh needs, so `tools/build-index.sh` runs the same way
      # on any host — including the bash 4+ the scripts assume.
      devShells = forAllSystems (system: {
        default = (pkgsFor system).mkShellNoCC { packages = toolDeps (pkgsFor system); };
      });

      # The same tools without entering a shell first:
      #   nix run .#build-index -- -n 30
      apps = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        builtins.mapAttrs (name: description: {
          type = "app";
          program = "${wrapTool pkgs name}/bin/${name}";
          meta = { inherit description; };
        }) tools
        // {
          # `nix run .#mv -- query versions python3`
          mv = {
            type = "app";
            program = "${mvFor system}/bin/mv";
            meta.description = "Read the nixpkgs multiverse index";
          };

          # `nix run .#serve [port]` — the built site on a local port.
          #
          # Not a bare `python -m http.server`: every file in a store output
          # carries the epoch as its mtime, so If-Modified-Since would 304 a
          # file from a *previous* build — the browser then shows a stale site
          # across rebuilds no matter what changed. Ignore conditional
          # requests and forbid caching outright; this server exists only for
          # testing. (GitHub Pages serves real validators, so the deployed
          # site is unaffected.)
          serve =
            let
              script = pkgs.writeText "serve-site.py" ''
                import functools
                import http.server
                import os
                import sys

                class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
                    def send_head(self):
                        del self.headers["If-Modified-Since"]
                        del self.headers["If-None-Match"]
                        return super().send_head()

                    def end_headers(self):
                        self.send_header("Cache-Control", "no-store")
                        super().end_headers()

                port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
                handler = functools.partial(
                    NoCacheHandler, directory=os.environ["SITE_ROOT"]
                )
                # Name the store path being served, so a glance at the
                # terminal settles which build the browser should be showing.
                print(f"serving {os.environ['SITE_ROOT']}", flush=True)
                print(f"     on http://127.0.0.1:{port}", flush=True)
                try:
                    http.server.ThreadingHTTPServer(
                        ("127.0.0.1", port), handler
                    ).serve_forever()
                except KeyboardInterrupt:
                    sys.exit(0)
              '';
            in
            {
              type = "app";
              program = "${
                pkgs.writeShellApplication {
                  name = "serve-site";
                  runtimeInputs = [ pkgs.python3 ];
                  text = ''
                    SITE_ROOT=${siteFor system} exec python3 ${script} "$@"
                  '';
                }
              }/bin/serve-site";
              meta.description = "Serve the built site locally for testing";
            };
        }
      );
    };
}
