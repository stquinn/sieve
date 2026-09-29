package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The bug this pins: readLicenseFile walks a whole tree and takes the shallowest
// LICENSE. GOROOT contains ~20 of them belonging to vendored dependencies, and on
// a toolchain that omits the top-level LICENSE (the nix Go package does) the
// shallowest is src/crypto/internal/boring/LICENSE — BoringSSL's, which is
// largely OpenSSL's. The shipped credits dialog therefore told users the Go
// standard library was under OpenSSL terms.
func TestGoStdlibLicense_NeverPicksAVendoredLicense(t *testing.T) {
	goroot := t.TempDir() // no top-level LICENSE, like the nix layout
	boring := filepath.Join(goroot, "src", "crypto", "internal", "boring")
	if err := os.MkdirAll(boring, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(boring, "LICENSE"),
		[]byte("Copyright (c) 1998-2011 The OpenSSL Project.  All rights reserved."), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := goStdlibLicense(goroot)
	if err != nil {
		t.Fatalf("goStdlibLicense: %v", err)
	}
	if strings.Contains(got, "OpenSSL") {
		t.Fatalf("picked a vendored license from inside GOROOT:\n%s", got)
	}
	if !strings.Contains(got, "The Go Authors") {
		t.Fatalf("want the Go license, got:\n%s", got)
	}
}

// When the toolchain DOES ship $GOROOT/LICENSE, that file is the answer.
func TestGoStdlibLicense_PrefersTheRealFile(t *testing.T) {
	goroot := t.TempDir()
	if err := os.WriteFile(filepath.Join(goroot, "LICENSE"), []byte(vendoredGoLicense), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := goStdlibLicense(goroot)
	if err != nil {
		t.Fatalf("goStdlibLicense: %v", err)
	}
	if got != vendoredGoLicense {
		t.Error("returned text differs from $GOROOT/LICENSE")
	}
}

// A real $GOROOT/LICENSE that disagrees with the vendored copy means Go
// relicensed or the copy drifted. Silently preferring either would ship a
// license text nobody reviewed, so it must fail loudly instead.
func TestGoStdlibLicense_FailsOnDrift(t *testing.T) {
	goroot := t.TempDir()
	if err := os.WriteFile(filepath.Join(goroot, "LICENSE"),
		[]byte("Copyright 2031 The Go Authors. Now under different terms."), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := goStdlibLicense(goroot); err == nil {
		t.Fatal("drift between $GOROOT/LICENSE and the vendored copy must be an error")
	}
}

// The vendored copy is what nix builds ship, so it must be the real thing.
func TestVendoredGoLicense_IsTheGoLicense(t *testing.T) {
	if !strings.Contains(vendoredGoLicense, "Copyright 2009 The Go Authors.") {
		t.Error("vendored copy is missing the Go copyright line")
	}
	if strings.Contains(vendoredGoLicense, "OpenSSL") || strings.Contains(vendoredGoLicense, "BoringSSL") {
		t.Error("vendored copy is contaminated with BoringSSL/OpenSSL text")
	}
}

// grammarRepo lays out the two files javaGrammarEntry reads: the plugin manifest
// that pins the grammar, and the license committed beside the .wasm.
func grammarRepo(t *testing.T, pin, license string) *Generator {
	t.Helper()
	root := t.TempDir()
	plugin := filepath.Join(root, "frontend", "node_modules", "prettier-plugin-java")
	vendor := filepath.Join(root, "frontend", "src", "static", "vendor")
	for _, dir := range []string{plugin, vendor} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	manifest := `{"name":"prettier-plugin-java","version":"2.11.0","devDependencies":{"mocha":"^12.0.0"}}`
	if pin != "" {
		manifest = `{"name":"prettier-plugin-java","version":"2.11.0","devDependencies":{"mocha":"^12.0.0","tree-sitter-java-orchard":"` + pin + `"}}`
	}
	if err := os.WriteFile(filepath.Join(plugin, "package.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if license != "" {
		if err := os.WriteFile(filepath.Join(vendor, "tree-sitter-java_orchard-MIT.txt"), []byte(license), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return &Generator{repoRoot: root, frontendDir: filepath.Join(root, "frontend")}
}

// The grammar ships as a .wasm no metafile can see, so its entry is built from
// the plugin's pin and the license committed beside it.
func TestJavaGrammarEntry_CreditsTheShippedGrammar(t *testing.T) {
	g := grammarRepo(t, "0.5.22", "MIT License\n\nCopyright (c) 2017 Ayman Nadeem\n\nPermission is hereby granted...")

	entry, err := g.javaGrammarEntry()
	if err != nil {
		t.Fatalf("javaGrammarEntry: %v", err)
	}
	if entry.Version != "0.5.22" {
		t.Errorf("version = %q, want the plugin's pin 0.5.22", entry.Version)
	}
	if entry.License != "MIT" || entry.Source != "bundled" {
		t.Errorf("license/source = %q/%q, want MIT/bundled", entry.License, entry.Source)
	}
	if entry.Copyright != "Copyright (c) 2017 Ayman Nadeem" {
		t.Errorf("copyright = %q", entry.Copyright)
	}
	if !strings.Contains(entry.Text, "Permission is hereby granted") {
		t.Error("license text is not the committed copy")
	}
}

// Anything that leaves the shipped grammar unidentifiable fails the regen rather
// than crediting a version we cannot prove we shipped.
func TestJavaGrammarEntry_FailsWhenTheGrammarCannotBeIdentified(t *testing.T) {
	cases := []struct {
		name    string
		pin     string
		license string
	}{
		{"plugin no longer pins the grammar", "", "MIT License"},
		{"pin is a range, not a version", "^0.6.0", "MIT License"},
		{"license is not committed beside the wasm", "0.5.22", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := grammarRepo(t, c.pin, c.license).javaGrammarEntry(); err == nil {
				t.Fatal("want an error, got none")
			}
		})
	}
}

// go-licenses reports libraries, the build list names modules, and the match is
// the longest module path that prefixes the library — on a path separator, so a
// module is never credited with a sibling's version.
func TestModuleVersions_Of(t *testing.T) {
	versions := ModuleVersions{
		"golang.org/x/net":      "v0.38.0",
		"golang.org/x/net/http": "v0.1.0",
	}
	cases := []struct {
		name    string
		library string
		want    string
	}{
		{"library under a module", "golang.org/x/net/html", "v0.38.0"},
		{"the module itself", "golang.org/x/net", "v0.38.0"},
		{"nested modules: the longer wins", "golang.org/x/net/http/httpguts", "v0.1.0"},
		{"a sibling sharing a string prefix is not a match", "golang.org/x/netfoo/bar", ""},
		{"unknown path", "example.com/nope", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := versions.of(c.library); got != c.want {
				t.Errorf("of(%q) = %q, want %q", c.library, got, c.want)
			}
		})
	}
}
