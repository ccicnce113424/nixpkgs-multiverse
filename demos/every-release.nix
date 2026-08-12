# Every NixOS release that was ever published, executing inside one derivation.
#
# Twenty-five releases spanning 2014 to 2026, each contributing its own `hello`
# with its own glibc and stdenv. Nothing is compiled — every one of them is
# substituted from cache.nixos.org, because each is the exact derivation Hydra
# built for that channel.
{
  system ? builtins.currentSystem,
  fetcher ? "github",
}:

let
  mv = import ../multiverse.nix { inherit system fetcher; };

  # The newest release supplies the builder. Everything else is historical.
  host = mv.at "26.05";
  inherit (host.lib) concatStringsSep;

  # One line per release. `name` rather than `version` because nixpkgs older
  # than 18.09 does not set a `version` attribute on `hello` at all, and the
  # whole point of this demo is that the old ones still evaluate.
  #
  # The date is the release channel's last published bump, not the day the
  # release was cut — a release keeps taking backports until it is retired.
  probe =
    release:
    let
      hello = (mv.at release).hello;
      tip = mv.releaseTips.${release};
    in
    ''
      printf '  %-8s %-12s %-14s ' '${release}' '${tip.date}' '${hello.name}'
      ${hello}/bin/hello
    '';
in
host.runCommand "every-release-hello" { } ''
  {
    printf '  %-8s %-12s %-14s %s\n' RELEASE "LAST BUMP" DERIVATION OUTPUT
    ${concatStringsSep "\n" (map probe mv.releases)}
  } 2>&1 | tee $out
''
