{
  description = "Sieve - scratchpad-first thinking tool";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Pull the dependencies out so both the package and shell can use them
        linuxDeps = with pkgs; [
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
      in {
        packages.default = pkgs.buildGoModule {
          pname = "sieve";
          version = "0.1.0";
          src = ./.;

          proxyVendor = true;
          vendorHash = "sha256-KWxSDFzjtwJz7XN/0R9w/Moelg+u9qDuM34u8CGMWjw=";

          # Explicitly include 'production' - this is often the missing link 
          # that tells the Wails internal init() NOT to throw that error.
          buildFlags = [ "-tags=wails,production,webkit2_41" "-trimpath" ];

          preBuild = ''
            export GOFLAGS="-tags=wails,production,webkit2_41 -trimpath"
          '';

          nativeBuildInputs = with pkgs; [
            pkg-config
            wrapGAppsHook3
            gobject-introspection
          ];

          # FIX: Reference the linuxDeps variable here
          buildInputs = linuxDeps;

          ldflags = [ "-s" "-w" ];

          postInstall = ''
            # Install the icon to the store path
            install -Dm644 build/appicon.png \
              $out/share/icons/hicolor/256x256/apps/sieve.png

            mkdir -p $out/share/applications
            # Using <<EOF (no quotes) allows Nix to replace $out with the real store path
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

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            go
            wails
            nodejs_22
            pkg-config
            tea            # Gitea/Forgejo CLI
          ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux ([ gcc ] ++ linuxDeps);

          shellHook = ''
            export CGO_ENABLED=1

            ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
              export GODEBUG=asyncpreemptoff=1

              export GSETTINGS_SCHEMA_DIR="${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}/glib-2.0/schemas:${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}/glib-2.0/schemas"
              export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS"
              
              export PKG_CONFIG_PATH="${pkgs.lib.makeSearchPathOutput "dev" "lib/pkgconfig" linuxDeps}:$PKG_CONFIG_PATH"
              export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath linuxDeps}:$LD_LIBRARY_PATH"
            ''}

            _wails_dir=$(mktemp -d)
            ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
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
            ${pkgs.lib.optionalString pkgs.stdenv.isDarwin ''
              cat > "$_wails_dir/wails" << 'EOF'
              #!/usr/bin/env bash
              exec ${pkgs.wails}/bin/wails "$@"
              EOF
            ''}
            chmod +x "$_wails_dir/wails"
            export PATH="$_wails_dir:$PATH"
            unset _wails_dir

            echo "Sieve dev environment ready (Flake-backed)"
            echo "  go      $(go version)"
            echo "  wails   $(wails version 2>/dev/null || echo 'check wails install')"
            echo "  node    $(node --version)"
            echo "  tea     $(tea --version 2>/dev/null | head -1 || echo 'check tea install')"
          '';
        };
      }
    );
}