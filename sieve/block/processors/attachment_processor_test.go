package processors

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/store"
)

// fakeNodes stands in for editor.Router. The port is one method, so the whole
// resolver is a map plus the two refusals the contract names.
type fakeNodes struct {
	nodes map[string]domain.NodeDescriptor
	err   error
}

func (f fakeNodes) Resolve(uri string) (domain.NodeDescriptor, error) {
	if f.err != nil {
		return domain.NodeDescriptor{}, f.err
	}
	n, ok := f.nodes[uri]
	if !ok {
		return domain.NodeDescriptor{}, domain.ErrNodeNotFound
	}
	return n, nil
}

// fakeAssets stands in for AssetService. Only the read half is exercised — the
// attachment kind never writes an asset (the drop path saves it before the block
// is created, exactly as smart-image's does).
type fakeAssets struct {
	files map[string][]byte
}

func (f fakeAssets) Save(store.Category, string, string, []byte) (*domain.ImageAsset, error) {
	return nil, errors.New("fakeAssets: Save is not part of this kind's job")
}

func (f fakeAssets) ServeAssetData(docUUID, filename string) ([]byte, error) {
	if b, ok := f.files[docUUID+"/"+filename]; ok {
		return b, nil
	}
	return nil, fmt.Errorf("asset not found: %s/%s", docUUID, filename)
}

func TestAttachmentProcessor_InitAttrs_defaults(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	attrs := p.InitAttrs("at-0001", nil)

	if attrs["id"] != "at-0001" {
		t.Errorf("id: got %v, want at-0001", attrs["id"])
	}
	// Neither address attr ⇒ no job ⇒ born COMPLETE (mirrors DescribeJob==nil).
	if attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE for an addressless block", attrs["status"])
	}
	for _, field := range []string{
		"src", "uri", "title", "targetKind", "summary", "bytes", "mime",
		"status", "error", "createdAt", "completedAt", "supportsEmbedding",
	} {
		if _, ok := attrs[field]; !ok {
			t.Errorf("InitAttrs must declare field %q", field)
		}
	}
	if attrs["createdAt"] == "" || attrs["createdAt"] == nil {
		t.Error("createdAt must be set")
	}
}

func TestAttachmentProcessor_InitAttrs_idNotOverridable(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	attrs := p.InitAttrs("at-0002", map[string]interface{}{"id": "injected"})
	if attrs["id"] != "at-0002" {
		t.Error("id must not be overridable")
	}
}

// The complete-vs-pending predicate is the ONE discriminator, and it must hold
// for both halves of the kind: an address of either shape means work to do.
func TestAttachmentProcessor_InitAttrs_addressMeansPending(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	for _, tc := range []struct {
		name     string
		override map[string]interface{}
	}{
		{"holds a file", map[string]interface{}{"src": "swagger.yml"}},
		{"points at a container", map[string]interface{}{"uri": "container:" + ident.New()}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			attrs := p.InitAttrs(ident.New(), tc.override)
			if attrs["status"] != block.BlockStatusPending {
				t.Errorf("status: got %v, want PENDING", attrs["status"])
			}
		})
	}
}

// A copied attachment pastes its whole cached face, status included. The
// predicate must overrule it: a COMPLETE block carrying an address would describe
// a job nothing dispatches, and a live reference should re-resolve anyway.
func TestAttachmentProcessor_InitAttrs_pastedFaceIsReArmed(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	attrs := p.InitAttrs(ident.New(), map[string]interface{}{
		"uri":         "container:" + ident.New(),
		"title":       "Auth Design",
		"status":      block.BlockStatusComplete,
		"completedAt": "2026-08-19T00:00:00Z",
	})
	if attrs["status"] != block.BlockStatusPending {
		t.Errorf("status: got %v, want PENDING — an address always means work to do", attrs["status"])
	}
	if attrs["title"] != "Auth Design" {
		t.Errorf("the cached face still seeds the block; got %v", attrs["title"])
	}
}

func TestAttachmentProcessor_Mode(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	if p.Mode() != block.BlockModeBlock {
		t.Errorf("Mode: got %v, want block", p.Mode())
	}
}

