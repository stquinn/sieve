package processors

import (
	"encoding/base64"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// dropped builds the content entry a file drop produces: the surface reads the
// file as a data URI and stamps the ORIGINAL filename in the entry's Context,
// because readAsDataURL carries the bytes and nothing else.
func dropped(mimeType, filename, body string) block.ContentEntry {
	declared := mimeType
	if declared == "" {
		declared = "application/octet-stream"
	}
	return block.ContentEntry{
		MIMEType: mimeType,
		Content:  "data:" + declared + ";base64," + base64.StdEncoding.EncodeToString([]byte(body)),
		Context:  map[string]interface{}{"filename": filename},
	}
}

// A dropped file reaches Go through the SAME paste-match pipeline a paste does,
// and the registry decides who claims it. This kind claims every file that is NOT
// an image.
//
// Refusing images is the load-bearing half. smart-image already handles them
// properly — sizing, description, the lightbox — and a kind that ALSO claimed them
// would leave which of the two wins decided by registration order alone. This
// refusal is what makes that impossible; see the paste-match tests below.
func TestReferenceProcessor_IsSupportedContent_claimsADroppedFile(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	cases := []struct {
		name  string
		entry block.ContentEntry
		want  bool
	}{
		{"a dropped yaml file", dropped("text/yaml", "swagger.yml", "openapi: 3.0.0"), true},
		{"a dropped file the OS has no type for", dropped("", "CHANGELOG", "some bytes"), true},
		{"a dropped png belongs to smart-image", dropped("image/png", "shot.png", "\x89PNG"), false},
		{"a dropped svg belongs to smart-image", dropped("image/svg+xml", "logo.svg", "<svg/>"), false},
		{
			// The OS gave no type but the browser's data URI declares one. Both halves
			// are read, so an image cannot slip through by arriving untyped.
			name: "an untyped entry whose data URI declares an image is still smart-image's",
			entry: block.ContentEntry{
				MIMEType: "",
				Content:  "data:image/webp;base64," + base64.StdEncoding.EncodeToString([]byte("RIFF")),
				Context:  map[string]interface{}{"filename": "shot"},
			},
			want: false,
		},
		{
			name: "a data URI with no filename is not a dropped file",
			entry: block.ContentEntry{
				MIMEType: "text/yaml",
				Content:  "data:text/yaml;base64," + base64.StdEncoding.EncodeToString([]byte("openapi: 3.0.0")),
			},
			want: false,
		},
		{
			name: "a filename with no data URI is not a dropped file",
			entry: block.ContentEntry{
				MIMEType: "text/plain",
				Content:  "swagger.yml",
				Context:  map[string]interface{}{"filename": "swagger.yml"},
			},
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := p.IsSupportedContent([]block.ContentEntry{tc.entry})
			if got.Has(block.ActionPaste) != tc.want {
				t.Errorf("paste: got %v, want %v (offer %+v)", got.Has(block.ActionPaste), tc.want, got.Actions)
			}
			// A dropped file is a CREATION, never an offer in the extract menu:
			// there is no source block to extract from or transform.
			if tc.want && (got.Has(block.ActionExtract) || got.Has(block.ActionTransform)) {
				t.Errorf("a dropped file must claim paste alone; got %+v", got.Actions)
			}
		})
	}
}

