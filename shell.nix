{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    # Go toolchain
    go

    # Wails CLI
    wails

    # Node.js + npm for frontend (Tiptap + React + TypeScript)
    nodejs_22

    # Build tools
    pkg-config
    gcc

    # Wails on Linux requires WebKitGTK 4.1 + GTK3
    webkitgtk_4_1
    gtk3
    glib
    libsoup_3

    # WebKit / GLib dependencies
    pango
    cairo
    gdk-pixbuf
    atk

    # CGo needs these for linking
    glibc

    # Required for the directory picker (GIO/GTK settings)
    gsettings-desktop-schemas
  ];

  shellHook = ''
    export CGO_ENABLED=1

    # Ensure GTK/GIO can find the schemas for the file chooser
    export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:$XDG_DATA_DIRS"

    export PKG_CONFIG_PATH="${pkgs.lib.makeSearchPathOutput "dev" "lib/pkgconfig" [
      pkgs.webkitgtk_4_1
      pkgs.gtk3
      pkgs.glib
      pkgs.libsoup_3
      pkgs.pango
      pkgs.cairo
      pkgs.gdk-pixbuf
      pkgs.atk
    ]}:$PKG_CONFIG_PATH"

    export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath [
      pkgs.webkitgtk_4_1
      pkgs.gtk3
      pkgs.glib
      pkgs.libsoup_3
      pkgs.pango
      pkgs.cairo
      pkgs.gdk-pixbuf
      pkgs.atk
      pkgs.glibc
    ]}:$LD_LIBRARY_PATH"

    # nixpkgs ships webkit2gtk-4.1; wails v2 defaults to webkit2gtk-4.0.
    # Transparently wrap the wails binary so dev/build always get -tags webkit2_41.
    # 'EOF' (single-quoted) suppresses bash interpolation; ${pkgs.wails} is Nix-expanded above.
    _wails_dir=$(mktemp -d)
    cat > "$_wails_dir/wails" << 'EOF'
#!/usr/bin/env bash
# -tags webkit2_41 must come BEFORE any -- separator, so extract the
# subcommand, shift it off, then reconstruct the argument order correctly.
case "$1" in
  dev|build)
    subcmd="$1"; shift
    exec ${pkgs.wails}/bin/wails "$subcmd" -tags webkit2_41 "$@" ;;
  *)
    exec ${pkgs.wails}/bin/wails "$@" ;;
esac
EOF
    chmod +x "$_wails_dir/wails"
    export PATH="$_wails_dir:$PATH"
    unset _wails_dir

    echo "Stash dev environment ready"
    echo "  go      $(go version)"
    echo "  wails   $(wails version 2>/dev/null || echo 'check wails install')"
    echo "  node    $(node --version)"
    echo "  npm     $(npm --version)"
  '';
}