// A pasted coordinate is claimed as a TRANSFORM, mirroring how web-clip claims a
// pasted link. Recognition goes through domain.ParseAddress — never a prefix test
// — so only the forms the grammar actually produces are claimed, and only the
// container scheme, which is all the resolver answers for.
func TestAttachmentProcessor_IsSupportedContent(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	uuid := ident.New()
	cases := []struct {
		name    string
		entries []block.ContentEntry
		want    []block.Action
	}{
		{
			name:    "container coordinate",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "container:" + uuid}},
			want:    []block.Action{block.ActionTransform},
		},
		{
			name:    "surrounding whitespace does not disqualify it",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "  container:" + uuid + "\n"}},
			want:    []block.Action{block.ActionTransform},
		},
		{
			name:    "block coordinate: legal grammar the resolver does not answer for",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "block:" + uuid}},
			want:    nil,
		},
		{
			name:    "container scheme with a non-uuid segment is not a coordinate",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "container:auth-design"}},
			want:    nil,
		},
		{
			name:    "an ordinary link belongs to smart-card",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "https://example.com"}},
			want:    nil,
		},
		{
			name:    "plain prose",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "no coordinate here"}},
			want:    nil,
		},
		{
			name:    "copied attachment round-trips",
			entries: []block.ContentEntry{{MIMEType: "sieve/attachment", Content: `{"uri":"container:` + uuid + `"}`}},
			want:    []block.Action{block.ActionPaste, block.ActionExtract},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := p.IsSupportedContent(tc.entries)
			for _, a := range []block.Action{block.ActionPaste, block.ActionExtract, block.ActionTransform} {
				want := false
				for _, w := range tc.want {
					want = want || w == a
				}
				if got.Has(a) != want {
					t.Errorf("action %q: got %v, want %v (offer %+v)", a, got.Has(a), want, got.Actions)
				}
			}
		})
	}
}

// Transform stores the CANONICAL spelling of the address, not the pasted string:
// the parse is the only reader of the grammar, so a stray newline never becomes
// half of an attr that later fails to resolve.
func TestAttachmentProcessor_Transform_canonicalisesTheCoordinate(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	uuid := ident.New()
	overrides := p.Transform(
		[]block.ContentEntry{{MIMEType: "text/plain", Content: " container:" + uuid + " \n"}},
		"doc-uuid", "at-1", block.ActionTransform)
	if overrides == nil {
		t.Fatal("Transform declined a container coordinate")
	}
	if overrides["uri"] != "container:"+uuid {
		t.Errorf("uri: got %v, want container:%s", overrides["uri"], uuid)
	}
	if overrides["src"] != nil {
		t.Errorf("a pointing attachment must not seed src; got %v", overrides["src"])
	}
}

func TestAttachmentProcessor_Transform_declinesNonCoordinates(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	if o := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: "https://example.com"}}, "u", "at-1", block.ActionTransform); o != nil {
		t.Errorf("Transform must decline a plain link; got %v", o)
	}
}

// ── DescribeJob: the one fork ─────────────────────────────────────────────────

func TestAttachmentProcessor_DescribeJob_noAddressNoJob(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{Nodes: fakeNodes{}, Assets: fakeAssets{}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "attachment", Attrs: map[string]interface{}{
		"src": "", "uri": "", "status": block.BlockStatusComplete,
	}}
	if job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "u", Block: blk}); job != nil {
		t.Errorf("an addressless attachment must return a nil job, got %+v", job)
	}
}

