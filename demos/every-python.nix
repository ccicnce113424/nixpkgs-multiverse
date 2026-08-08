# Every CPython ever packaged in nixpkgs, executing inside a single derivation.
#
# Nineteen interpreters spanning 2017 to 2026, each carrying its own glibc,
# openssl and stdenv, co-resident in one build sandbox. Nothing is compiled —
# every one of them is substituted from cache.nixos.org, because each is the
# exact derivation Hydra built at its release.
{
  system ? builtins.currentSystem,
  fetcher ? "github",
}:

let
  mv = import ../multiverse.nix { inherit system fetcher; };

  # The newest revision supplies the builder. Everything else is historical.
  host = mv.at "26.05";
  inherit (host.lib) concatStringsSep;

  versions = mv.versionsOf "python3";

  # One line per interpreter: ask it to introduce itself, and print the compiler
  # that built it — which is a different GCC for almost every row, making the
  # graph disjointness visible rather than merely asserted.
  #
  # The Python must stay on one line: `python3 -c` rejects leading whitespace.
  probe =
    ver:
    let
      py = mv.version "python3" ver;
      rev = mv.revOf "python3" ver;
    in
    ''
      printf '  %-9s %-26s ' '${ver}' '${rev}'
      ${py}/bin/python3 -c 'import sys,sysconfig; print("%-22s %s" % (sysconfig.get_platform(), sys.version.split("[")[-1].rstrip("]")[:40]))'
    '';
in
host.runCommand "every-python" { } ''
  {
    echo "  every CPython in nixpkgs, running at once"
    echo "  ----------------------------------------------------------------------------"
    printf '  %-9s %-26s %-24s %s\n' VERSION REVISION REPORTED COMPILER
    echo "  ----------------------------------------------------------------------------"
    ${concatStringsSep "\n" (map probe versions)}
    echo "  ----------------------------------------------------------------------------"
    echo "  ${toString (builtins.length versions)} interpreters, 0 compiled"
  } 2>&1 | tee $out
''
