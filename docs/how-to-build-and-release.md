# How-To: Build, Bundle, Credit and Release

The procedures that are touched rarely. Day-to-day commands are in `CLAUDE.md` § Build & Dev;
running CI on your own machine is `docs/how-to-test-ci-locally.md`.

## 1. The dev environment

The dev env is a **nix flake**: `nix develop`, or `direnv` with `.envrc` = `use flake`. The flake's
devShell ships a `wails` wrapper (a real store package, `wailsWrapped`) that injects
`-tags webkit2_41` into `dev` and `build`, so bare `wails dev` works. `nix develop` is the sole
entry point; there is no `shell.nix`.

The devShell hook resets `CGO_ENABLED` to 1 on entry, so a command that needs it off sets it
INSIDE the shell: `nix develop -c env CGO_ENABLED=0 <cmd>`.

## 2. Tailwind

```bash
npx tailwindcss -i frontend/src/static/input.css -o frontend/src/static/tailwind.css
```

- Content paths must include `frontend/src/templates/**/*.html` and `frontend/src/index.html`.
- `wails dev` runs `npm run css` (`frontend:dev:build`), not the full `npm run build`, so it never
  rebuilds the vendor bundles. `css`, `build` and the `dev` watcher all write the same minified
  file.
- `tailwind.css` is committed. Tailwind scans `src/static/**/*.js` too, so a JS change can alter
  it: commit the regenerated file with the change that caused it.

## 3. Vendor bundles

Rebuild a bundle only when its dependencies change. Both commands run in `frontend/`.

### TipTap

`npm run bundle:tiptap` when TipTap core or its deps change. It emits `vendor/tiptap.js`. Custom
extensions live in `lens/extensions.js` (vanilla JS) and are NOT in the bundle.

### Prettier

`npm run bundle:prettier` when `prettier` or `prettier-plugin-java` change.

- It emits `vendor/prettier.js` (ESM — `import.meta` is load-bearing) and copies the Java parser's
  two `.wasm` files BESIDE it, because the plugin locates them with
  `new URL(name, import.meta.url)`. All three are committed.
- Nothing references it from `index.html`: `PrettierFormatter` `import()`s it on the first Format
  click.
- The bundle does not run under Node (web-tree-sitter's Node path breaks when bundled), so tests
  inject the npm packages through `PrettierFormatter`'s loader instead.
- `tree-sitter-java_orchard.wasm` is `tree-sitter-java-orchard`'s compiled grammar (MIT), a
  devDependency of the plugin that npm never installs and esbuild never reads. It is therefore
  credited from what is on disk: its MIT text is committed beside it as
  `vendor/tree-sitter-java_orchard-MIT.txt`, and its version is read from the plugin's own pin
  (`tools/gencredits` `javaGrammarEntry`).

## 4. Third-party credits

`third-party-licenses.json` (repo root, go:embed'ed, rendered by Help → Open Source Licenses) is
GENERATED. Never hand-edit it.

Regenerate only when deps change (`go.mod`, `frontend/package.json`, bundle entries):

```bash
nix develop -c go run ./tools/gencredits    # needs network on first run
```

- The tool fails the run if a copyleft license appears in a bundled component.
- CI's `credits` job regenerates and diffs, failing the pipeline if a dep change lands without a
  regen. Releases ship the committed artifact and never regenerate.
- Sieve itself is Apache-2.0 (`LICENSE` + `NOTICE` at root).

The output must be deterministic across toolchains. Both halves of the Go stdlib entry are pinned
to make it so:

- The **version** comes from go.mod's `go` directive, not `go env GOVERSION`.
- The **license text** comes from `$GOROOT/LICENSE` only — never a walk of GOROOT, which holds
  about twenty vendored licenses whose shallowest is BoringSSL's. Nix omits the top-level
  `LICENSE`, so a walk ships OpenSSL's text as the Go stdlib's. `tools/gencredits/go-license.txt`
  is the fallback for toolchains that omit the file; `tools/gencredits/main_test.go` pins this.

## 5. Release

```bash
tools/release.sh <version>
```

It bumps `sieveVersion` in `flake.nix` (the number a Nix install reports and stamps into
`main.version` as `<version>+<commit>`), commits, tags `v<version>` and pushes both atomically.

- Never tag by hand: the Forgejo release workflow refuses a tag whose number differs from that
  constant.
- The Go module set is pinned by `vendorHash` in the same file. The credits CI job fails when a
  `go.mod`/`go.sum` change lands without the matching bump; the correct hash is in its log.

## 6. Workflows and the CI image

`.forgejo/workflows/` is the ONLY directory Forgejo reads: it stops at the first of `.forgejo/`,
`.gitea/`, `.github/` that exists.

| File | What it does |
|---|---|
| `.forgejo/workflows/ci.yml` | The 4 test jobs, all inside the `sieve-ci` image |
| `.forgejo/workflows/publish-ci-image.yml` | Builds and publishes that image |
| `.forgejo/workflows/release.yml` | The Linux release |
| `.github/workflows/release.yml` | The macOS build only (Forgejo has no Mac build agent) |

`stephen/sieve-ci` is a child of ci-base. `Containerfile` starts from ci-base `latest` (agy,
claude-code, tea, git) and adds this devShell's whole closure and every locked flake input, so a
CI job enters the shell with no network.

- `publish-ci-image.yml` rebuilds it Monday nights, on any push to main changing `flake.nix`,
  `flake.lock` or `Containerfile`, and on dispatch. It probes the new tag and only then moves
  `latest`.
- Every job in `ci.yml` runs in it as `nix develop -c <cmd>`, with no setup-go, no setup-node and
  no apt.
- `ci.yml` is deliberately NOT `--offline`: a commit that changes the flake runs once against the
  previous image, Nix fetches the difference, and the next run is warm once publish has moved
  `latest`. The publish probe is where `--offline` is enforced.

## 7. Embeds

The `go:embed` directives are in `embeds.go`. Their paths are relative to the declaring file and
cannot climb, so they stay at the repo root and are threaded into `newAPIHandler`:

- `frontend/src/templates` → Go templates
- `frontend/src/static` → static files served at `/ui/static/`
- `frontend/src/index.html` → the app shell