// Transform is where a drop becomes a block, and it seeds the WHOLE face: the
// bytes are in memory here, so the address, the format, the size and the first
// line are all known at mint. Nothing is left for a job to discover.
func TestReferenceProcessor_Transform_savesADroppedFile(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("new document: %v", err)
	}
	assets := services.NewAssetService(fs, "")
	p := NewReferenceProcessor(block.BlockServices{Documents: ds, Assets: assets})

	body := "openapi: 3.0.0\ninfo:\n  title: Payments API\n"
	overrides := p.Transform(
		[]block.ContentEntry{dropped("text/yaml", "swagger.yml", body)},
		doc.UUID(), ident.New(), block.ActionPaste)

	if overrides == nil {
		t.Fatal("Transform declined a dropped file")
	}
	// The address is MINTED through the grammar, never concatenated: a held file
	// is an ordinary coordinate naming the asset this document now owns.
	uri, _ := overrides["uri"].(string)
	addr, err := domain.ParseAddress(uri)
	if err != nil {
		t.Fatalf("a held reference must be created with a parseable coordinate, got %q: %v", uri, err)
	}
	if addr.Container != doc.UUID() || addr.Leaf == "" {
		t.Errorf("uri %q must name a leaf inside this document (%s)", uri, doc.UUID())
	}
	// The face lands under cache, never at root: root attrs describe the pointing.
	face := refFace(t, overrides)
	// The chip is labelled with what the USER dropped. The stored asset is named
	// after the block, so without this the chip would wear a UUID.
	if face["title"] != "swagger.yml" {
		t.Errorf("cache.title: got %v, want the original filename swagger.yml", face["title"])
	}
	// The whole face, at mint: mime says what it is (and that it is HELD), bytes
	// says how big, summary is the first line that carries anything.
	if face["mime"] != "text/yaml" {
		t.Errorf("cache.mime: got %v, want text/yaml", face["mime"])
	}
	if got, want := face["bytes"], strconv.Itoa(len(body)); got != want {
		t.Errorf("cache.bytes: got %v, want %q", got, want)
	}
	if s, _ := face["summary"].(string); !strings.Contains(s, "openapi: 3.0.0") {
		t.Errorf("cache.summary must excerpt the file; got %q", s)
	}
	// A face minted from bytes in hand is dated at mint.
	if ts, _ := face["cachedAt"].(string); ts == "" {
		t.Error("a dropped file's face must be stamped with cachedAt")
	}
	// …and the bytes are readable back by the key the address names.
	got, err := assets.ServeAssetData(doc.UUID(), addr.Leaf)
	if err != nil {
		t.Fatalf("saved asset is not readable back as %q: %v", addr.Leaf, err)
	}
	if string(got) != body {
		t.Errorf("stored bytes = %q, want the dropped file's contents", got)
	}
}

// A dropped file is born COMPLETE: its face is filled, so there is nothing to
// resolve and no job to wait for. status and completedAt are stamped together.
func TestReferenceProcessor_droppedFileIsBornCompleteAndFaced(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("new document: %v", err)
	}
	p := NewReferenceProcessor(block.BlockServices{Documents: ds, Assets: services.NewAssetService(fs, "")})

	body := "openapi: 3.0.0\ninfo:\n  title: Payments API\n"
	blockID := ident.New()
	overrides := p.Transform(
		[]block.ContentEntry{dropped("text/yaml", "swagger.yml", body)},
		doc.UUID(), blockID, block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform declined a dropped file")
	}

	blk := &block.SieveBlock{ID: blockID, Kind: "reference", Attrs: p.InitAttrs(blockID, overrides)}
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE — the face is filled at mint", blk.Attrs["status"])
	}
	if ts, _ := blk.Attrs["completedAt"].(string); ts == "" {
		t.Error("a born-COMPLETE block must be stamped with completedAt")
	}
	if job := p.DescribeJob(block.JobContext{UUID: doc.UUID(), Block: blk}); job != nil {
		t.Errorf("a faced reference describes no job; got %+v", job)
	}
	if refFace(t, blk.Attrs)["title"] != "swagger.yml" {
		t.Errorf("cache.title: got %v, want the dropped filename", blk.Attrs["cache"])
	}
}

