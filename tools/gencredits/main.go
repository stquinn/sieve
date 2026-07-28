// Command gencredits regenerates third-party-licenses.json at the repo root:
// the full inventory of third-party components Sieve redistributes, with
// license ids, copyright lines, and license texts. The artifact is go:embed'ed
// (embeds.go) and rendered in the help dialog's "Open source licenses"
// section — it is generated, never hand-edited.
//
// Run from the repo root (network needed on first run to fetch go-licenses):
//
//	nix develop -c go run ./tools/gencredits
//
// Sources merged:
//   - Go modules statically compiled into the binary (go-licenses report/save)
//   - npm packages bundled into frontend/src/static/vendor/ — enumerated from
//     esbuild --metafile output for each bundle entry, plus the dist-copied
//     libraries (mermaid, panzoom) and build-time-shipped CSS (tailwind)
//   - fixed entries: the Go standard library/runtime, and system-runtime
//     courtesy mentions (WebKitGTK) that carry no bundling obligation
package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Entry is one credited component in the generated artifact.
type Entry struct {
	Name      string `json:"name"`
	Version   string `json:"version,omitempty"`
	License   string `json:"license"`
	Copyright string `json:"copyright,omitempty"`
	Source    string `json:"source"` // "go" | "npm" | "runtime" | "system"
	Note      string `json:"note,omitempty"`
	Text      string `json:"text,omitempty"`
}

// Artifact is the top-level shape of third-party-licenses.json.
type Artifact struct {
	Generated string  `json:"generated"`
	Entries   []Entry `json:"entries"`
}

// copyleft license ids that must fail the run if they appear in a bundled
// (non-system) entry — the sanity gate from issue #58.
var copyleftPattern = regexp.MustCompile(`(?i)\b(GPL|AGPL|SSPL|EUPL|OSL)\b`)

// Generator owns the repo paths and the collection passes.
type Generator struct {
	repoRoot    string
	frontendDir string
	scratchDir  string
}

func main() {
	root, err := os.Getwd()
	if err != nil {
		fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		fatal(fmt.Errorf("run from the repo root (go.mod not found in %s)", root))
	}
	scratch, err := os.MkdirTemp("", "gencredits-*")
	if err != nil {
		fatal(err)
	}
	defer os.RemoveAll(scratch)

	g := &Generator{
		repoRoot:    root,
		frontendDir: filepath.Join(root, "frontend"),
		scratchDir:  scratch,
	}
	if err := g.Run(); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "gencredits:", err)
	os.Exit(1)
}