func TestAttachmentProcessor_DescribeJob_resolvesACoordinate(t *testing.T) {
	uuid := ident.New()
	uri := "container:" + uuid
	p := NewAttachmentProcessor(block.BlockServices{Nodes: fakeNodes{nodes: map[string]domain.NodeDescriptor{
		uri: {URI: uri, UUID: uuid, Kind: "note", Title: "Auth Design", Summary: "Token rotation and session binding"},
	}}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "attachment", Attrs: map[string]interface{}{
		"uri": uri, "status": block.BlockStatusPending,
	}}

	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "doc", Block: blk})
	if job == nil {
		t.Fatal("a uri must produce a resolve job")
	}
	if job.Category != block.CategoryDefault {
		t.Errorf("category: got %q, want %q — resolving is not AI work", job.Category, block.CategoryDefault)
	}
	if job.Label == "" {
		t.Error("a returned job MUST carry a non-empty label")
	}
	res, err := job.Work()
	if err != nil {
		t.Fatalf("Work: %v", err)
	}
	job.Apply(res, blk)

	if blk.Attrs["title"] != "Auth Design" {
		t.Errorf("title: got %v, want Auth Design", blk.Attrs["title"])
	}
	if blk.Attrs["targetKind"] != "note" {
		t.Errorf("kind: got %v, want note", blk.Attrs["targetKind"])
	}
	if blk.Attrs["summary"] != "Token rotation and session binding" {
		t.Errorf("summary: got %v", blk.Attrs["summary"])
	}
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", blk.Attrs["status"])
	}
	if blk.Attrs["completedAt"] == "" || blk.Attrs["completedAt"] == nil {
		t.Error("completedAt must be set on success")
	}
	if blk.Attrs["error"] != "" {
		t.Errorf("a resolved reference carries no error; got %v", blk.Attrs["error"])
	}
}

// A live reference REFRESHES its face on resolve — smart-card's behaviour, and
// deliberately not the composer chip's frozen title.
func TestAttachmentProcessor_DescribeJob_refreshesAStaleFace(t *testing.T) {
	uuid := ident.New()
	uri := "container:" + uuid
	p := NewAttachmentProcessor(block.BlockServices{Nodes: fakeNodes{nodes: map[string]domain.NodeDescriptor{
		uri: {URI: uri, UUID: uuid, Kind: "note", Title: "Renamed"},
	}}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "attachment", Attrs: map[string]interface{}{
		"uri": uri, "title": "Old Name", "status": block.BlockStatusPending,
	}}
	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "doc", Block: blk})
	res, err := job.Work()
	if err != nil {
		t.Fatalf("Work: %v", err)
	}
	job.Apply(res, blk)
	if blk.Attrs["title"] != "Renamed" {
		t.Errorf("title: got %v, want Renamed — the face refreshes on resolve", blk.Attrs["title"])
	}
}

// Dangling is a NORMAL state, not a job failure: the resolve completed and what
// it found was nothing. The block settles COMPLETE, keeps the cached face, and
// records the dangling fact in `error` — the pair the chip's --missing modifier
// reads. ERROR stays reserved for "the job broke".
func TestAttachmentProcessor_DescribeJob_danglingIsNotAFailure(t *testing.T) {
	uri := "container:" + ident.New()
	p := NewAttachmentProcessor(block.BlockServices{Nodes: fakeNodes{nodes: map[string]domain.NodeDescriptor{}}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "attachment", Attrs: map[string]interface{}{
		"uri": uri, "title": "Deleted Note", "targetKind": "note", "status": block.BlockStatusPending,
	}}
	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "doc", Block: blk})
	res, err := job.Work()
	if err != nil {
		t.Fatalf("a dangling address must not fail the job; got %v", err)
	}
	job.Apply(res, blk)

	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE for a dangling reference", blk.Attrs["status"])
	}
	if e, _ := blk.Attrs["error"].(string); e == "" {
		t.Error("a dangling reference must record why it is missing")
	}
	if blk.Attrs["title"] != "Deleted Note" {
		t.Errorf("the cached face survives a dangling resolve; got %v", blk.Attrs["title"])
	}
}

// Every OTHER refusal IS a failure: a malformed address will never resolve, and
// the framework's error path is what says so.
func TestAttachmentProcessor_DescribeJob_badAddressFailsTheJob(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{Nodes: fakeNodes{err: domain.ErrBadAddress}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "attachment", Attrs: map[string]interface{}{
		"uri": "container:not-a-uuid", "status": block.BlockStatusPending,
	}}
	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "doc", Block: blk})
	if _, err := job.Work(); !errors.Is(err, domain.ErrBadAddress) {
		t.Errorf("Work must surface a malformed address as a job error; got %v", err)
	}
}

