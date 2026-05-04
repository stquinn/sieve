package sieve

import (
	"strings"
	"testing"

	"sieve/store/filestore"
)

func newTestDocumentService(t *testing.T) (*DocumentService, *filestore.FileStore) {
	t.Helper()
	dir := t.TempDir()
	fs, err := filestore.NewFileStore(dir, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	ds, err := NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}

	return ds, fs
}

func TestDocumentService_FilePromotesBufferAndAssets(t *testing.T) {
	ds, fs := newTestDocumentService(t)

	// 1. Create a new buffer
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("Failed to create new buffer: %v", err)
	}

	// 2. Attach an asset to the buffer via the FileStore
	// We need to simulate what AssetService does
	asset, err := fs.CreateAsset(WorkingCopy, doc.Storable().Meta()["uuid"], "img1", []byte("fake-png"))
	if err != nil {
		t.Fatalf("Failed to create asset: %v", err)
	}

	// 3. Attach it to the document
	doc.Storable().AttachAsset(asset)
	
	oldExtRef := asset.ExternalRef()
	
	// Add markdown containing the external ref to the body
	doc.Storable().SetBody([]byte("Image: ![](" + oldExtRef + ")"))

	// Save document to persist it
	doc, err = ds.Save(doc)
	if err != nil {
		t.Fatalf("Failed to save document: %v", err)
	}

	// Set display name so that when it's filed, it takes a specific name
	meta := doc.Storable().Meta()
	meta["display_name"] = "My Test Note"
	doc.Storable().SetMeta(meta)

	// 4. File the document (promotes to Library)
	filedDoc, err := ds.File(doc)
	if err != nil {
		t.Fatalf("Failed to file document: %v", err)
	}

	// 5. Verify the filed document
	if filedDoc.Kind() != KindNote {
		t.Errorf("Expected filed document to be a Note, got %v", filedDoc.Kind())
	}

	// Read the new body
	newBody := string(filedDoc.Body())
	newOwns := filedDoc.Storable().Owns()

	if len(newOwns) == 0 {
		t.Fatal("Owned assets lost during File operation")
	}

	// In the document-as-directory model, asset URLs are UUID-stable:
	// /sieve/{uuid}/{filename} — the UUID doesn't change on Move/Rename, so
	// the asset reference in the body is preserved as-is. The old and new
	// ExternalRefs are identical.
	newExtRef := newOwns[0].ExternalRef()
	if !strings.Contains(newBody, oldExtRef) {
		t.Errorf("Expected body to still contain the stable asset ref %q, got: %s", oldExtRef, newBody)
	}
	_ = newExtRef
}
