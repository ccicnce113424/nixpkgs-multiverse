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
        in
        pkgs.runCommand "nixpkgs-multiverse-site" { } ''
          mkdir -p $out
          cp ${./site}/* $out/
          cp ${./revisions.json} $out/revisions.json
          cp ${./releases.json} $out/releases.json
          cp ${./index/versions.json} $out/versions.json

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

      # `mkMultiverse` for callers who need to pass config/overlays through.
      lib.mkMultiverse = args: import ./multiverse.nix args;

      # `nix build .#site` assembles the exact tree the pages workflow
      # deploys; `nix run .#serve` (below, in apps) serves it for testing.
      packages = forAllSystems (system: rec {
        site = siteFor system;
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
