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
    libGL                # Added for GPU rendering
    gsettings-desktop-schemas
  ];

  wails3 = pkgs.callPackage ./wails3.nix {};

in pkgs.mkShell {
  buildInputs = with pkgs; [
    go
    nodejs_22
    pkg-config
    wails3
    webkitgtk_4_1 
    webkitgtk_4_1
    gtk3 
    pkg-config gcc
  ] ++ lib.optionals isLinux [ gcc ]
    ++ linuxDeps;

  shellHook = ''
    export CGO_ENABLED=1
    
    # 1. Ensure frontend binaries are discoverable by Wails
    export PATH="$PWD/frontend/node_modules/.bin:$PATH"

    ${pkgs.lib.optionalString isLinux ''
      export GODEBUG=asyncpreemptoff=1
      export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:$XDG_DATA_DIRS"
      
      export PKG_CONFIG_PATH="${pkgs.lib.makeSearchPathOutput "dev" "lib/pkgconfig" [
        pkgs.webkitgtk_4_1
        pkgs.gtk3
        pkgs.glib
        pkgs.libsoup_3
      ]}:$PKG_CONFIG_PATH"
      
      export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath linuxDeps}:$LD_LIBRARY_PATH"
    ''}

#     # 2. Setup the Wails wrapper correctly
#     _wails_temp_dir=$(mktemp -d)
    
#     ${pkgs.lib.optionalString isLinux ''
#       cat > "$_wails_temp_dir/wails3" << 'EOF'
# #!/usr/bin/env bash
# # We remove the case statement and -tags flag as v3 doesn't use them here
# exec ${wails3}/bin/wails3 "$@"
# EOF
#     ''}
    
#     ${pkgs.lib.optionalString isDarwin ''
#       cat > "$_wails_temp_dir/wails3" << 'EOF'
# #!/usr/bin/env bash
# exec ${wails3}/bin/wails3 "$@"
# EOF
#     ''}

#     chmod +x "$_wails_temp_dir/wails3"
    export PATH="$_wails_temp_dir:$PATH"

    echo "Sieve dev environment ready"
    echo "  go      $(go version)"
    echo "  wails3  $(wails3 version 2>/dev/null || echo 'check wails3 install')"
    echo "  node    $(node --version)"
  '';
}