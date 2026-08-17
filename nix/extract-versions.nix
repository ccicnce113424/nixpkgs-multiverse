# Extracts {attrname -> version} for a single vendored revision.
#
# Called once per revision by tools/build-index.sh. Kept deliberately total:
# any attribute that fails to evaluate (broken package, unfree assertion,
# platform mismatch) yields null rather than aborting the whole extraction,
# because a 2023 revision evaluated on a 2026 Nix will always have some
# casualties and one of them must not cost us the other 100k attributes.
{
  revPath,
  system ? builtins.currentSystem,
  # When null, extract every top-level attribute. Otherwise a list of names.
  attrs ? null,
}:

let
  entry = import revPath;

  args = {
    inherit system;
    config = {
      allowAliases = true;
      allowUnfree = true;
      allowBroken = false;
    };
  };

  # nixpkgs only grew an `overlays` argument in 17.03 — 16.09 takes exactly
  # { config, system } — and handing a function an argument it does not declare
  # is a hard error, so the empty list is offered only where it is accepted.
  # Without this every pre-17.03 revision fails extraction outright.
  pkgs =
    if (builtins.functionArgs entry) ? overlays then
      entry (args // { overlays = [ ]; })
    else
      entry args;

  # Version of a single attribute, or null if it cannot be determined.
  # Prefers the explicit `version` attribute and falls back to parsing the
  # derivation name, which is all the older revisions expose for some packages.
  versionOf =
    name:
    let
      attempt = builtins.tryEval (
        let
          drv = pkgs.${name};
          parsed = (builtins.parseDrvName (drv.name or "")).version;
        in
        if !(builtins.isAttrs drv) then
          null
        else if !(drv.type or "" == "derivation") then
          null
        else if drv ? version && builtins.isString drv.version then
          drv.version
        else if parsed != "" then
          parsed
        else
          null
      );
    in
    if attempt.success then attempt.value else null;

  # Attribute names to walk. Guard the readDir-free `attrNames` behind tryEval
  # too, since forcing the top-level attrset can itself fail on old revisions.
  names =
    if attrs != null then
      attrs
    else
      let
        attempt = builtins.tryEval (builtins.attrNames pkgs);
      in
      if attempt.success then attempt.value else [ ];

  present = builtins.filter (n: builtins.hasAttr n pkgs) names;

  pairs = map (n: {
    name = n;
    value = versionOf n;
  }) present;

  # Drop the nulls so the emitted JSON only carries attributes we resolved.
  resolved = builtins.filter (p: p.value != null) pairs;
in
builtins.listToAttrs resolved