// Run executes all collection passes and writes the artifact.
func (g *Generator) Run() error {
	var entries []Entry

	goEntries, err := g.collectGoModules()
	if err != nil {
		return fmt.Errorf("go modules: %w", err)
	}
	entries = append(entries, goEntries...)

	npmEntries, err := g.collectNpmPackages()
	if err != nil {
		return fmt.Errorf("npm packages: %w", err)
	}
	entries = append(entries, npmEntries...)

	fixed, err := g.fixedEntries()
	if err != nil {
		return fmt.Errorf("fixed entries: %w", err)
	}
	entries = append(entries, fixed...)

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Source != entries[j].Source {
			return entries[i].Source < entries[j].Source
		}
		return entries[i].Name < entries[j].Name
	})

	if err := g.copyleftGate(entries); err != nil {
		return err
	}

	artifact := Artifact{
		Generated: "by tools/gencredits — do not edit; regenerate with: nix develop -c go run ./tools/gencredits",
		Entries:   entries,
	}
	out, err := json.MarshalIndent(artifact, "", "  ")
	if err != nil {
		return err
	}
	outPath := filepath.Join(g.repoRoot, "third-party-licenses.json")
	if err := os.WriteFile(outPath, append(out, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Printf("gencredits: wrote %s (%d entries)\n", outPath, len(entries))
	return nil
}

// copyleftGate fails the run if any bundled entry carries a copyleft license.
// System-runtime mentions (dynamically linked, not redistributed) are exempt.
func (g *Generator) copyleftGate(entries []Entry) error {
	for _, e := range entries {
		if e.Source == "system" {
			continue
		}
		if copyleftPattern.MatchString(e.License) && !strings.Contains(e.License, "LGPL-exception") {
			return fmt.Errorf("copyleft license %q on bundled component %q — needs a licensing decision before shipping", e.License, e.Name)
		}
	}
	return nil
}

// ---- Go modules ----

// collectGoModules runs go-licenses report (name/url/license id) and
// go-licenses save (license texts) and joins the two.
func (g *Generator) collectGoModules() ([]Entry, error) {
	report, err := g.runGoLicenses("report", "./...")
	if err != nil {
		return nil, err
	}

	savePath := filepath.Join(g.scratchDir, "go-license-texts")
	if _, err := g.runGoLicenses("save", "./...", "--save_path="+savePath, "--force"); err != nil {
		return nil, err
	}

	var entries []Entry
	for _, line := range strings.Split(strings.TrimSpace(report), "\n") {
		parts := strings.Split(line, ",")
		if len(parts) != 3 {
			continue
		}
		module, url, license := parts[0], parts[1], parts[2]
		if module == "sieve" { // ourselves
			continue
		}
		text := readLicenseFile(filepath.Join(savePath, module))
		entries = append(entries, Entry{
			Name:      module,
			Version:   versionFromLicenseURL(url),
			License:   license,
			Copyright: copyrightLine(text),
			Source:    "go",
			Text:      text,
		})
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("go-licenses report produced no modules")
	}
	return entries, nil
}

// runGoLicenses invokes a pinned go-licenses via `go run`. CGO is disabled so
// the tool binary links statically — the nix dev shell's glibc paths make
// dynamically linked `go run` artifacts unexecutable (same root cause as the
// CGO_ENABLED=0 rule for go test).
func (g *Generator) runGoLicenses(args ...string) (string, error) {
	full := append([]string{"run", "github.com/google/go-licenses@v1.6.0"}, args...)
	cmd := exec.Command("go", full...)
	cmd.Dir = g.repoRoot
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("go-licenses %s: %w", strings.Join(args, " "), err)
	}
	return string(out), nil
}

// versionFromLicenseURL extracts the module version from a go-licenses report
// URL, e.g. .../blob/v5.2.5/LICENSE or .../+/v0.35.0:LICENSE.
func versionFromLicenseURL(url string) string {
	m := regexp.MustCompile(`/(?:blob/|\+/)(v[0-9][^/:]*)`).FindStringSubmatch(url)
	if m == nil {
		return ""
	}
	return m[1]
}

// ---- npm packages ----

// bundleEntry mirrors the esbuild invocations in frontend/package.json's
// bundle:* scripts; the metafile of each tells us exactly which packages ship.
type bundleEntry struct {
	entry string
	args  []string
}

func (g *Generator) collectNpmPackages() ([]Entry, error) {
	bundles := []bundleEntry{
		{entry: "tiptap-bundle-entry.js", args: []string{"--format=iife", "--global-name=TipTap"}},
		{entry: "htmx-bundle-entry.js", args: nil},
		{entry: "node_modules/js-yaml/dist/js-yaml.mjs", args: []string{"--format=iife", "--global-name=jsyaml"}},
	}

	pkgs := map[string]string{} // name -> note
	for _, b := range bundles {
		names, err := g.metafilePackages(b)
		if err != nil {
			return nil, err
		}
		for _, n := range names {
			pkgs[n] = ""
		}
	}
	// Dist-copied vendor files (bundle:mermaid / bundle:panzoom cp commands).
	pkgs["mermaid"] = "prebuilt distribution (mermaid.min.js); bundles its own dependencies under their respective permissive licenses"
	pkgs["@panzoom/panzoom"] = "prebuilt distribution (panzoom.min.js)"
	// Build-time CSS whose generated output ships.
	pkgs["tailwindcss"] = "build-time: generated utility CSS ships (tailwind.css); preflight is based on modern-normalize (MIT)"

	var entries []Entry
	for name, note := range pkgs {
		e, err := g.npmEntry(name, note)
		if err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// metafilePackages runs the bundle's esbuild invocation with --metafile and
// returns the node_modules package names that were pulled into the output.
func (g *Generator) metafilePackages(b bundleEntry) ([]string, error) {
	metaPath := filepath.Join(g.scratchDir, "meta-"+filepath.Base(b.entry)+".json")
	args := append([]string{"esbuild", b.entry, "--bundle", "--minify",
		"--metafile=" + metaPath, "--outfile=" + os.DevNull}, b.args...)
	cmd := exec.Command("npx", args...)
	cmd.Dir = g.frontendDir
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("esbuild metafile for %s: %w", b.entry, err)
	}

	raw, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, err
	}
	var meta struct {
		Inputs map[string]json.RawMessage `json:"inputs"`
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, err
	}
	pkgRe := regexp.MustCompile(`node_modules/((?:@[^/]+/)?[^/]+)/`)
	seen := map[string]bool{}
	var names []string
	for input := range meta.Inputs {
		if m := pkgRe.FindStringSubmatch(input); m != nil && !seen[m[1]] {
			seen[m[1]] = true
			names = append(names, m[1])
		}
	}
	return names, nil
}

