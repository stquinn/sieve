{
  description = "Sieve - scratchpad-first thinking tool";

  inputs = {
    # Unstable for standard systems (like Linux)
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    
    # Pinned channel to preserve support for x86_64-darwin (Intel macOS)
    nixpkgs-darwin-intel.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
    
    flake-utils.url = "github:numtide/flake-utils";

    # The Forgejo Actions base image and its mkCIImage builder. https, not ssh:
    # the publish job runs on the bare base with no ssh key and must fetch this
    # to evaluate the flake, which it does with a netrc over https.
    ci-base.url = "git+https://git.stephenquinn.ie/stephen/ci-base.git";
    ci-base.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, nixpkgs-darwin-intel, flake-utils, ci-base }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        # Route to the working nixpkgs depending on platform compatibility
        pkgs = if system == "x86_64-darwin"
               then nixpkgs-darwin-intel.legacyPackages.${system}
               else nixpkgs.legacyPackages.${system};

        inherit (pkgs) lib;
        isLinux = pkgs.stdenv.isLinux;

        # wails wrapper as a REAL nix-store package (not a runtime mktemp file):
        # a stable store path survives nix-direnv's cached `nix print-dev-env`,
        # where a temp-dir wrapper baked into PATH points at an ephemeral dir that
        # no longer exists — leaving bare `wails dev` to default to webkit2_40 and
        # fail on the absent webkit2gtk-4.0. Injects -tags webkit2_41 (the 4.1 ABI
        # the Linux runtime stack provides) into dev/build; other subcommands pass
        # through untouched. Linux only — macOS uses the native WKWebView.
        #
        # LD_LIBRARY_PATH is scoped HERE, not in the devShell's shellHook. Only the
        # Wails app needs the GTK/WebKit stack at runtime; exporting it shell-wide
        # leaks nix libraries into every other process in the shell. That is what
        # broke CI: with nix's glibc on LD_LIBRARY_PATH, Ubuntu-glibc binaries in
        # the runner container (git, and npm's prebuilt esbuild/rollup natives)
        # loaded nix's libc.so.6 and took SIGSEGV. glibc must never be listed here
        # either — the loader picks the right libc from each binary's own INTERP.
        wailsWrapped = pkgs.writeShellScriptBin "wails" ''
          export LD_LIBRARY_PATH="${lib.makeLibraryPath linuxLibs}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
          case "$1" in
            dev|build)
              subcmd="$1"; shift
              exec ${pkgs.wails}/bin/wails "$subcmd" -tags webkit2_41 "$@" ;;
            *)
              exec ${pkgs.wails}/bin/wails "$@" ;;
          esac
        '';

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

        # Every locked input source tree, transitively. Evaluating this flake
        # walks the whole input graph, so an image that carries only the direct
        # inputs still reaches for flake-utils' `systems` and ci-base's
        # `nixpkgs-tea` over the network.
        inputTrees = inputs:
          lib.concatMap (i: [ i.outPath ] ++ inputTrees (i.inputs or { }))
            (builtins.attrValues inputs);

        # The CI image: ci-base's package list plus this devShell's whole closure
        # and those input trees, so a job runs `nix develop --offline` and
        # downloads nothing. x86_64-linux only — that is the runners' arch and the
        # only system ci-base builds for.
        ciImage = ci-base.lib.${system}.mkCIImage {
          name = "stephen/sieve-ci";
          shells = [ self.devShells.${system}.default ];
          flakeInputs = lib.unique (inputTrees self.inputs);
        };
      in
      {
        devShells.default = pkgs.mkShell {
          # On macOS, don't inherit dependencies from the Linux-specific sieve derivation
          inputsFrom = lib.optionals isLinux [ sieve ];

          # On Linux, ship the -tags webkit2_41 wrapper instead of raw wails so
          # `wails dev`/`build` target the 4.1 ABI. On macOS use raw wails (native
          # WKWebView needs no tag).
          packages = with pkgs; [
            go
            nodejs_22
            pkg-config
            tea # Gitea/Forgejo CLI
          ] ++ (if isLinux then [ wailsWrapped pkgs.gcc ] else [ pkgs.wails ]);

          shellHook = ''
            export CGO_ENABLED=1

            ${lib.optionalString isLinux ''
              export GODEBUG=asyncpreemptoff=1
              export GSETTINGS_SCHEMA_DIR="${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}/glib-2.0/schemas:${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}/glib-2.0/schemas"
              export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS"
              export PKG_CONFIG_PATH="${lib.makeSearchPathOutput "dev" "lib/pkgconfig" linuxLibs}:$PKG_CONFIG_PATH"
              # NO LD_LIBRARY_PATH here — see wailsWrapped. Compile-time linking is
              # driven by PKG_CONFIG_PATH; only the running app needs the runtime
              # stack, and the wrapper scopes it to that one process tree.
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
        packages = { default = sieve; }
          // lib.optionalAttrs (system == "x86_64-linux") { ci-image = ciImage; };
      }
      // lib.optionalAttrs (system == "x86_64-linux") {
        # streamLayeredImage's output is the script itself, not bin/<name>, so
        # `nix run .#ci-image` needs an explicit app.
        apps.ci-image = { type = "app"; program = "${ciImage}"; };
      });
}