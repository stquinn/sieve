package processors

import (
	"context"
	"encoding/base64"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"sieve/ident"
	"sieve/sieve/block"
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
func TestAttachmentProcessor_IsSupportedContent_claimsADroppedFile(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
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

// Transform is where a drop becomes a block: the bytes land in the document
// directory and the block is created with src already set, exactly as
// smart-image's paste does. The ingest job then stamps mime/bytes/summary off the
// saved file — nothing here anticipates it.
func TestAttachmentProcessor_Transform_savesADroppedFile(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("new document: %v", err)
	}
	assets := services.NewAssetService(fs, "")
	p := NewAttachmentProcessor(block.BlockServices{Documents: ds, Assets: assets})

	body := "openapi: 3.0.0\ninfo:\n  title: Payments API\n"
	overrides := p.Transform(
		[]block.ContentEntry{dropped("text/yaml", "swagger.yml", body)},
		doc.UUID(), ident.New(), block.ActionPaste)

	if overrides == nil {
		t.Fatal("Transform declined a dropped file")
	}
	src, _ := overrides["src"].(string)
	if src == "" {
		t.Fatal("a held attachment must be created with src set")
	}
	if overrides["uri"] != nil {
		t.Errorf("a holding attachment must not seed uri; got %v", overrides["uri"])
	}
	// The chip is labelled with what the USER dropped. The stored asset is named
	// after the block, so without this the chip would wear a UUID.
	if overrides["title"] != "swagger.yml" {
		t.Errorf("title: got %v, want the original filename swagger.yml", overrides["title"])
	}
	// The bytes must be readable back by the SAME filename the ingest job derives
	// from src — the two halves of the drop path have to agree or the block errors.
	got, err := assets.ServeAssetData(doc.UUID(), p.assets.filename(src))
	if err != nil {
		t.Fatalf("saved asset is not readable back as %q: %v", p.assets.filename(src), err)
	}
	if string(got) != body {
		t.Errorf("stored bytes = %q, want the dropped file's contents", got)
	}
}

// The stored filename keeps the dropped file's EXTENSION, because the ingest job
// sniffs mime from it (mimeByExtension) and the store's own fallback is magic
// bytes, which cannot tell YAML from any other text. Lose the extension here and
// a swagger spec's chip reads "txt".
func TestAttachmentProcessor_Transform_storedAssetKeepsTheExtension(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("new document: %v", err)
	}
	p := NewAttachmentProcessor(block.BlockServices{Documents: ds, Assets: services.NewAssetService(fs, "")})

	overrides := p.Transform(
		[]block.ContentEntry{dropped("text/yaml", "swagger.yml", "openapi: 3.0.0")},
		doc.UUID(), ident.New(), block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform declined a dropped file")
	}
	src, _ := overrides["src"].(string)
	if ext := filepath.Ext(p.assets.filename(src)); ext != ".yml" {
		t.Errorf("stored asset %q has extension %q, want .yml", p.assets.filename(src), ext)
	}
	// …and the asset is named after the BLOCK, never after the dropped file: a
	// document directory holds meta.json and content.md, and a drop free to name
	// its own file could overwrite either.
	if p.assets.filename(src) == "swagger.yml" {
		t.Error("the stored asset must not be named after the dropped file — it would clobber the document's own files")
	}
}

// The two halves of the drop path meet HERE, and this is the seam that breaks
// silently: Transform names the file on disk and the ingest job reads it back and
// describes it. Nothing between them is negotiated, so they are exercised together
// — a chip that says "yaml · 42 B" is the whole feature working.
func TestAttachmentProcessor_droppedFileIsDescribedByItsIngestJob(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("new document: %v", err)
	}
	p := NewAttachmentProcessor(block.BlockServices{Documents: ds, Assets: services.NewAssetService(fs, "")})

	body := "openapi: 3.0.0\ninfo:\n  title: Payments API\n"
	blockID := ident.New()
	overrides := p.Transform(
		[]block.ContentEntry{dropped("text/yaml", "swagger.yml", body)},
		doc.UUID(), blockID, block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform declined a dropped file")
	}

	blk := &block.SieveBlock{ID: blockID, Kind: "attachment", Attrs: p.InitAttrs(blockID, overrides)}
	if blk.Attrs["status"] != block.BlockStatusPending {
		t.Fatalf("a held attachment must be born PENDING; got %v", blk.Attrs["status"])
	}
	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: doc.UUID(), Block: blk})
	if job == nil {
		t.Fatal("a dropped file must produce an ingest job")
	}
	res, err := job.Work()
	if err != nil {
		t.Fatalf("ingest Work: %v", err)
	}
	job.Apply(res, blk)

	if blk.Attrs["mime"] != "text/yaml" {
		t.Errorf("mime: got %v, want text/yaml — the stored asset lost its extension", blk.Attrs["mime"])
	}
	if blk.Attrs["targetKind"] != "yaml" {
		t.Errorf("targetKind: got %v, want yaml", blk.Attrs["targetKind"])
	}
	if got, want := blk.Attrs["bytes"], strconv.Itoa(len(body)); got != want {
		t.Errorf("bytes: got %v, want %q", got, want)
	}
	// The title the drop set SURVIVES the job: the job only names a file that has
	// none, and the stored asset's name is a UUID.
	if blk.Attrs["title"] != "swagger.yml" {
		t.Errorf("title: got %v, want the dropped filename", blk.Attrs["title"])
	}
	if s, _ := blk.Attrs["summary"].(string); !strings.Contains(s, "openapi: 3.0.0") {
		t.Errorf("summary must excerpt the file; got %q", s)
	}
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", blk.Attrs["status"])
	}
}