// licenseOverrides fills in packages whose npm manifest omits the license
// field but whose upstream license is documented.
var licenseOverrides = map[string]struct{ id, note string }{
	"htmx-ext-sse": {"0BSD", "license field absent from the npm package; licensed 0BSD upstream (bigskysoftware/htmx-extensions)"},
}

// npmEntry reads a package's manifest and license file from node_modules.
func (g *Generator) npmEntry(name, note string) (Entry, error) {
	dir := filepath.Join(g.frontendDir, "node_modules", filepath.FromSlash(name))
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return Entry{}, fmt.Errorf("%s: %w", name, err)
	}
	var manifest struct {
		Version string `json:"version"`
		License string `json:"license"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return Entry{}, fmt.Errorf("%s: %w", name, err)
	}
	if manifest.License == "" {
		if known, ok := licenseOverrides[name]; ok {
			manifest.License = known.id
			if note == "" {
				note = known.note
			}
		} else {
			manifest.License = "see package"
		}
	}
	text := readLicenseFile(dir)
	if text == "" && note == "" {
		note = "license text not shipped inside the npm package"
	}
	return Entry{
		Name:      name,
		Version:   manifest.Version,
		License:   manifest.License,
		Copyright: copyrightLine(text),
		Source:    "npm",
		Note:      note,
		Text:      text,
	}, nil
}

// ---- fixed entries ----

func (g *Generator) fixedEntries() ([]Entry, error) {
	gorootOut, err := exec.Command("go", "env", "GOROOT").Output()
	if err != nil {
		return nil, err
	}
	goLicense, err := goStdlibLicense(strings.TrimSpace(string(gorootOut)))
	if err != nil {
		return nil, err
	}
	// Version from go.mod's `go` directive, NOT the local toolchain
	// (go env GOVERSION): the artifact must be byte-identical wherever it is
	// regenerated — the CI staleness gate diffs a fresh regen against the
	// committed file, and toolchains differ between the nix flake and CI.
	goDirective, err := g.goModDirective()
	if err != nil {
		return nil, err
	}

	fontEntries, err := g.bundledFontEntries()
	if err != nil {
		return nil, err
	}

	return append([]Entry{
		{
			Name:      "Go standard library & runtime",
			Version:   goDirective,
			License:   "BSD-3-Clause",
			Copyright: copyrightLine(goLicense),
			Source:    "runtime",
			Note:      "statically compiled into the Sieve binary",
			Text:      goLicense,
		},
		{
			Name:    "WebKitGTK",
			License: "LGPL-2.1 / BSD-2-Clause",
			Source:  "system",
			Note:    "dynamically linked system library (webkit2gtk-4.1); not distributed with Sieve — credited as the rendering runtime",
		},
		{
			Name:    "Theme palettes",
			License: "n/a (colour values)",
			Source:  "system",
			Note:    "bundled themes are original palettes inspired by Catppuccin, Gruvbox, Monokai, Darcula, and Tokyo Night; no third-party code is included",
		},
	}, fontEntries...), nil
}

// bundledFontEntries credits the self-hosted webfaces in frontend/src/static/fonts.
// Each license text is read from the copy that SHIPS with the font rather than
// embedded here, so the credited text and the distributed text cannot drift —
// the OFL requires the license to travel with the font, so that copy has to
// exist regardless.
//
// Versions track the nixpkgs packages the woff2 files were converted from
// (woff2_compress); bump them here when the committed files are refreshed.
func (g *Generator) bundledFontEntries() ([]Entry, error) {
	fonts := []struct{ name, version, copyright, note, license string }{
		{
			name: "JetBrains Mono", version: "2.304",
			copyright: "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)",
			note:      "variable webfont (roman + italic); editor and mono face for 12 of the 13 bundled themes",
			license:   "JetBrainsMono-OFL.txt",
		},
		{
			name: "Cascadia Code", version: "2407.24",
			copyright: "Copyright (c) 2019 - Present, Microsoft Corporation",
			note:      "four static faces (regular/bold/italic/bold-italic; upstream publishes no variable build); first choice of the default theme",
			license:   "CascadiaCode-OFL.txt",
		},
		{
			name: "Fira Code", version: "6.2",
			copyright: "Copyright (c) 2014, The Fira Code Project Authors (https://github.com/tonsky/FiraCode)",
			note:      "variable webfont; the second mono fallback every bundled theme names",
			license:   "FiraCode-OFL.txt",
		},
		{
			name: "Inter", version: "4.1",
			copyright: "Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)",
			note:      "variable webfont (roman + italic); self-hosted in place of the former Google Fonts fetch",
			license:   "Inter-OFL.txt",
		},
		{
			name: "Source Code Pro", version: "2.042",
			copyright: "© 2023 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. All Rights Reserved. Source is a trademark of Adobe in the United States and/or other countries.",
			note:      "four static faces (regular/bold/italic/bold-italic; upstream publishes no variable build); monospace option in the font settings",
			license:   "SourceCodePro-OFL.txt",
		},
		{
			name: "IBM Plex Mono", version: "2.005",
			copyright: `Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"`,
			note:      "four static faces (regular/bold/italic/bold-italic; upstream publishes no variable build); monospace option in the font settings",
			license:   "IBMPlexMono-OFL.txt",
		},
		{
			name: "Inconsolata", version: "3.001",
			copyright: "Copyright 2006 The Inconsolata Project Authors (https://github.com/cyrealtype/Inconsolata)",
			note:      "variable webfont, normal style only (upstream ships no italic); monospace option in the font settings",
			license:   "Inconsolata-OFL.txt",
		},
		{
			name: "IBM Plex Sans", version: "3.000",
			copyright: `Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"`,
			note:      "variable webfont (roman + italic); sans option in the font settings",
			license:   "IBMPlexSans-OFL.txt",
		},
		{
			name: "Source Sans 3", version: "3.052",
			copyright: "Copyright 2010-2024 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. All Rights Reserved. Source is a trademark of Adobe in the United States and/or other countries.",
			note:      "variable webfont (roman + italic); sans option in the font settings",
			license:   "SourceSans3-OFL.txt",
		},
		{
			name: "IBM Plex Serif", version: "1.000",
			copyright: `Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"`,
			note:      "variable webfont (roman + italic); serif option in the font settings",
			license:   "IBMPlexSerif-OFL.txt",
		},
		{
			name: "Source Serif Pro", version: "3.001",
			copyright: "Copyright 2014 - 2023 Adobe (http://www.adobe.com/), with Reserved Font Name ‘Source’. All Rights Reserved. Source is a trademark of Adobe in the United States and/or other countries.",
			note:      "variable webfont (roman + italic); serif option in the font settings. nixpkgs's source-serif-pro tops out at 3.001, the last release before the project's 4.x rebrand to \"Source Serif 4\"",
			license:   "SourceSerifPro-OFL.txt",
		},
		{
			name: "Merriweather", version: "2.200",
			copyright: `Copyright 2016 The Merriweather Project Authors (https://github.com/EbenSorkin/Merriweather), with Reserved Font Name "Merriweather".`,
			note:      "variable webfont (roman + italic; 3-axis build: optical size + width + weight); serif option in the font settings",
			license:   "Merriweather-OFL.txt",
		},
	}

	entries := make([]Entry, 0, len(fonts))
	for _, f := range fonts {
		raw, err := os.ReadFile(filepath.Join(g.repoRoot, "frontend", "src", "static", "fonts", f.license))
		if err != nil {
			return nil, fmt.Errorf("reading bundled font license %s: %w", f.license, err)
		}
		entries = append(entries, Entry{
			Name:      f.name,
			Version:   f.version,
			License:   "OFL-1.1",
			Copyright: f.copyright,
			Source:    "bundled",
			Note:      f.note + "; embedded in the binary and served from /static/fonts, license shipped alongside at static/fonts/" + f.license,
			Text:      string(raw),
		})
	}
	return entries, nil
}

