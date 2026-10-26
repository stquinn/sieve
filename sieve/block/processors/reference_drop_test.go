package processors

import (
	"encoding/base64"
	"encoding/json"
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
	// The chip is labelled with what the USER dropped, which the key need not
	// spell exactly.
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

// A dropped file is stored under its own sanitised name, so the document
// directory, exports and the AI's File tag show what the user dropped. The
// extension survives because the mime sniff reads it: magic bytes cannot tell
// YAML from any other text.
func TestReferenceProcessor_Transform_storedAssetIsNamedAfterTheDrop(t *testing.T) {
	ds, fs := newTestDocumentService(t)
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("new document: %v", err)
	}
	p := NewReferenceProcessor(block.BlockServices{Documents: ds, Assets: services.NewAssetService(fs, "")})

	for _, want := range []string{"swagger.yml", "swagger-2.yml"} {
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
		if addr.Leaf != want {
			t.Errorf("stored asset = %q, want %q", addr.Leaf, want)
		}
	}
}

// keyFor's naming policy, end to end through a real store: each case mints its
// owned names into a fresh document, then mints name and checks the key the
// store reports. Text bytes sniff to .txt, which is what an extensionless key
// gains. "{doc}" stands for the document's uuid and "{uuid}" for any fresh one.
func TestDocumentAssets_mintKeyPolicy(t *testing.T) {
	cases := []struct {
		name  string
		owned []string
		mint  string
		want  string
	}{
		{name: "a plain name is kept", mint: "holiday.png", want: "holiday.png"},
		{name: "a taken name is uniquified", owned: []string{"holiday.png"}, mint: "holiday.png", want: "holiday-2.png"},
		{name: "uniquifying ignores case and the extension is lowercased",
			owned: []string{"holiday.png", "holiday-2.png"}, mint: "Holiday.PNG", want: "Holiday-3.png"},
		{name: "path components are dropped", mint: "../../etc/passwd", want: "passwd.txt"},
		{name: "a Windows path is dropped too", mint: `C:\Users\me\My Report (final).pdf`, want: "My-Report-final.pdf"},
		{name: "leading dots are dropped", mint: ".bashrc", want: "bashrc.txt"},
		{name: "a trailing dot is no extension", mint: "notes.", want: "notes.txt"},
		{name: "a non-alphanumeric suffix stays in the stem", mint: "report.v2-final", want: "report.v2-final"},
		{name: "the stem is capped", mint: strings.Repeat("a", 100) + ".png", want: strings.Repeat("a", assetStemMax) + ".png"},
		{name: "an extensionless name collides with an owned stem", owned: []string{"README"}, mint: "README", want: "README-2.txt"},
		{name: "the content file is reserved", mint: "{doc}.md", want: "{doc}-2.md"},
		{name: "the content file's temporary is reserved", mint: "{doc}.md.tmp", want: "{doc}.md-2.tmp"},
		{name: "letters of any script are kept", mint: "日本語.pdf", want: "日本語.pdf"},
		{name: "accented letters are kept and spaces collapse", mint: "café résumé.PNG", want: "café-résumé.png"},
		{name: "a decomposed accent stays with its letter", mint: "cafe\u0301.png", want: "cafe\u0301.png"},
		{name: "a leading combining mark is dropped", mint: "\u0301x.png", want: "x.png"},
		{name: "the stem cap never splits a rune", mint: "a" + strings.Repeat("é", assetStemMax) + ".png", want: "a" + strings.Repeat("é", assetStemMax/2-1) + ".png"},
		{name: "nothing usable falls back to a uuid", mint: "???.pdf", want: "{uuid}.pdf"},
		{name: "no name falls back to a uuid", mint: "", want: "{uuid}.txt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ds, fs := newTestDocumentService(t)
			doc, err := ds.New()
			if err != nil {
				t.Fatalf("new document: %v", err)
			}
			a := documentAssets{svc: block.BlockServices{Documents: ds, Assets: services.NewAssetService(fs, "")}, kind: "test"}
			for _, o := range tc.owned {
				if _, err := a.mint(doc.UUID(), o, []byte("hello")); err != nil {
					t.Fatalf("seed %s: %v", o, err)
				}
			}
			ref, err := a.mint(doc.UUID(), strings.ReplaceAll(tc.mint, "{doc}", doc.UUID()), []byte("hello"))
			if err != nil {
				t.Fatalf("mint: %v", err)
			}
			addr, err := domain.ParseAddress(ref)
			if err != nil || addr.Container != doc.UUID() {
				t.Fatalf("mint = %q, want the absolute address of an asset of %s (%v)", ref, doc.UUID(), err)
			}
			got := addr.Leaf
			if stem, ok := strings.CutPrefix(tc.want, "{uuid}"); ok {
				if !strings.HasSuffix(got, stem) || !ident.Valid(strings.TrimSuffix(got, stem)) {
					t.Errorf("key = %q, want a uuid followed by %q", got, stem)
				}
				return
			}
			if want := strings.ReplaceAll(tc.want, "{doc}", doc.UUID()); got != want {
				t.Errorf("key = %q, want %q", got, want)
			}
		})
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

// A dropped image, or a placed image address, resolves to smart-image regardless
// of which of the two kinds is registered first, because reference refuses images
// outright. Both orders are asserted, so the guarantee cannot become
// order-dependent.
func TestPasteMatch_anImageNeverReachesReference(t *testing.T) {
	svc := block.BlockServices{}
	images := []struct {
		name    string
		entries []block.ContentEntry
		action  block.Action
	}{
		{"dropped", []block.ContentEntry{dropped("image/png", "shot.png", "\x89PNG\r\n\x1a\n")}, block.ActionPaste},
		{"placed address", []block.ContentEntry{{MIMEType: "text/uri-list", Content: "sieve://" + ident.New() + "/shot.png"}}, block.ActionPlace},
	}
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
			for _, image := range images {
				kind, _, _, ok := block.FirstPasteMatch(image.entries, image.action)
				if !ok || kind != "smart-image" {
					t.Errorf("%s image matched %q (ok=%v), want smart-image", image.name, kind, ok)
				}
			}
		})
	}
}

