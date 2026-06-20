package processors

import (
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

func newTestDocumentService(t *testing.T) (*services.DocumentService, *filestore.FileStore) {
	t.Helper()
	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	return ds, fs
}

// resetRegistry clears the global processor registry and re-registers the
// built-in prose terminal — the production baseline a codec test starts from.
// (block.ResetRegistry only clears; prose lives here in processors, so the
// restore must too.)
func resetRegistry() {
	block.ResetRegistry()
	block.RegisterProcessor(block.KindProse, &ProseProcessor{})
}
