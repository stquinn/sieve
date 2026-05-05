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
      in {
        packages.default = pkgs.buildGoModule {
          pname = "sieve";
          version = "0.1.0";
          src = ./.;

          # Run `nix build` once with lib.fakeHash, copy the hash from the error,
          # then replace below.
          vendorHash = "sha256-uK97E7jC0YzTRWVtYhUrlgF4RHrLVPzbIXlC0Jewwh0=";

          nativeBuildInputs = with pkgs; [
            pkg-config
            wrapGAppsHook3
          ];

          buildInputs = with pkgs; [
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

          buildFlags = [ "-tags" "webkit2_41" ];

          ldflags = [ "-s" "-w" ];

          postInstall = ''
            install -Dm644 build/appicon.png \
              $out/share/icons/hicolor/256x256/apps/sieve.png

            mkdir -p $out/share/applications
            cat > $out/share/applications/Sieve.desktop <<'EOF'
[Desktop Entry]
Name=Sieve
Comment=Scratchpad-first thinking tool
Exec=sieve
Icon=sieve
Type=Application
Categories=Utility;Office;
StartupWMClass=Sieve
EOF
          '';

          # WebKit + Go signal handler conflict workaround (see shell.nix)
          preFixup = ''
            gappsWrapperArgs+=(--set GODEBUG asyncpreemptoff=1)
          '';
        };
      }
    );
}