// The other half of the same property: a dropped or placed NON-image is nobody
// else's, so reference gets it with both kinds registered as production registers
// them. A pasted file address is nobody's: it stays text.
func TestPasteMatch_aNonImageBecomesAReference(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)
	svc := block.BlockServices{}
	block.RegisterProcessor(NewSmartImageProcessor(svc))
	block.RegisterProcessor(NewReferenceProcessor(svc))

	address := []block.ContentEntry{{MIMEType: "text/uri-list", Content: "sieve://" + ident.New() + "/spec.pdf"}}
	for _, tc := range []struct {
		name    string
		entries []block.ContentEntry
		action  block.Action
		want    string
	}{
		{"dropped pdf", []block.ContentEntry{dropped("application/pdf", "spec.pdf", "%PDF-1.4")}, block.ActionPaste, "reference"},
		{"placed pdf address", address, block.ActionPlace, "reference"},
		{"pasted pdf address", address, block.ActionPaste, ""},
	} {
		if kind, _, _, _ := block.FirstPasteMatch(tc.entries, tc.action); kind != tc.want {
			t.Errorf("%s matched %q, want %q", tc.name, kind, tc.want)
		}
	}
}

// A pasted reference is additive: a held file is copied into the target document
// under its face's title, uniquified there, so no two blocks share an asset, while a pointer is
// copied by reference with its uri unchanged. A held copy that cannot be made
// creates no block rather than one reading the source's bytes.
//
// A placed reference shares instead: within its own document the new block names
// the same file and no bytes are written; across documents it copies as a paste
// does. A placed address of a document's own file is adopted the same way, its
// face built from the stored bytes; a pasted one is not.
func TestReferenceProcessor_Transform_copiedOrPlacedReference(t *testing.T) {
	const body = "openapi: 3.0.0\ninfo:\n  title: Payments API\n"
	ownedKeys := func(t *testing.T, ds *services.DocumentService, uuid string) []string {
		t.Helper()
		doc, err := ds.LoadByUUID(uuid)
		if err != nil {
			t.Fatalf("load %s: %v", uuid, err)
		}
		var keys []string
		for _, a := range doc.Storable().Owns() {
			keys = append(keys, a.Key())
		}
		return keys
	}
	cases := []struct {
		name string
		// pointer copies a link to a note instead of a held file.
		pointer bool
		// sameDoc pastes into the source document.
		sameDoc bool
		// breakSource points the copied uri at a key that does not exist.
		breakSource bool
		// ceiling, when set, lowers max_attachment_bytes below the file's size.
		ceiling int
		// place builds under ActionPlace instead of ActionPaste.
		place bool
		// address sends the held file's address as text instead of the block's view.
		address bool
		// wantShared expects the new block to name the source's own file.
		wantShared bool
		wantNil    bool
	}{
		{name: "held, across documents"},
		{name: "held, within one document", sameDoc: true},
		{name: "pointer is copied by reference", pointer: true},
		{name: "source asset missing", breakSource: true, wantNil: true},
		{name: "over the size limit", ceiling: 8, wantNil: true},
		{name: "placed within one document shares the file", place: true, sameDoc: true, wantShared: true},
		{name: "placed across documents copies", place: true},
		{name: "placed pointer is copied by reference", place: true, pointer: true},
		{name: "placed, source asset missing", place: true, sameDoc: true, breakSource: true, wantNil: true},
		{name: "placed, over the size limit", place: true, sameDoc: true, ceiling: 8, wantNil: true},
		{name: "placed address is adopted", place: true, address: true, sameDoc: true, wantShared: true},
		{name: "placed address of another document", place: true, address: true, wantNil: true},
		{name: "placed address, asset missing", place: true, address: true, sameDoc: true, breakSource: true, wantNil: true},
		{name: "placed address, over the size limit", place: true, address: true, sameDoc: true, ceiling: 8, wantNil: true},
		{name: "pasted address stays text", address: true, sameDoc: true, wantNil: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ds, fs := newTestDocumentService(t)
			assets := services.NewAssetService(fs, "")
			svc := block.BlockServices{Documents: ds, Assets: assets}
			src, err := ds.New()
			if err != nil {
				t.Fatalf("new document: %v", err)
			}
			dst, err := ds.New()
			if err != nil {
				t.Fatalf("new document: %v", err)
			}
			held := NewReferenceProcessor(svc)
			srcBlock := ident.New()
			made := held.Transform([]block.ContentEntry{dropped("text/yaml", "swagger.yml", body)},
				src.UUID(), srcBlock, block.ActionPaste)
			if made == nil {
				t.Fatal("seed drop declined")
			}
			attrs := made
			if tc.pointer {
				attrs = map[string]interface{}{
					"uri":   "sieve://" + src.UUID(),
					"cache": map[string]interface{}{"title": "Notes", "mime": "sieve/note"},
				}
			}
			srcAddr, _ := domain.ParseAddress(made["uri"].(string))
			if tc.breakSource {
				attrs["uri"] = domain.NewLeafAddress(src.UUID(), "gone.yml").String()
			}
			if tc.ceiling > 0 {
				settings := domain.DefaultSettings()
				settings.MaxAttachmentBytes = tc.ceiling
				svc.State = fakeState{settings: settings}
			}
			p := NewReferenceProcessor(svc)
			wantUUID := dst.UUID()
			if tc.sameDoc {
				wantUUID = src.UUID()
			}
			beforeSrc, beforeDst := ownedKeys(t, ds, src.UUID()), ownedKeys(t, ds, dst.UUID())
			beforeTarget := beforeDst
			if tc.sameDoc {
				beforeTarget = beforeSrc
			}

			payload, _ := json.Marshal(attrs)
			entry := block.ContentEntry{MIMEType: "sieve/reference", Content: string(payload),
				Context: map[string]interface{}{"container": src.UUID()}}
			if tc.address {
				entry = block.ContentEntry{MIMEType: "text/uri-list", Content: attrs["uri"].(string)}
			}
			action := block.ActionPaste
			if tc.place {
				action = block.ActionPlace
			}
			got := p.Transform([]block.ContentEntry{entry}, wantUUID, ident.New(), action)

			if tc.wantNil {
				if got != nil {
					t.Fatalf("Transform = %v, want nil — a block must never point at the source", got)
				}
				if n := len(ownedKeys(t, ds, wantUUID)); n != len(beforeTarget) {
					t.Errorf("a refused copy wrote an asset: %d owned", n)
				}
				return
			}
			if got == nil {
				t.Fatal("Transform declined a copied reference")
			}
			if tc.wantShared {
				if got["uri"] != made["uri"] {
					t.Errorf("uri = %v, want the source's own file %v", got["uri"], made["uri"])
				}
				if n := len(ownedKeys(t, ds, src.UUID())); n != len(beforeSrc) {
					t.Errorf("a shared placement wrote an asset: %d owned, had %d", n, len(beforeSrc))
				}
				face := refFace(t, got)
				if face["title"] != "swagger.yml" || face["mime"] != "text/yaml" ||
					face["bytes"] != strconv.Itoa(len(body)) || face["summary"] != "openapi: 3.0.0" {
					t.Errorf("face = %v, want the file's own", face)
				}
				return
			}
			if tc.sameDoc && len(ownedKeys(t, ds, src.UUID())) != len(beforeSrc)+1 {
				t.Error("a same-document copy must add a second asset")
			}
			if tc.pointer {
				if got["uri"] != attrs["uri"] {
					t.Errorf("uri = %v, want the pointer unchanged (%v)", got["uri"], attrs["uri"])
				}
				if n := len(ownedKeys(t, ds, dst.UUID())); n != len(beforeDst) {
					t.Errorf("a pointer copy wrote an asset: %d owned, had %d", n, len(beforeDst))
				}
				return
			}
			addr, err := domain.ParseAddress(got["uri"].(string))
			if err != nil {
				t.Fatalf("uri %v: %v", got["uri"], err)
			}
			if addr.Container != wantUUID {
				t.Errorf("uri container = %s, want the target %s", addr.Container, wantUUID)
			}
			want := "swagger.yml"
			if tc.sameDoc {
				want = "swagger-2.yml"
			}
			if addr.Leaf != want {
				t.Errorf("uri leaf = %s, want %s", addr.Leaf, want)
			}
			if data, err := assets.ServeAssetData(wantUUID, addr.Leaf); err != nil || string(data) != body {
				t.Errorf("copied bytes = %q, %v; want the source's", data, err)
			}
			if data, err := assets.ServeAssetData(src.UUID(), srcAddr.Leaf); err != nil || string(data) != body {
				t.Errorf("source asset = %q, %v; want it untouched", data, err)
			}
			if face := refFace(t, got); face["title"] != "swagger.yml" || face["mime"] != "text/yaml" {
				t.Errorf("face = %v, want it carried over", face)
			}
			if !tc.sameDoc && len(ownedKeys(t, ds, src.UUID())) != len(beforeSrc) {
				t.Error("the source document gained an asset")
			}
		})
	}
}
