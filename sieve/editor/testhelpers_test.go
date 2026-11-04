package editor

import (
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/blockcontainer"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// resetRegistry clears the global processor registry and restores the built-in
// prose terminal — the production baseline an editor/codec test starts from.
func resetRegistry() {
	block.ResetRegistry()
	block.RegisterProcessor(&processors.ProseProcessor{})
}

// newTestDocumentService creates a DocumentService backed by a temporary FileStore.
func newTestDocumentService(t *testing.T) (*services.DocumentService, *filestore.FileStore) {
	t.Helper()
	dir := t.TempDir()
	fs, err := filestore.NewFileStore(dir, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}

	return ds, fs
}

// containerKind is the block kind the editor's tests put in a container.
const containerKind = "code"

// newTestContainers builds the container service beside the document service over
// one temporary store, with containerKind registered.
func newTestContainers(t *testing.T) (*blockcontainer.BlockContainerService, *services.DocumentService, *filestore.FileStore) {
	t.Helper()
	withCodeProcessor(t)
	ds, st := newTestDocumentService(t)
	containers, err := blockcontainer.NewBlockContainerService(st, block.GlobalRegistry())
	if err != nil {
		t.Fatalf("NewBlockContainerService: %v", err)
	}
	return containers, ds, st
}
