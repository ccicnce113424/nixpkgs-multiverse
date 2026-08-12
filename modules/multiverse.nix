# The shared core of the NixOS and home-manager modules: every option, and the
# single multiverse the whole module resolves against. The two wrappers around
# this file add exactly one line each — the package list their own module system
# understands.
#
# Nothing here touches `nixpkgs.overlays`, and that is deliberate. Rewriting
# `pkgs.<attr>` through an overlay is the obvious way to expose a pin, and it is
# a trap: home-manager swaps its nixpkgs module for
# `modules/misc/nixpkgs-disabled.nix` when `home-manager.useGlobalPkgs = true`,
# and that variant ignores every `nixpkgs.*` definition while warning about the
# file that set it. A module built on overlays would silently do nothing in the
# most common home-manager deployment there is. Everything below resolves to
# plain derivations, which works in all four shapes: NixOS, standalone
# home-manager, and home-manager as a submodule with `useGlobalPkgs` either way.
#
# The overlay is still available for callers who genuinely want `pkgs.<attr>`
# rewritten — as `multiverse.lib.pinOverlay`, applied by hand at the layer where
# it is honoured, rather than set from here where it might not be.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.multiverse;

  # One multiverse for the whole module. Revisions are memoised per instance, so
  # sharing it means two pins that resolve to the same revision fetch it once;
  # building a fresh multiverse per pin would fetch it twice.
  mv = import ../multiverse.nix {
    system = pkgs.stdenv.hostPlatform.system;
    inherit (cfg) config overlays;
  };

  # The type nixpkgs and home-manager both use for `nixpkgs.overlays`, so a list
  # accepted there is accepted here.
  overlayType = lib.mkOptionType {
    name = "nixpkgs-overlay";
    description = "nixpkgs overlay";
    check = builtins.isFunction;
    merge = lib.mergeOneOption;
  };

  # Attributes claimed by both `pins` and `cooldown.packages`. Each side resolves
  # to a different derivation exporting the same binaries, so leaving this to
  # build time turns a plain configuration mistake into a file-collision error
  # out of buildEnv.
  contested = lib.intersectLists (builtins.attrNames cfg.pins) cfg.cooldown.packages;
