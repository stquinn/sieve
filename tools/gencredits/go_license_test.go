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