// goModDirective returns the `go` directive from the repo's go.mod (e.g.
// "go1.25.0"), the minimum language version the binary is built against.
func (g *Generator) goModDirective() (string, error) {
	raw, err := os.ReadFile(filepath.Join(g.repoRoot, "go.mod"))
	if err != nil {
		return "", err
	}
	m := regexp.MustCompile(`(?m)^go\s+(\S+)`).FindSubmatch(raw)
	if m == nil {
		return "", fmt.Errorf("no go directive in go.mod")
	}
	return "go" + string(m[1]), nil
}

// ---- shared helpers ----

//go:embed go-license.txt
var vendoredGoLicense string

// goStdlibLicense returns the Go standard library's license text.
//
// It reads $GOROOT/LICENSE and NOTHING ELSE. It must never fall back to walking
// GOROOT: the tree contains ~20 other LICENSE files belonging to vendored
// dependencies, and the shallowest of them is
// src/crypto/internal/boring/LICENSE — BoringSSL's, which is largely OpenSSL's.
// That is exactly the bug this replaced: the nix Go package strips the
// top-level $GOROOT/LICENSE, so a walk picked BoringSSL and the shipped credits
// dialog told users the Go runtime was under OpenSSL terms. CI, using the
// official tarball, produced the correct text — so the two disagreed and the
// staleness gate failed, which is the gate working as designed.
//
// When $GOROOT/LICENSE is absent (nix), fall back to the vendored copy so the
// generator still runs in the project's own dev shell. When it IS present, the
// two must agree — a mismatch means Go relicensed or the vendored copy drifted,
// and silently preferring either would be wrong.
func goStdlibLicense(goroot string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(goroot, "LICENSE"))
	if err != nil {
		if os.IsNotExist(err) {
			return vendoredGoLicense, nil // nix and friends: no top-level LICENSE
		}
		return "", fmt.Errorf("read $GOROOT/LICENSE: %w", err)
	}
	if got := string(raw); got != vendoredGoLicense {
		return "", fmt.Errorf("$GOROOT/LICENSE does not match tools/gencredits/go-license.txt — "+
			"Go may have relicensed, or the vendored copy has drifted; reconcile them by hand "+
			"(goroot=%s, %d bytes vs %d)", goroot, len(got), len(vendoredGoLicense))
	}
	return string(raw), nil
}

