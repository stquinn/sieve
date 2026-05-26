package sieve

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocaliseImages_NoImages(t *testing.T) {
	result := localiseImages("# Heading\n\nSome text with no images.", t.TempDir())
	if result != "# Heading\n\nSome text with no images." {
		t.Errorf("content should be unchanged: %q", result)
	}
}

func TestLocaliseImages_RemoteImage_Success(t *testing.T) {
	// Serve a fake PNG
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		// Minimal 1x1 PNG bytes
		w.Write([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"))
	}))
	defer srv.Close()

	docDir := t.TempDir()
	content := "![alt](" + srv.URL + "/img.png)"
	result := localiseImages(content, docDir)

	if strings.Contains(result, srv.URL) {
		t.Error("remote URL should have been replaced with local path")
	}
	if !strings.Contains(result, ".assets") {
		t.Errorf("expected local .assets path, got: %q", result)
	}

	// Verify file was saved
	assetsDir := filepath.Join(docDir, ".assets")
	entries, err := os.ReadDir(assetsDir)
	if err != nil || len(entries) == 0 {
		t.Error("expected at least one file in .assets directory")
	}
}

func TestLocaliseImages_RemoteImage_Failure(t *testing.T) {
	// Server that returns 404
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	content := "![alt](" + srv.URL + "/missing.png)"
	result := localiseImages(content, t.TempDir())

	// URL should remain unchanged on failure
	if !strings.Contains(result, srv.URL) {
		t.Error("failed fetch should leave remote URL unchanged")
	}
}

func TestLocaliseImages_MultipleImages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write([]byte("\x89PNG\r\n\x1a\n"))
	}))
	defer srv.Close()

	docDir := t.TempDir()
	content := "![a](" + srv.URL + "/a.png)\n\n![b](" + srv.URL + "/b.png)"
	result := localiseImages(content, docDir)

	if strings.Contains(result, srv.URL) {
		t.Error("all remote URLs should have been replaced")
	}
}