func TestAttachmentProcessor_DescribeJob_readsAHeldTextAsset(t *testing.T) {
	body := "openapi: 3.0.0\ninfo:\n  title: Payments API\n"
	p := NewAttachmentProcessor(block.BlockServices{Assets: fakeAssets{files: map[string][]byte{
		"doc/swagger.yml": []byte(body),
	}}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "attachment", Attrs: map[string]interface{}{
		"src": "swagger.yml", "status": block.BlockStatusPending,
	}}

	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "doc", Block: blk})
	if job == nil {
		t.Fatal("a src must produce an ingest job")
	}
	if job.Category != block.CategoryDefault {
		t.Errorf("category: got %q, want %q — reading a local file is not AI work", job.Category, block.CategoryDefault)
	}
	res, err := job.Work()
	if err != nil {
		t.Fatalf("Work: %v", err)
	}
	job.Apply(res, blk)

	if blk.Attrs["mime"] != "text/yaml" {
		t.Errorf("mime: got %v, want text/yaml", blk.Attrs["mime"])
	}
	if blk.Attrs["targetKind"] != "yaml" {
		t.Errorf("kind: got %v, want yaml (the mime family)", blk.Attrs["targetKind"])
	}
	// bytes is a STRING: attrs round-trip through JSON on paste, and a number that
	// returns as a float64 serialises to YAML in exponent form.
	if got, want := blk.Attrs["bytes"], fmt.Sprint(len(body)); got != want {
		t.Errorf("bytes: got %v (%T), want the string %q", got, got, want)
	}
	if s, _ := blk.Attrs["summary"].(string); !strings.Contains(s, "openapi: 3.0.0") {
		t.Errorf("summary must excerpt the text; got %q", s)
	}
	if blk.Attrs["title"] != "swagger.yml" {
		t.Errorf("title: got %v, want the filename", blk.Attrs["title"])
	}
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", blk.Attrs["status"])
	}
}

// Binary text extraction (PDF, docx) is explicitly out of scope: the block still
// names the file and states its size, and the summary stays empty rather than
// carrying decoded rubbish.
func TestAttachmentProcessor_DescribeJob_binaryAssetGetsNoSummary(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{Assets: fakeAssets{files: map[string][]byte{
		"doc/spec.pdf": []byte("%PDF-1.7\n\x00\x01\x02binary rubbish"),
	}}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "attachment", Attrs: map[string]interface{}{
		"src": "spec.pdf", "status": block.BlockStatusPending,
	}}
	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "doc", Block: blk})
	res, err := job.Work()
	if err != nil {
		t.Fatalf("Work: %v", err)
	}
	job.Apply(res, blk)

	if blk.Attrs["mime"] != "application/pdf" {
		t.Errorf("mime: got %v, want application/pdf", blk.Attrs["mime"])
	}
	if blk.Attrs["targetKind"] != "pdf" {
		t.Errorf("kind: got %v, want pdf", blk.Attrs["targetKind"])
	}
	if s, _ := blk.Attrs["summary"].(string); s != "" {
		t.Errorf("a binary asset carries no summary; got %q", s)
	}
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", blk.Attrs["status"])
	}
}

// An unreadable asset IS a job failure — unlike a dangling coordinate, the bytes
// were supposed to be there.
func TestAttachmentProcessor_DescribeJob_missingAssetFailsTheJob(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{Assets: fakeAssets{files: map[string][]byte{}}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "attachment", Attrs: map[string]interface{}{
		"src": "gone.yml", "status": block.BlockStatusPending,
	}}
	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "doc", Block: blk})
	if _, err := job.Work(); err == nil {
		t.Error("an unreadable asset must fail the job")
	}
}

// ── BuildContext ──────────────────────────────────────────────────────────────

// A held asset is named by its BARE FILENAME because the CLI's cwd is the
// document directory, and it is addressed by the block's OWN coordinate — the
// block IS the addressable thing, exactly as smart-image is.
func TestAttachmentProcessor_BuildContext_heldFile(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	docUUID := ident.New()
	blk := block.SieveBlock{ID: "at-1", Kind: "attachment", Attrs: map[string]interface{}{
		"src": "swagger.yml", "targetKind": "yaml", "bytes": "421888",
		"summary": "openapi: 3.0.0",
	}}
	ctx := p.BuildContext(blk, block.DocView{UUID: docUUID}, map[string]bool{})
	if ctx.IsEmpty() {
		t.Fatal("a held file must contribute context")
	}
	got := ctx.String()
	for _, want := range []string{
		"Attachment: swagger.yml",
		"block:" + docUUID + "/at-1",
		"412 KB",
		"openapi: 3.0.0",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("context must state %q; got:\n%s", want, got)
		}
	}
}

