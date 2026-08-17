# `nix fmt`. The tree wrapper rather than bare `nixfmt`, which now deprecates
# being handed a directory and formats stdin when `nix fmt` is called with no
# paths at all. Extended with prettier so the site's html/css/js is held to a
# formatter too, not just the Nix code.
{ pkgs }:
pkgs.nixfmt-tree.override {
  runtimeInputs = [
    pkgs.prettier
    pkgs.rustfmt
  ];
  settings = {
    # mvs/ is Rust, and holding it to `nix fmt` too means CI's one formatting
    # step covers every language in the tree.
    formatter.rustfmt = {
      command = "rustfmt";
      options = [
        "--edition"
        "2021"
      ];
      includes = [ "*.rs" ];
    };
    formatter.prettier = {
      command = "prettier";
      options = [ "--write" ];
      includes = [
        "*.css"
        "*.js"
      ];
    };
    # HTML separately: the default whitespace-sensitive mode emits `></a\n>`
    # gymnastics to keep inline spacing byte-identical. This page keeps its
    # inline spacing in text nodes, so the insensitive mode is safe and far more
    # readable.
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