func TestAttachmentProcessor_Transform_declinesADroppedImage(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	if o := p.Transform([]block.ContentEntry{dropped("image/png", "shot.png", "\x89PNG")}, "u", "at-1", block.ActionPaste); o != nil {
		t.Errorf("Transform must decline a dropped image; got %v", o)
	}
}

// A drop that cannot be stored must produce NO BLOCK rather than an empty one: a
// srcless attachment is born COMPLETE (InitAttrs' own guard), so it would sit in
// the document as a permanently blank chip nothing ever fills in.
func TestAttachmentProcessor_Transform_declinesWhenTheAssetCannotBeSaved(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	if o := p.Transform([]block.ContentEntry{dropped("text/yaml", "swagger.yml", "openapi: 3.0.0")}, "u", "at-1", block.ActionPaste); o != nil {
		t.Errorf("Transform must decline when there is no asset service to save through; got %v", o)
	}
}

// The backstop half of the size ceiling. The frontend refuses an over-limit file
// before it reads it and SAYS SO; this exists because a server must not trust a
// client, so it refuses the same file and writes nothing to disk.
func TestAttachmentProcessor_Transform_refusesAFileOverTheSizeLimit(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("new document: %v", err)
	}
	p := NewAttachmentProcessor(block.BlockServices{Documents: ds, Assets: services.NewAssetService(fs, "")})

	over := dropped("application/pdf", "huge.pdf", strings.Repeat("x", MaxAttachmentBytes+1))
	if o := p.Transform([]block.ContentEntry{over}, doc.UUID(), ident.New(), block.ActionPaste); o != nil {
		t.Errorf("Transform must refuse a file over MaxAttachmentBytes; got %v", o)
	}

	// …and the boundary itself is INSIDE the limit, so a file at exactly the
	// ceiling still attaches.
	at := dropped("application/pdf", "big.pdf", strings.Repeat("x", MaxAttachmentBytes))
	if o := p.Transform([]block.ContentEntry{at}, doc.UUID(), ident.New(), block.ActionPaste); o == nil {
		t.Error("a file of exactly MaxAttachmentBytes must still attach")
	}
}

// smart-image is registered BEFORE attachment (service_provider.go) and first
// match wins — but this pins something STRONGER than that ordering, because an
// ordering is one careless line-move away from reversing. attachment refuses
// images outright, so a dropped image resolves to smart-image regardless of which
// of the two is registered first. Both orders are asserted so the guarantee
// cannot quietly become order-dependent again.
func TestPasteMatch_aDroppedImageNeverReachesAttachment(t *testing.T) {
	svc := block.BlockServices{}
	image := []block.ContentEntry{dropped("image/png", "shot.png", "\x89PNG\r\n\x1a\n")}
	orders := map[string][]block.BlockProcessor{
		"production order (smart-image first)": {NewSmartImageProcessor(svc), NewAttachmentProcessor(svc)},
		"reversed":                             {NewAttachmentProcessor(svc), NewSmartImageProcessor(svc)},
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
// attachment gets it with both kinds registered as production registers them.
func TestPasteMatch_aDroppedNonImageBecomesAnAttachment(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)
	svc := block.BlockServices{}
	block.RegisterProcessor(NewSmartImageProcessor(svc))
	block.RegisterProcessor(NewAttachmentProcessor(svc))

	kind, _, _, ok := block.FirstPasteMatch([]block.ContentEntry{dropped("application/pdf", "spec.pdf", "%PDF-1.4")})
	if !ok || kind != "attachment" {
		t.Errorf("a dropped pdf matched %q (ok=%v), want attachment", kind, ok)
	}
}
