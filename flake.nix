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
    { ... }:
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
        pkgs.git
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

      tools = [
        "build-index"
        "fetch-unstable-revisions"
        "add-narhashes"
        "update-readme-status"
      ];
    in
    {
      # The multiverse API, per system.
      #   nix eval .#multiverse.x86_64-linux.versionsOf --apply 'f: f "python3"'
      multiverse = forAllSystems (system: import ./multiverse.nix { inherit system; });

      # `mkMultiverse` for callers who need to pass config/overlays through.
      lib.mkMultiverse = args: import ./multiverse.nix args;

      # legacyPackages is the conventional escape hatch for a non-flat package
      # set, which is exactly what a multiverse is.
      legacyPackages = forAllSystems (system: import ./multiverse.nix { inherit system; });

      packages = forAllSystems (system: {
        every-python = import ./demos/every-python.nix { inherit system; };
      });

      # `nix fmt`. The tree wrapper rather than bare `nixfmt`, which now
      # deprecates being handed a directory and formats stdin when `nix fmt` is
      # called with no paths at all.
      formatter = forAllSystems (system: (pkgsFor system).nixfmt-tree);

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
        builtins.listToAttrs (
          map (name: {
            inherit name;
            value = {
              type = "app";
              program = "${wrapTool pkgs name}/bin/${name}";
            };
          }) tools
        )
      );
    };
}
