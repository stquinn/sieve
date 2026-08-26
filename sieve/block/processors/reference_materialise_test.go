package processors

import (
	"strconv"
	"strings"
	"testing"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/domain"
)

const sqlFixture = "SELECT id, name\nFROM customers\nWHERE active = 1;\n"

// heldAttrs is a reference's attrs as the drop path leaves them: the coordinate
// naming the asset at root, plus the mime and byte count stamped from those same
// bytes under cache. cache.mime is what makes it HELD — a sieve/* one would be a
// pointer.
func heldAttrs(uuid, key, mimeType string, size int) map[string]interface{} {
	return map[string]interface{}{
		"id":     "at-1",
		"uri":    domain.NewLeafAddress(uuid, key).String(),
		"cache":  map[string]interface{}{"mime": mimeType, "bytes": strconv.Itoa(size)},
		"status": block.BlockStatusComplete,
	}
}

func TestReferenceProcessor_MaterialiseContent_handsOverHeldText(t *testing.T) {
	uuid := ident.New()
	p := NewReferenceProcessor(block.BlockServices{
		Assets: fakeAssets{files: map[string][]byte{uuid + "/at-1.sql": []byte(sqlFixture)}},
	})

	got := p.MaterialiseContent(uuid, heldAttrs(uuid, "at-1.sql", "application/sql", len(sqlFixture)))
	if len(got) != 1 {
		t.Fatalf("expected one materialised entry, got %d", len(got))
	}
	if got[0].Content != sqlFixture {
		t.Errorf("content must round-trip byte-for-byte:\n got %q\nwant %q", got[0].Content, sqlFixture)
	}
	// text/plain and NOT the stamped mime: recognition must read the content, not the
	// filename's extension.
	if got[0].MIMEType != "text/plain" {
		t.Errorf("mimeType: got %q, want text/plain", got[0].MIMEType)
	}
}

func TestReferenceProcessor_MaterialiseContent_refusesBinary(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	uuid := ident.New()
	p := NewReferenceProcessor(block.BlockServices{
		Assets: fakeAssets{files: map[string][]byte{uuid + "/at-1.png": png}},
	})

	if got := p.MaterialiseContent(uuid, heldAttrs(uuid, "at-1.png", "image/png", len(png))); got != nil {
		t.Errorf("a binary file must hand over nothing; got %v", got)
	}
}

func TestReferenceProcessor_MaterialiseContent_refusesOversizedText(t *testing.T) {
	big := strings.Repeat("x = 1;\n", (maxMaterialisedTextBytes/7)+1)
	uuid := ident.New()
	p := NewReferenceProcessor(block.BlockServices{
		Assets: fakeAssets{files: map[string][]byte{uuid + "/at-1.js": []byte(big)}},
	})

	if got := p.MaterialiseContent(uuid, heldAttrs(uuid, "at-1.js", "text/javascript", len(big))); got != nil {
		t.Errorf("a file over the editable-content ceiling must hand over nothing; got %d entries", len(got))
	}
}

// The stamped size is only a claim; a file that grew on disk is refused on its real
// length too, so nothing unbounded reaches the document.
func TestReferenceProcessor_MaterialiseContent_refusesUnderstatedSize(t *testing.T) {
	big := strings.Repeat("x = 1;\n", (maxMaterialisedTextBytes/7)+1)
	uuid := ident.New()
	p := NewReferenceProcessor(block.BlockServices{
		Assets: fakeAssets{files: map[string][]byte{uuid + "/at-1.js": []byte(big)}},
	})

	if got := p.MaterialiseContent(uuid, heldAttrs(uuid, "at-1.js", "text/javascript", 12)); got != nil {
		t.Errorf("an understated size must not get past the post-read check; got %d entries", len(got))
	}
}

// THE FACE DECIDES, and a sieve/* mime says POINTER however leaf-shaped the
// address is. Nothing here inspects the uri to work out what the block is.
func TestReferenceProcessor_MaterialiseContent_refusesAPointer(t *testing.T) {
	uuid := ident.New()
	p := NewReferenceProcessor(block.BlockServices{
		Assets: fakeAssets{files: map[string][]byte{uuid + "/at-1.sql": []byte(sqlFixture)}},
	})
	attrs := heldAttrs(uuid, "at-1.sql", "sieve/note", len(sqlFixture))

	if got := p.MaterialiseContent(uuid, attrs); got != nil {
		t.Errorf("a pointer holds no bytes of its own; got %v", got)
	}
}

// A reference whose face has not landed has no mime and no size — nothing is
// known about the bytes yet, so nothing is handed over (and nothing is read).
func TestReferenceProcessor_MaterialiseContent_refusesAnUnfacedReference(t *testing.T) {
	uuid := ident.New()
	p := NewReferenceProcessor(block.BlockServices{
		Assets: fakeAssets{files: map[string][]byte{uuid + "/at-1.sql": []byte(sqlFixture)}},
	})
	attrs := map[string]interface{}{
		"id": "at-1", "uri": domain.NewLeafAddress(uuid, "at-1.sql").String(),
	}

	if got := p.MaterialiseContent(uuid, attrs); got != nil {
		t.Errorf("an unfaced reference must hand over nothing; got %v", got)
	}
}

// A held reference copied into ANOTHER document still reaches its bytes: the
// container comes off the address it has always carried, never off whichever
// document is being rendered.
func TestReferenceProcessor_MaterialiseContent_readsTheContainerItsAddressNames(t *testing.T) {
	origin, elsewhere := ident.New(), ident.New()
	p := NewReferenceProcessor(block.BlockServices{
		Assets: fakeAssets{files: map[string][]byte{origin + "/at-1.sql": []byte(sqlFixture)}},
	})

	got := p.MaterialiseContent(elsewhere, heldAttrs(origin, "at-1.sql", "application/sql", len(sqlFixture)))
	if len(got) != 1 || got[0].Content != sqlFixture {
		t.Errorf("a copied held reference must still read its own container's bytes; got %v", got)
	}
}
