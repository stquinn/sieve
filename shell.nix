# Compatibility shim — the canonical dev environment is flake.nix's devShell.
# `nix develop` is the supported entry point; this file only re-exports it so
# a stray `nix-shell` still lands in the same (flake-pinned) environment.
(builtins.getFlake (toString ./.)).devShells.${builtins.currentSystem}.default