// The stored filename keeps the dropped file's EXTENSION, because the mime sniff
// reads it and the store's own fallback is magic bytes, which cannot tell YAML
// from any other text. Lose the extension here and a swagger spec's chip reads
// "txt".
func TestReferenceProcessor_Transform_storedAssetKeepsTheExtension(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("new document: %v", err)
	}
	p := NewReferenceProcessor(block.BlockServices{Documents: ds, Assets: services.NewAssetService(fs, "")})

	overrides := p.Transform(
		[]block.ContentEntry{dropped("text/yaml", "swagger.yml", "openapi: 3.0.0")},
		doc.UUID(), ident.New(), block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform declined a dropped file")
	}
	addr, err := domain.ParseAddress(overrides["uri"].(string))
	if err != nil {
		t.Fatalf("ParseAddress: %v", err)
	}
	if ext := filepath.Ext(addr.Leaf); ext != ".yml" {
		t.Errorf("stored asset %q has extension %q, want .yml", addr.Leaf, ext)
	}
	// …and the asset is named after the BLOCK, never after the dropped file: a
	// document directory holds meta.json and content.md, and a drop free to name
	// its own file could overwrite either.
	if addr.Leaf == "swagger.yml" {
		t.Error("the stored asset must not be named after the dropped file — it would clobber the document's own files")
	}
}

// A binary file still becomes a chip that names it and states its size; only the
// excerpt is withheld, because decoded rubbish under a chip would be worse than
// an honest blank.
func TestReferenceProcessor_Transform_binaryDropGetsNoSummary(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("new document: %v", err)
	}
	p := NewReferenceProcessor(block.BlockServices{Documents: ds, Assets: services.NewAssetService(fs, "")})

	overrides := p.Transform(
		[]block.ContentEntry{dropped("application/pdf", "spec.pdf", "%PDF-1.7\n\x00\x01\x02binary rubbish")},
		doc.UUID(), ident.New(), block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform declined a dropped pdf")
	}
	face := refFace(t, overrides)
	if face["mime"] != "application/pdf" {
		t.Errorf("cache.mime: got %v, want application/pdf", face["mime"])
	}
	if s, _ := face["summary"].(string); s != "" {
		t.Errorf("a binary file carries no summary; got %q", s)
	}
}

func TestReferenceProcessor_Transform_declinesADroppedImage(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	if o := p.Transform([]block.ContentEntry{dropped("image/png", "shot.png", "\x89PNG")}, "u", "at-1", block.ActionPaste); o != nil {
		t.Errorf("Transform must decline a dropped image; got %v", o)
	}
}

// A drop that cannot be stored must produce NO BLOCK rather than an empty one: an
// addressless reference is born COMPLETE, so it would sit in the document as a
// permanently blank chip nothing ever fills in.
func TestReferenceProcessor_Transform_declinesWhenTheAssetCannotBeSaved(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	if o := p.Transform([]block.ContentEntry{dropped("text/yaml", "swagger.yml", "openapi: 3.0.0")}, "u", "at-1", block.ActionPaste); o != nil {
		t.Errorf("Transform must decline when there is no asset service to save through; got %v", o)
	}
}

// The backstop half of the size ceiling. The frontend refuses an over-limit file
// before it reads it and SAYS SO; this exists because a server must not trust a
// client, so it refuses the same file and writes nothing to disk.
func TestReferenceProcessor_Transform_refusesAFileOverTheSizeLimit(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("new document: %v", err)
	}
	p := NewReferenceProcessor(block.BlockServices{Documents: ds, Assets: services.NewAssetService(fs, "")})

	over := dropped("application/pdf", "huge.pdf", strings.Repeat("x", domain.DefaultMaxAttachmentBytes+1))
	if o := p.Transform([]block.ContentEntry{over}, doc.UUID(), ident.New(), block.ActionPaste); o != nil {
		t.Errorf("Transform must refuse a file over the ceiling; got %v", o)
	}

	// …and the boundary itself is INSIDE the limit, so a file at exactly the
	// ceiling still attaches.
	at := dropped("application/pdf", "big.pdf", strings.Repeat("x", domain.DefaultMaxAttachmentBytes))
	if o := p.Transform([]block.ContentEntry{at}, doc.UUID(), ident.New(), block.ActionPaste); o == nil {
		t.Error("a file of exactly the ceiling must still attach")
	}
}

