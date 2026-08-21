package processors

import (
	"strconv"
	"strings"
	"testing"

	"sieve/sieve/block"
)

const sqlFixture = "SELECT id, name\nFROM customers\nWHERE active = 1;\n"

// heldAttrs is an attachment's attrs as the ingest job leaves them for a held file:
// the on-disk name, the sniffed mime and the byte count, all stamped from the bytes.
func heldAttrs(src, mimeType string, size int) map[string]interface{} {
	return map[string]interface{}{
		"id":     "at-1",
		"src":    src,
		"mime":   mimeType,
		"bytes":  strconv.Itoa(size),
		"status": block.BlockStatusComplete,
	}
}

func TestAttachmentProcessor_MaterialiseContent_handsOverHeldText(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{
		Assets: fakeAssets{files: map[string][]byte{"doc-1/at-1.sql": []byte(sqlFixture)}},
	})

	got := p.MaterialiseContent("doc-1", heldAttrs("at-1.sql", "application/sql", len(sqlFixture)))
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

func TestAttachmentProcessor_MaterialiseContent_refusesBinary(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	p := NewAttachmentProcessor(block.BlockServices{
		Assets: fakeAssets{files: map[string][]byte{"doc-1/at-1.png": png}},
	})

	if got := p.MaterialiseContent("doc-1", heldAttrs("at-1.png", "image/png", len(png))); got != nil {
		t.Errorf("a binary file must hand over nothing; got %v", got)
	}
}

func TestAttachmentProcessor_MaterialiseContent_refusesOversizedText(t *testing.T) {
	big := strings.Repeat("x = 1;\n", (maxMaterialisedTextBytes/7)+1)
	p := NewAttachmentProcessor(block.BlockServices{
		Assets: fakeAssets{files: map[string][]byte{"doc-1/at-1.js": []byte(big)}},
	})

	if got := p.MaterialiseContent("doc-1", heldAttrs("at-1.js", "text/javascript", len(big))); got != nil {
		t.Errorf("a file over the editable-content ceiling must hand over nothing; got %d entries", len(got))
	}
}

// The stamped size is only a claim; a file that grew on disk is refused on its real
// length too, so nothing unbounded reaches the document.
func TestAttachmentProcessor_MaterialiseContent_refusesUnderstatedSize(t *testing.T) {
	big := strings.Repeat("x = 1;\n", (maxMaterialisedTextBytes/7)+1)
	p := NewAttachmentProcessor(block.BlockServices{
		Assets: fakeAssets{files: map[string][]byte{"doc-1/at-1.js": []byte(big)}},
	})

	if got := p.MaterialiseContent("doc-1", heldAttrs("at-1.js", "text/javascript", 12)); got != nil {
		t.Errorf("an understated size must not get past the post-read check; got %d entries", len(got))
	}
}

func TestAttachmentProcessor_MaterialiseContent_refusesCitation(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{Assets: fakeAssets{}})
	attrs := map[string]interface{}{"id": "at-2", "uri": "container:9f2b", "mime": "", "bytes": ""}

	if got := p.MaterialiseContent("doc-1", attrs); got != nil {
		t.Errorf("a citation holds no bytes; got %v", got)
	}
}

// An attachment whose ingest has not landed has no mime and no size — nothing is
// known about the bytes yet, so nothing is handed over (and nothing is read).
func TestAttachmentProcessor_MaterialiseContent_refusesUningested(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{
		Assets: fakeAssets{files: map[string][]byte{"doc-1/at-1.sql": []byte(sqlFixture)}},
	})
	attrs := map[string]interface{}{"id": "at-1", "src": "at-1.sql", "mime": "", "bytes": ""}

	if got := p.MaterialiseContent("doc-1", attrs); got != nil {
		t.Errorf("an un-ingested attachment must hand over nothing; got %v", got)
	}
}
