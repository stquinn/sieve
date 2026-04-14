package vault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFileBuffer_AssetPromotion(t *testing.T) {
	root := t.TempDir()
	v, err := Open(root)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}

	// Create a new buffer
	res, err := v.NewBuffer()
	if err != nil {
		t.Fatalf("NewBuffer failed: %v", err)
	}
	absPath := filepath.Join(v.Root, res.Path)

	// Create a fake asset in buffers/assets
	assetName := "blk-a1b2.png"
	assetSrc := filepath.Join(v.BufferAssetsPath(), assetName)
	if err := os.WriteFile(assetSrc, []byte("fake image data"), 0644); err != nil {
		t.Fatalf("write asset failed: %v", err)
	}

	// Write content to buffer
	content := newBufferMeta(time.Now(), 1, "test-uuid-promote") + "\n# Test Note\nThis is a test image: ![alt](../../buffers/assets/blk-a1b2.png)\n"
	if err := os.WriteFile(absPath, []byte(content), 0644); err != nil {
		t.Fatalf("write buffer failed: %v", err)
	}

	// File the buffer
	destRelPath, err := v.FileBuffer(absPath)
	if err != nil {
		t.Fatalf("FileBuffer failed: %v", err)
	}
	destAbsPath := filepath.Join(v.Root, destRelPath)

	// Check buffer was moved
	if _, err := os.Stat(absPath); !os.IsNotExist(err) {
		t.Errorf("expected source buffer %s to be deleted", absPath)
	}
	if _, err := os.Stat(destAbsPath); err != nil {
		t.Errorf("expected dest buffer %s to exist", destAbsPath)
	}

	destContentTmp, _ := os.ReadFile(destAbsPath)

	// Determine the name that FileBuffer will actually use
	contentStr := string(destContentTmp)
	// We extract the actual name from the markdown output to know what it used
	destAssetPathPrefix := ""
	if idx := strings.Index(contentStr, "../assets/"); idx != -1 {
		endIdx := strings.Index(contentStr[idx:], ")")
		if endIdx != -1 {
			destAssetPathPrefix = contentStr[idx+len("../assets/") : idx+endIdx]
		}
	}

	destAssetPath := filepath.Join(v.AssetsPath(), destAssetPathPrefix)
	if _, err := os.Stat(destAssetPath); err != nil {
		t.Errorf("expected promoted asset %s to exist", destAssetPath)
	}
	if _, err := os.Stat(assetSrc); !os.IsNotExist(err) {
		t.Errorf("expected source asset %s to be deleted", assetSrc)
	}

	// Read it before to grab the file name, actually we do it here:
	destContent, err := os.ReadFile(destAbsPath)
	if err != nil {
		t.Fatalf("read dest file failed: %v", err)
	}
	if !strings.Contains(string(destContent), "../assets/"+destAssetPathPrefix) {
		t.Errorf("expected markdown to contain updated asset path, got:\n%s", string(destContent))
	}
}

func TestDiscardBuffer_AssetCleanup(t *testing.T) {
	root := t.TempDir()
	v, err := Open(root)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}

	// Create a new buffer
	res, err := v.NewBuffer()
	if err != nil {
		t.Fatalf("NewBuffer failed: %v", err)
	}
	absPath := filepath.Join(v.Root, res.Path)

	// Create a fake asset in buffers/assets
	assetName := "blk-x9y8.png"
	assetSrc := filepath.Join(v.BufferAssetsPath(), assetName)
	if err := os.WriteFile(assetSrc, []byte("fake image data"), 0644); err != nil {
		t.Fatalf("write asset failed: %v", err)
	}

	// Write content to buffer
	content := newBufferMeta(time.Now(), 1, "test-uuid-cleanup") + "\n# Trash Note\nReference to image: ![alt](../../buffers/assets/blk-x9y8.png)\n"
	if err := os.WriteFile(absPath, []byte(content), 0644); err != nil {
		t.Fatalf("write buffer failed: %v", err)
	}

	// Discard the buffer
	if err := v.DiscardBuffer(absPath); err != nil {
		t.Fatalf("DiscardBuffer failed: %v", err)
	}

	// Check buffer is gone
	if _, err := os.Stat(absPath); !os.IsNotExist(err) {
		t.Errorf("expected buffer %s to be deleted", absPath)
	}

	// Check asset is gone
	if _, err := os.Stat(assetSrc); !os.IsNotExist(err) {
		t.Errorf("expected asset %s to be deleted", assetSrc)
	}
}
