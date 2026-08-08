# The implementation lives in megatree.nix; this only preserves the
# `import ./. { }` spelling, which is the one CLI idiom flakes cannot express
# (a flake attribute path cannot take function arguments).
import ./megatree.nix
