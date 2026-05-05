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

  ldflags = [ "-s" "-w" ];

  # ... postInstall and preFixup remain the same
 postInstall = ''
  install -Dm644 build/appicon.png \
    $out/share/icons/hicolor/256x256/apps/sieve.png

  mkdir -p $out/share/applications
  cat > $out/share/applications/Sieve.desktop <<EOF
[Desktop Entry]
Name=Sieve
Comment=Scratchpad-first thinking tool
Exec=$out/bin/sieve
Icon=sieve
Type=Application
Categories=Utility;Office;
StartupWMClass=Sieve
EOF
'';

  preFixup = ''
    gappsWrapperArgs+=(--set GODEBUG asyncpreemptoff=1)
  '';
};
      }
    );
}
