package ink

import (
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/ink/link"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// linkKey is the pairing key every test companion holds.
var linkKey = link.Key{'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'}

const companionID = "companion-identity"

// newTestContainers builds the container service over a temporary store, with the digital-note
// kind registered.
func newTestContainers(t *testing.T) (*services.BlockContainerService, *filestore.FileStore) {
	t.Helper()
	st, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	block.ResetRegistry()
	block.RegisterProcessor(&processors.ProseProcessor{})
	block.RegisterProcessor(NewDigitalNoteKind())
	t.Cleanup(block.ResetRegistry)
	containers, err := services.NewBlockContainerService(st, block.GlobalRegistry())
	if err != nil {
		t.Fatalf("NewBlockContainerService: %v", err)
	}
	return containers, st
}

// reopen is a service over a fresh store at st's root, resolving everything from disk.
func reopen(t *testing.T, st *filestore.FileStore) *services.BlockContainerService {
	t.Helper()
	fresh, err := filestore.NewFileStore(st.Root(), "testhost")
	if err != nil {
		t.Fatal(err)
	}
	containers, err := services.NewBlockContainerService(fresh, block.GlobalRegistry())
	if err != nil {
		t.Fatal(err)
	}
	return containers
}
