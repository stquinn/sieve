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
      # WebKit2GTK installs SIGSEGV handlers without SA_ONSTACK which conflicts
      # with Go's signal stack. The three variables below collectively prevent
      # WebKit from using GPU compositing / DMABuf paths that crash internally,
      # and asyncpreemptoff stops Go from using POSIX signals for preemption so
      # Go's own signal handler stays in place.
      # export WEBKIT_DISABLE_COMPOSITING_MODE=1
      # export WEBKIT_DISABLE_DMABUF_RENDERER=1
      export GODEBUG=asyncpreemptoff=1

      # GTK file dialogs require the org.gtk.Settings.FileChooser GSettings schema.
      # On NixOS the schema XML ships in the Nix store but needs to be compiled
      # before GLib can find it.  We compile once into /tmp and point GLib there.
      _schema_src="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}/glib-2.0/schemas"
      _schema_dir="''${XDG_RUNTIME_DIR:-/tmp}/sieve-gschemas"
      mkdir -p "$_schema_dir"
      if [ ! -f "$_schema_dir/gschemas.compiled" ]; then
        cp "$_schema_src"/*.xml "$_schema_dir/" 2>/dev/null || true
        ${pkgs.glib.dev}/bin/glib-compile-schemas "$_schema_dir" 2>/dev/null || true
      fi
      export GSETTINGS_SCHEMA_DIR="$_schema_dir"
      unset _schema_src _schema_dir

      export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share:$XDG_DATA_DIRS"
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