func TestAttachmentProcessor_BuildContext_citation(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	uri := "container:" + ident.New()
	blk := block.SieveBlock{ID: "at-1", Kind: "attachment", Attrs: map[string]interface{}{
		"uri": uri, "title": "Auth Design", "targetKind": "note",
		"summary": "Token rotation and session binding",
	}}
	ctx := p.BuildContext(blk, block.DocView{UUID: ident.New()}, map[string]bool{})
	got := ctx.String()
	for _, want := range []string{
		"Attachment: Auth Design (note)",
		uri,
		"Token rotation and session binding",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("context must state %q; got:\n%s", want, got)
		}
	}
	// The citation's address is the TARGET's, never the block's own.
	if strings.Contains(got, "block:") {
		t.Errorf("a citation states the coordinate it points at, not its own; got:\n%s", got)
	}
}

func TestAttachmentProcessor_BuildContext_addresslessIsEmpty(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	blk := block.SieveBlock{ID: "at-1", Kind: "attachment", Attrs: map[string]interface{}{}}
	if !p.BuildContext(blk, block.DocView{UUID: ident.New()}, map[string]bool{}).IsEmpty() {
		t.Error("an addressless attachment contributes nothing")
	}
}

func TestAttachmentProcessor_MarkdownRepresentation(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	uri := "container:" + ident.New()
	cases := []struct {
		name  string
		attrs map[string]interface{}
		want  string
	}{
		{
			name:  "held file links to its served asset",
			attrs: map[string]interface{}{"src": "swagger.yml", "title": "swagger.yml"},
			want:  "[swagger.yml](/ui/assets/doc/swagger.yml)",
		},
		{
			name:  "held file with no title falls back to the filename",
			attrs: map[string]interface{}{"src": "swagger.yml"},
			want:  "[swagger.yml](/ui/assets/doc/swagger.yml)",
		},
		{
			name:  "citation links to its coordinate",
			attrs: map[string]interface{}{"uri": uri, "title": "Auth Design"},
			want:  "[Auth Design](" + uri + ")",
		},
		{
			name:  "addressless renders nothing",
			attrs: map[string]interface{}{},
			want:  "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			blk := block.SieveBlock{ID: "at-1", Kind: "attachment", Attrs: tc.attrs}
			if got := p.MarkdownRepresentation(blk, "doc"); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// The fenced round-trip is inherited whole from FencedSerializer/Deserializer —
// this asserts the kind is wired to them, not that YAML works.
func TestAttachmentProcessor_SerializeRoundTrip(t *testing.T) {
	p := NewAttachmentProcessor(block.BlockServices{})
	id := ident.New()
	blk := block.NewSieveBlock("attachment", id, map[string]interface{}{
		"uri": "container:" + ident.New(), "title": "Auth Design", "targetKind": "note",
	})
	md, err := p.Serialize(blk)
	if err != nil {
		t.Fatalf("Serialize: %v", err)
	}
	if !strings.HasPrefix(md, "```attachment") {
		t.Errorf("Serialize must emit the kind-tagged fence; got:\n%s", md)
	}
	region := block.Region{Kind: "attachment", Body: md, Raw: md}
	if !p.Accepts(region) {
		t.Fatalf("Accepts must claim its own fenced region: %+v", region)
	}
	back, err := p.Deserialize(region)
	if err != nil {
		t.Fatalf("Deserialize: %v", err)
	}
	if len(back) != 1 {
		t.Fatalf("Deserialize: got %d blocks, want 1", len(back))
	}
	if back[0].ID != id {
		t.Errorf("id: got %q, want %q", back[0].ID, id)
	}
	if back[0].Attrs["uri"] != blk.Attrs["uri"] {
		t.Errorf("uri: got %v, want %v", back[0].Attrs["uri"], blk.Attrs["uri"])
	}
}
