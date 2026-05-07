{ lib, buildGoModule, fetchFromGitHub, pkg-config
, gtk3, webkitgtk_4_1, libGL, xorg, gtk4, webkitgtk_6_0 }:

buildGoModule rec {
  pname = "wails3";
  version = "3.0.0-alpha.87";

  src = fetchFromGitHub {
    owner = "wailsapp";
    repo = "wails";
    rev = "v${version}";
    hash = "sha256-C0/9ZfZVmV4ohCBvTMXR1t4R/SxU4CAGFbJeuqKiHqc=";
  };

  sourceRoot = "${src.name}/v3";

  proxyVendor = true;
  vendorHash = "sha256-TYpkiZEj1IC17bY+pChUMGk9HYUqL0TeEa27unpYMF8=";

  # Move your environment variables here to avoid collisions
  env = {
    CGO_ENABLED = 1;
    GOFLAGS = "-mod=mod";
  };

  nativeBuildInputs = [ pkg-config ];

  buildInputs = [
    gtk4
    gtk3
    webkitgtk_4_1
    webkitgtk_6_0
    libGL
    xorg.libX11
    xorg.libXcursor
    xorg.libXinerama
  ];

  subPackages = [ "cmd/wails3" ];

  meta = with lib; {
    description = "Build applications using Go and Web Technologies";
    homepage = "https://wails.io";
    license = licenses.mit;
    platforms = platforms.linux;
  };
}