in
{
  options.multiverse = {
    enable = lib.mkEnableOption "package pinning through nixpkgs-multiverse";

    config = lib.mkOption {
      type = lib.types.attrs;
      default = { };
      example = {
        allowUnfree = true;
      };
      description = ''
        nixpkgs `config` threaded into every revision this module imports.

        A revision is an ordinary nixpkgs import and does not inherit the
        surrounding system's `nixpkgs.config`, so an unfree pin needs
        `allowUnfree` set here as well as wherever the host set it.
      '';
    };

    overlays = lib.mkOption {
      type = lib.types.listOf overlayType;
      default = [ ];
      description = ''
        Overlays applied to every revision this module imports.

        nixpkgs only grew an `overlays` argument in 17.03. If this is non-empty
        and a pin resolves to a revision older than that, resolving it throws
        rather than silently dropping the overlays.
      '';
    };

    pins = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = lib.literalExpression ''
        {
          vscode = "1.107.0";
          ripgrep = "13.0.0";
        }
      '';
      description = ''
        Top-level nixpkgs attributes pinned to an exact version, each resolved
        against whichever revision last shipped that version.

        A pin is a derivation from a *different* nixpkgs revision, so it brings
        that revision's closure rather than the running system's — including its
        own libc. That is correct for leaf applications and command-line tools,
        and wrong for anything other packages are meant to link against. It also
        means a pin does not deduplicate against the rest of the system.

        Only top-level attributes work. Nested sets — `python3Packages.*`,
        `nodePackages.*` — are not in the index and cannot be named here.
      '';
    };

    cooldown = {
      enable = lib.mkEnableOption ''
        a soak period: packages taken from nixos-unstable as it stood some
        number of days ago rather than as it stands now
      '';

      days = lib.mkOption {
        type = lib.types.ints.unsigned;
        default = 7;
        description = ''
          How far behind the anchor to reach. The revision used is the newest
          materialisable one at least this many days older than the anchor's
          date.
        '';
      };

      anchor = lib.mkOption {
        type = lib.types.str;
        default = "tip";
        example = "26.05";
        description = ''
          What to measure the soak period back from — any selector `at` accepts:
          `"tip"`, a release such as `"26.05"`, a date, or a commit.

          The walk back always happens along nixos-unstable. An anchor only
          supplies a date, so `anchor = "26.05"` means unstable as it stood N
          days before the 26.05 channel tip, not a walk along release-26.05.
        '';
      };

      packages = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [
          "ripgrep"
          "fd"
        ];
        description = ''
          Top-level attributes to install from the soaked revision instead of
          from the running system's nixpkgs.

          This soaks the packages named here, not the system. Soaking a whole
          NixOS configuration is a different operation — it has to happen at the
          flake level, where `nixosSystem` is called; see `flakeAt` in the
          README.
        '';
      };

      pkgs = lib.mkOption {
        type = lib.types.raw;
        readOnly = true;
        default = mv.daysBehind cfg.cooldown.anchor cfg.cooldown.days;
        defaultText = lib.literalExpression "multiverse.daysBehind cooldown.anchor cooldown.days";
        description = ''
          The soaked revision as a whole package set, for reaching things
          `cooldown.packages` cannot name — a `programs.<name>.package`, say.
          Available whether or not `cooldown.enable` is set; forcing anything
          out of it is what materialises the revision.
        '';
      };

      resolved = lib.mkOption {
        type = lib.types.raw;
        readOnly = true;
        default = lib.optionalAttrs cfg.cooldown.enable (
          lib.genAttrs cfg.cooldown.packages (attr: cfg.cooldown.pkgs.${attr})
        );
        defaultText = lib.literalExpression "{ <name> = <derivation>; }";
        description = ''
          `cooldown.packages` resolved against the soaked revision, keyed by
          attribute. Empty unless `cooldown.enable` is set, which is what keeps
          a half-configured cooldown from installing anything.
        '';
      };
    };

    instance = lib.mkOption {
      type = lib.types.raw;
      readOnly = true;
      default = mv;
      defaultText = lib.literalExpression "multiverse.lib.mkMultiverse { inherit system; inherit (config.multiverse) config overlays; }";
      description = ''
        The multiverse itself, carrying this module's `config` and `overlays`,
        for everything the options above do not cover — `at`, `versionsOf`,
        `revOf`, `flakeAt`.
      '';
    };

    pinned = lib.mkOption {
      type = lib.types.raw;
      readOnly = true;
      default = builtins.mapAttrs (attr: version: mv.version attr version) cfg.pins;
      defaultText = lib.literalExpression "{ <name> = <derivation>; }";
      description = ''
        `pins` resolved to derivations, keyed by attribute, so a pin can also be
        handed to an option that takes a package rather than only installed.
      '';
    };

    packages = lib.mkOption {
      type = lib.types.raw;
      readOnly = true;
      default = builtins.attrValues cfg.pinned ++ builtins.attrValues cfg.cooldown.resolved;
      defaultText = lib.literalExpression "[ <derivation> ... ]";
      description = ''
        Everything this module installs: every pin, plus every soaked package
        when `cooldown.enable` is set. The NixOS and home-manager wrappers each
        append this to their own package list.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = contested == [ ];
        message = ''
          multiverse: ${lib.concatStringsSep ", " contested} appears in both
          `multiverse.pins` and `multiverse.cooldown.packages`. Each would
          resolve to a different derivation of the same package, and the two
          would collide in the same package list. Pick one.
        '';
      }
    ];

    warnings = lib.optional (cfg.cooldown.packages != [ ] && !cfg.cooldown.enable) ''
      multiverse: `multiverse.cooldown.packages` is set but
      `multiverse.cooldown.enable` is not, so none of it is installed.
    '';
  };
}
