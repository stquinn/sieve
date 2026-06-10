{ pkgs ? import <nixpkgs> {} }:

let
  isLinux = pkgs.stdenv.isLinux;
  isDarwin = pkgs.stdenv.isDarwin;

  linuxDeps = with pkgs; lib.optionals isLinux [
    webkitgtk_4_1
    gtk3
    glib
    libsoup_3
    pango
    cairo
    gdk-pixbuf
    atk
    glibc
    gsettings-desktop-schemas
    
  ];

in pkgs.mkShell {
  buildInputs = with pkgs; [
    go
    wails
    nodejs_22
    pkg-config
  ] ++ lib.optionals isLinux [ gcc ]
    ++ linuxDeps;

  shellHook = ''
    export CGO_ENABLED=1

    ${pkgs.lib.optionalString isLinux ''
      # asyncpreemptoff=1: prevents Go from using SIGURG for goroutine preemption,
      # which conflicts with WebKit2GTK's signal handler setup on Linux.
      # COMPOSITING/DMABUF flags are intentionally NOT set — they kill performance.
      # The signal-11 crash on library switch is fixed instead by avoiding
      # location.reload() (see sieveSwitchLibrary / sieveSelectLibrary in index.html).
      export GODEBUG=asyncpreemptoff=1

      # GTK file dialogs need org.gtk.Settings.FileChooser (from gtk3) plus other
      # GNOME schemas (from gsettings-desktop-schemas). Both packages ship pre-compiled
      # gschemas.compiled under share/gsettings-schemas/<name>/glib-2.0/schemas/.
      # GLib searches all colon-separated paths in GSETTINGS_SCHEMA_DIR.
      export GSETTINGS_SCHEMA_DIR="${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}/glib-2.0/schemas:${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}/glib-2.0/schemas"

      export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS"
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
    ''}

    _wails_dir=$(mktemp -d)
    ${pkgs.lib.optionalString isLinux ''
      cat > "$_wails_dir/wails" << 'EOF'
#!/usr/bin/env bash
case "$1" in
  dev|build)
    subcmd="$1"; shift
    exec ${pkgs.wails}/bin/wails "$subcmd" -tags webkit2_41 "$@" ;;
  *)
    exec ${pkgs.wails}/bin/wails "$@" ;;
esac
EOF
    ''}
    ${pkgs.lib.optionalString isDarwin ''
      cat > "$_wails_dir/wails" << 'EOF'
#!/usr/bin/env bash
exec ${pkgs.wails}/bin/wails "$@"
EOF
    ''}
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