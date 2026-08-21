package services

import (
	"os"
	"path/filepath"
	"testing"
)

func newStoreFileService(t *testing.T) (*AssetService, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "images"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "images", "shot.png"), []byte("PNGBYTES"), 0o644); err != nil {
		t.Fatal(err)
	}
	return NewAssetService(nil, root), root
}

func TestServeStoreFile_ReadsRootRelativePath(t *testing.T) {
	as, _ := newStoreFileService(t)

	data, err := as.ServeStoreFile("images/shot.png")
	if err != nil {
		t.Fatalf("ServeStoreFile: %v", err)
	}
	if string(data) != "PNGBYTES" {
		t.Fatalf("got %q", data)
	}
}

// The path arrives from a URL, so escapes must be refused rather than cleaned
// into something that reads outside the library.
func TestServeStoreFile_RefusesTraversal(t *testing.T) {
	as, root := newStoreFileService(t)
	outside := filepath.Join(filepath.Dir(root), "secret.txt")
	if err := os.WriteFile(outside, []byte("SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(outside) })

	for _, rel := range []string{"../secret.txt", "images/../../secret.txt", "/../secret.txt"} {
		if _, err := as.ServeStoreFile(rel); err == nil {
			t.Errorf("%q: expected refusal, got a read", rel)
		}
	}
}

func TestServeStoreFile_RefusesDirectoriesAndUnsetRoot(t *testing.T) {
	as, _ := newStoreFileService(t)
	if _, err := as.ServeStoreFile("images"); err == nil {
		t.Error("expected a directory to be refused")
	}
	if _, err := NewAssetService(nil, "").ServeStoreFile("images/shot.png"); err == nil {
		t.Error("expected an unset store root to be refused")
	}
}

// An SVG sniffs as text/xml or text/plain, and a browser renders neither as an
// image — the correction is the whole reason this method exists.
func TestDetectContentType_CorrectsSVG(t *testing.T) {
	as, _ := newStoreFileService(t)
	svg := []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`)
	if got := as.DetectContentType(svg); got != "image/svg+xml" {
		t.Fatalf("svg: got %q", got)
	}
	png := []byte("\x89PNG\r\n\x1a\n" + string(make([]byte, 200)))
	if got := as.DetectContentType(png); got != "image/png" {
		t.Fatalf("png: got %q", got)
	}
}