// #84 — the ceiling is a judgement about the user's machine and content, not a
// property of the code, so max_attachment_bytes moves it. The setting is the
// BACKSTOP's ceiling too: a client that ignores its own pre-check still meets it.
func TestReferenceProcessor_Transform_honoursTheConfiguredCeiling(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("new document: %v", err)
	}
	settings := domain.DefaultSettings()
	settings.MaxAttachmentBytes = 64
	p := NewReferenceProcessor(block.BlockServices{
		Documents: ds,
		Assets:    services.NewAssetService(fs, ""),
		State:     fakeState{settings: settings},
	})

	over := dropped("application/pdf", "small-but-over.pdf", strings.Repeat("x", 65))
	if o := p.Transform([]block.ContentEntry{over}, doc.UUID(), ident.New(), block.ActionPaste); o != nil {
		t.Errorf("a LOWERED ceiling must refuse a file the default would have taken; got %v", o)
	}
	under := dropped("application/pdf", "tiny.pdf", strings.Repeat("x", 64))
	if o := p.Transform([]block.ContentEntry{under}, doc.UUID(), ident.New(), block.ActionPaste); o == nil {
		t.Error("a file at exactly the configured ceiling must still attach")
	}
}

// A settings.json with no max_attachment_bytes — or a zero one — must not read as
// "no files allowed"; the ceiling falls back to the default.
func TestReferenceProcessor_UnsetCeilingFallsBackToTheDefault(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{State: fakeState{settings: domain.Settings{}}})
	if got := p.maxHeldBytes(); got != domain.DefaultMaxAttachmentBytes {
		t.Errorf("unset ceiling = %d, want the default %d", got, domain.DefaultMaxAttachmentBytes)
	}
	// A processor with no state port at all (bare test constructions) is the same
	// case: a default ceiling, never an absent one.
	bare := NewReferenceProcessor(block.BlockServices{})
	if got := bare.maxHeldBytes(); got != domain.DefaultMaxAttachmentBytes {
		t.Errorf("state-less ceiling = %d, want the default %d", got, domain.DefaultMaxAttachmentBytes)
	}
}

// A dropped image resolves to smart-image regardless of which of the two kinds is
// registered first, because reference refuses images outright. Both orders are
// asserted, so the guarantee cannot become order-dependent.
func TestPasteMatch_aDroppedImageNeverReachesReference(t *testing.T) {
	svc := block.BlockServices{}
	image := []block.ContentEntry{dropped("image/png", "shot.png", "\x89PNG\r\n\x1a\n")}
	orders := map[string][]block.BlockProcessor{
		"production order (smart-image first)": {NewSmartImageProcessor(svc), NewReferenceProcessor(svc)},
		"reversed":                             {NewReferenceProcessor(svc), NewSmartImageProcessor(svc)},
	}
	for name, order := range orders {
		t.Run(name, func(t *testing.T) {
			resetRegistry()
			t.Cleanup(resetRegistry)
			for _, proc := range order {
				block.RegisterProcessor(proc)
			}
			kind, _, _, ok := block.FirstPasteMatch(image)
			if !ok || kind != "smart-image" {
				t.Errorf("a dropped image matched %q (ok=%v), want smart-image", kind, ok)
			}
		})
	}
}

// The other half of the same property: a dropped NON-image is nobody else's, so
// reference gets it with both kinds registered as production registers them.
func TestPasteMatch_aDroppedNonImageBecomesAReference(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)
	svc := block.BlockServices{}
	block.RegisterProcessor(NewSmartImageProcessor(svc))
	block.RegisterProcessor(NewReferenceProcessor(svc))

	kind, _, _, ok := block.FirstPasteMatch([]block.ContentEntry{dropped("application/pdf", "spec.pdf", "%PDF-1.4")})
	if !ok || kind != "reference" {
		t.Errorf("a dropped pdf matched %q (ok=%v), want reference", kind, ok)
	}
}
