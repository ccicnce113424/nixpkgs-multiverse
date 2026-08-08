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
    };
}
