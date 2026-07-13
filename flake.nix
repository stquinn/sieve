{
  description = "Sieve - scratchpad-first thinking tool";

  inputs = {
    # Unstable for standard systems (like Linux)
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    
    # Pinned channel to preserve support for x86_64-darwin (Intel macOS)
    nixpkgs-darwin-intel.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
    
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, nixpkgs-darwin-intel, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        # Route to the working nixpkgs depending on platform compatibility
        pkgs = if system == "x86_64-darwin"
               then nixpkgs-darwin-intel.legacyPackages.${system}
               else nixpkgs.legacyPackages.${system};

        inherit (pkgs) lib;
        isLinux = pkgs.stdenv.isLinux;

        # GTK/WebKit runtime stack (Linux only — macOS uses the native WKWebView).
        linuxLibs = with pkgs; [
          webkitgtk_4_1
          gtk3
          glib
          libsoup_3
          pango
          cairo
          gdk-pixbuf
          atk
          gsettings-desktop-schemas
        ];

        sieve = pkgs.buildGoModule {
          pname = "sieve";
          version = "0.1.0";
          src = ./.;

          proxyVendor = true;
          vendorHash = "sha256-KWxSDFzjtwJz7XN/0R9w/Moelg+u9qDuM34u8CGMWjw=";

          buildFlags = [ "-tags=wails,production,webkit2_41" "-trimpath" ];

          preBuild = ''
            export GOFLAGS="-tags=wails,production,webkit2_41 -trimpath"
          '';

          nativeBuildInputs = with pkgs; [
            pkg-config
            wrapGAppsHook3
            gobject-introspection
          ];

          buildInputs = linuxLibs;

          ldflags = [ "-s" "-w" ];

          postInstall = ''
            install -Dm644 build/appicon.png \
              $out/share/icons/hicolor/256x256/apps/sieve.png

            mkdir -p $out/share/applications
            cat > $out/share/applications/Sieve.desktop <<EOF
          [Desktop Entry]
          Name=Sieve
          Comment=Scratchpad-first thinking tool
          Exec=$out/bin/sieve
          Icon=$out/share/icons/hicolor/256x256/apps/sieve.png
          Type=Application
          Categories=Utility;Office;
          StartupWMClass=Sieve
          Terminal=false
          EOF
          '';

          preFixup = ''
            gappsWrapperArgs+=(
              --set GODEBUG asyncpreemptoff=1
              --prefix XDG_DATA_DIRS : "$GSETTINGS_SCHEMAS_PATH"
            )
          '';
        };
      in
      {
        devShells.default = pkgs.mkShell {
          # On macOS, don't inherit dependencies from the Linux-specific sieve derivation
          inputsFrom = lib.optionals isLinux [ sieve ];

          packages = with pkgs; [
            go
            wails
            nodejs_22
            pkg-config
            tea # Gitea/Forgejo CLI
          ] ++ lib.optionals isLinux [ pkgs.gcc ];

          shellHook = ''
            export CGO_ENABLED=1

            ${lib.optionalString isLinux ''
              export GODEBUG=asyncpreemptoff=1
              export GSETTINGS_SCHEMA_DIR="${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}/glib-2.0/schemas:${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}/glib-2.0/schemas"
              export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS"
              export PKG_CONFIG_PATH="${lib.makeSearchPathOutput "dev" "lib/pkgconfig" linuxLibs}:$PKG_CONFIG_PATH"
              export LD_LIBRARY_PATH="${lib.makeLibraryPath (linuxLibs ++ [ pkgs.glibc ])}:$LD_LIBRARY_PATH"

              # wails wrapper: inject -tags webkit2_41 into dev/build transparently.
              _wails_dir=$(mktemp -d)
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
              chmod +x "$_wails_dir/wails"
              export PATH="$_wails_dir:$PATH"
              unset _wails_dir
            ''}

            echo "Stash dev environment ready"
            echo "  go      $(go version)"
            echo "  wails   $(wails version 2>/dev/null || echo 'check wails install')"
            echo "  node    $(node --version)"
            echo "  npm     $(npm --version)"
            echo "  tea     $(tea --version 2>/dev/null | head -1 || echo 'check tea install')"
          '';
        };
      }
      // lib.optionalAttrs isLinux {
        packages.default = sieve;
      });
}