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
	block.RegisterProcessor(&ProseProcessor{})
}

// blockIDOfKind returns the id of the first block of the given kind in the open
// shadow. Fixtures are written with readable legacy handles ("co-1", "pr-aaaa")
// but NewShadow upgrades those to UUIDs on load (#75), so a test that needs to
// address a fixture block asks the shadow for its id rather than naming one.
func blockIDOfKind(t *testing.T, shadow *block.ShadowDocument, kind string) string {
	t.Helper()
	for _, b := range shadow.SnapshotBlocks() {
		if b.Kind == kind {
			return b.ID
		}
	}
	t.Fatalf("no %q block in shadow", kind)
	return ""
}