// readLicenseFile finds the first LICENSE/LICENCE/COPYING file under dir
// (walking subdirectories, shallowest match first) and returns its contents.
// Used for MODULE directories, where a nested license is the module's own.
// Deliberately NOT used for GOROOT — see goStdlibLicense.
func readLicenseFile(dir string) string {
	nameRe := regexp.MustCompile(`(?i)^([a-z-]*licen[cs]e[a-z._-]*|copying([._-].*)?)$`)
	var candidates []string
	filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if nameRe.MatchString(info.Name()) {
			candidates = append(candidates, path)
		}
		return nil
	})
	if len(candidates) == 0 {
		return ""
	}
	sort.Slice(candidates, func(i, j int) bool {
		di := strings.Count(candidates[i], string(os.PathSeparator))
		dj := strings.Count(candidates[j], string(os.PathSeparator))
		if di != dj {
			return di < dj
		}
		return candidates[i] < candidates[j]
	})
	raw, err := os.ReadFile(candidates[0])
	if err != nil {
		return ""
	}
	return string(raw)
}

// copyrightLine pulls the first "Copyright ..." line out of a license text.
func copyrightLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(strings.TrimLeft(line, "/#*- \t"))
		if strings.HasPrefix(trimmed, "Copyright") {
			return trimmed
		}
	}
	return ""
}
