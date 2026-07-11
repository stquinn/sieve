#!/usr/bin/env bash
# VS Code passes: -c "your-task-command"

# Get the directory where THIS script is located
# (Assuming the script is in your project root)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

shift # Remove the -c flag

# Force nix-shell to look at the project root for shell.nix
exec nix develop -c "$SCRIPT_DIR/shell.nix" --run "$1"