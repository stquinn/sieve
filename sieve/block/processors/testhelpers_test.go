package processors

import (
	"strconv"
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/domain"
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

// leafAddress is the absolute address of block id in the document doc: what a
// model is shown for that block.
func leafAddress(doc, id string) string {
	return domain.NewLeafAddress(doc, id).String()
}

// blockMarker is the line opening TARGET entry n of m of the given kind,
// newline-terminated.
func blockMarker(n, m int, kind string) string {
	return "===== BLOCK " + strconv.Itoa(n) + " of " + strconv.Itoa(m) + " \u00b7 " + kind + " =====\n"
}

// targetEntries is a TARGET of the given entries, each already opened by its
// blockMarker: entries are separated by a blank line.
func targetEntries(entries ...string) string {
	return strings.Join(entries, "\n\n")
}

// addressHeader is the ADDRESS header line a context headed by the blocks ids of
// the document doc renders, newline-terminated.
func addressHeader(doc string, ids ...string) string {
	addrs := make([]string, len(ids))
	for i, id := range ids {
		addrs[i] = leafAddress(doc, id)
	}
	return "ADDRESS: " + strings.Join(addrs, ",") + "\n"
}

// documentHeader is the ADDRESS header line of the whole document doc,
// newline-terminated.
func documentHeader(doc string) string {
	return "ADDRESS: " + domain.NewContainerAddress(doc).String() + "\n"
}
