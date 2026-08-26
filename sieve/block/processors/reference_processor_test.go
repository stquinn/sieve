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

func (f fakeNodes) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	if f.err != nil {
		return domain.NodeDescriptor{}, f.err
	}
	n, ok := f.nodes[addr.String()]
	if !ok {
		return domain.NodeDescriptor{}, domain.ErrNodeNotFound
	}
	return n, nil
}

// fakeAssets stands in for AssetService. Only the read half is exercised — the
// reference kind never writes an asset through this port (the drop path saves it
// before the block is created, exactly as smart-image's does).
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

func TestReferenceProcessor_InitAttrs_defaults(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	attrs := p.InitAttrs("at-0001", nil)

	if attrs["id"] != "at-0001" {
		t.Errorf("id: got %v, want at-0001", attrs["id"])
	}
	// No address ⇒ no job ⇒ born COMPLETE (mirrors DescribeJob==nil).
	if attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE for an addressless block", attrs["status"])
	}
	for _, field := range []string{
		"uri", "rel", "title", "summary", "bytes", "mime",
		"status", "error", "createdAt", "completedAt", "supportsEmbedding",
	} {
		if _, ok := attrs[field]; !ok {
			t.Errorf("InitAttrs must declare field %q", field)
		}
	}
	// src is GONE: a held file's location is its uri like everything else's.
	if _, ok := attrs["src"]; ok {
		t.Error("a reference has ONE address attr; src must not exist")
	}
	// targetKind is GONE: it was mimeFamily(mime), stored a second time.
	if _, ok := attrs["targetKind"]; ok {
		t.Error("targetKind must not exist — the noun is derived from mime")
	}
	if attrs["createdAt"] == "" || attrs["createdAt"] == nil {
		t.Error("createdAt must be set")
	}
}

func TestReferenceProcessor_InitAttrs_idNotOverridable(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	attrs := p.InitAttrs("at-0002", map[string]interface{}{"id": "injected"})
	if attrs["id"] != "at-0002" {
		t.Error("id must not be overridable")
	}
}

// A bare coordinate is all a paste of an address carries, so there IS work to do
// and the block is born PENDING.
func TestReferenceProcessor_InitAttrs_unfacedAddressMeansPending(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	attrs := p.InitAttrs(ident.New(), map[string]interface{}{"uri": "sieve://" + ident.New()})
	if attrs["status"] != block.BlockStatusPending {
		t.Errorf("status: got %v, want PENDING", attrs["status"])
	}
}

// The gestures that already KNOW what they are naming — a drop, an accepted @
// mention — seed the face at mint, and a block whose face is filled has nothing
// to resolve. mime is what says so: every reference ends up carrying one.
func TestReferenceProcessor_InitAttrs_aSeededFaceIsBornComplete(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	for _, tc := range []struct {
		name     string
		override map[string]interface{}
	}{
		{"a mentioned note", map[string]interface{}{
			"uri": "sieve://" + ident.New(), "title": "Auth Design", "mime": "sieve/note",
		}},
		{"a dropped file", map[string]interface{}{
			"uri":   domain.NewLeafAddress(ident.New(), "swagger.yml").String(),
			"title": "swagger.yml", "mime": "text/yaml", "bytes": "42",
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			attrs := p.InitAttrs(ident.New(), tc.override)
			if attrs["status"] != block.BlockStatusComplete {
				t.Errorf("status: got %v, want COMPLETE — the face is already filled", attrs["status"])
			}
			// A COMPLETE block with no completedAt is self-contradictory on disk.
			if ts, _ := attrs["completedAt"].(string); ts == "" {
				t.Error("a born-COMPLETE block must be stamped with completedAt")
			}
		})
	}
}

// The face is filled ONCE and never re-armed: a copied reference pastes what it
// already knew rather than resolving afresh.
func TestReferenceProcessor_InitAttrs_pastedFaceIsNotReArmed(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	attrs := p.InitAttrs(ident.New(), map[string]interface{}{
		"uri":   "sieve://" + ident.New(),
		"title": "Auth Design",
		"mime":  "sieve/note",
	})
	if attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", attrs["status"])
	}
	if attrs["title"] != "Auth Design" {
		t.Errorf("the cached face still seeds the block; got %v", attrs["title"])
	}
}

func TestReferenceProcessor_Mode(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	if p.Mode() != block.BlockModeBlock {
		t.Errorf("Mode: got %v, want block", p.Mode())
	}
}

// A pasted coordinate is claimed as a TRANSFORM, mirroring how web-clip claims a
// pasted link. Recognition goes through domain.ParseAddress — never a prefix test
// — so only the forms the grammar actually produces are claimed, and only the
// container grain, which is all the picker offers.
func TestReferenceProcessor_IsSupportedContent(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	uuid := ident.New()
	cases := []struct {
		name    string
		entries []block.ContentEntry
		want    []block.Action
	}{
		{
			name:    "container coordinate",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "sieve://" + uuid}},
			want:    []block.Action{block.ActionTransform},
		},
		{
			name:    "surrounding whitespace does not disqualify it",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "  sieve://" + uuid + "\n"}},
			want:    []block.Action{block.ActionTransform},
		},
		{
			name:    "leaf coordinate: legal grammar the picker does not offer",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "sieve://" + uuid + "/" + ident.New()}},
			want:    nil,
		},
		{
			name:    "a non-uuid authority is not a coordinate",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "sieve://auth-design"}},
			want:    nil,
		},
		{
			// The reference kind is sieve-only, and a pasted link is web-clip's: claiming
			// it here would make which kind wins a matter of registration order.
			name:    "a pasted link belongs to web-clip",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "https://example.com"}},
			want:    nil,
		},
		{
			name:    "plain prose",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "no coordinate here"}},
			want:    nil,
		},
		{
			name:    "copied reference round-trips",
			entries: []block.ContentEntry{{MIMEType: "sieve/reference", Content: `{"uri":"sieve://` + uuid + `"}`}},
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
func TestReferenceProcessor_Transform_canonicalisesTheCoordinate(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	uuid := ident.New()
	overrides := p.Transform(
		[]block.ContentEntry{{MIMEType: "text/plain", Content: " sieve://" + uuid + " \n"}},
		"doc-uuid", "at-1", block.ActionTransform)
	if overrides == nil {
		t.Fatal("Transform declined a container coordinate")
	}
	if overrides["uri"] != "sieve://"+uuid {
		t.Errorf("uri: got %v, want sieve://%s", overrides["uri"], uuid)
	}
	// Nothing has read the target yet, so nothing may claim to know what it is.
	if overrides["mime"] != nil {
		t.Errorf("a bare coordinate seeds no face; got mime %v", overrides["mime"])
	}
}

func TestReferenceProcessor_Transform_declinesNonCoordinates(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	if o := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: "https://example.com"}}, "u", "at-1", block.ActionTransform); o != nil {
		t.Errorf("Transform must decline a plain link; got %v", o)
	}
}

// ── DescribeJob: one path, no scheme knowledge ───────────────────────────────

func TestReferenceProcessor_DescribeJob_noAddressNoJob(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{Nodes: fakeNodes{}, Assets: fakeAssets{}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "reference", Attrs: map[string]interface{}{
		"uri": "", "status": block.BlockStatusComplete,
	}}
	if job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "u", Block: blk}); job != nil {
		t.Errorf("an addressless reference must return a nil job, got %+v", job)
	}
}

// The describes-a-job predicate and the complete-vs-pending predicate are the
// same method, so a block born COMPLETE never describes work nothing dispatches.
func TestReferenceProcessor_DescribeJob_aFilledFaceDescribesNoJob(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{Nodes: fakeNodes{}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "reference", Attrs: p.InitAttrs("at-1", map[string]interface{}{
		"uri": "sieve://" + ident.New(), "title": "Auth Design", "mime": "sieve/note",
	})}
	if job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "u", Block: blk}); job != nil {
		t.Errorf("a block born COMPLETE must describe no job; got %+v", job)
	}
}

func TestReferenceProcessor_DescribeJob_resolvesACoordinate(t *testing.T) {
	uuid := ident.New()
	uri := "sieve://" + uuid
	p := NewReferenceProcessor(block.BlockServices{Nodes: fakeNodes{nodes: map[string]domain.NodeDescriptor{
		uri: {URI: uri, UUID: uuid, Kind: "note", Title: "Auth Design", Summary: "Token rotation and session binding"},
	}}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "reference", Attrs: map[string]interface{}{
		"uri": uri, "status": block.BlockStatusPending,
	}}

	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "doc", Block: blk})
	if job == nil {
		t.Fatal("an unfaced uri must produce a resolve job")
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
	// A pointer's mime names Sieve's own space: this block points at a note, it
	// does not hold one.
	if blk.Attrs["mime"] != "sieve/note" {
		t.Errorf("mime: got %v, want sieve/note", blk.Attrs["mime"])
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

// A uri that is not a Sieve coordinate DANGLES rather than failing: no retry can
// make it parse, so the block settles and says so on its own face instead of
// sitting in ERROR forever. The reference kind is sieve-only — an https uri here
// is a malformed reference, and web pages belong to web-clip.
func TestReferenceProcessor_DescribeJob_aNonCoordinateDangles(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{Nodes: fakeNodes{}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "reference", Attrs: map[string]interface{}{
		"uri": "https://example.com/spec", "title": "The Spec", "status": block.BlockStatusPending,
	}}
	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "doc", Block: blk})
	if job == nil {
		t.Fatal("an unfaced uri must produce a resolve job whatever it says")
	}
	res, err := job.Work()
	if err != nil {
		t.Fatalf("a malformed address must not fail the job; got %v", err)
	}
	job.Apply(res, blk)

	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", blk.Attrs["status"])
	}
	if e, _ := blk.Attrs["error"].(string); !strings.Contains(e, "not a Sieve coordinate") {
		t.Errorf("error must say the uri is not a coordinate; got %q", e)
	}
	if blk.Attrs["title"] != "The Spec" {
		t.Errorf("the cached face survives; got %v", blk.Attrs["title"])
	}
}

// Dangling is a NORMAL state, not a job failure: the resolve completed and what
// it found was nothing. The block settles COMPLETE, keeps the cached face, and
// records the dangling fact in `error` — the pair the chip's --missing modifier
// reads. ERROR stays reserved for "the job broke".
func TestReferenceProcessor_DescribeJob_danglingIsNotAFailure(t *testing.T) {
	uri := "sieve://" + ident.New()
	p := NewReferenceProcessor(block.BlockServices{Nodes: fakeNodes{nodes: map[string]domain.NodeDescriptor{}}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "reference", Attrs: map[string]interface{}{
		"uri": uri, "title": "Deleted Note", "status": block.BlockStatusPending,
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

// A resolver that BREAKS is a real job failure — an unreadable library may well
// answer on a retry, and the framework's error path is what says so. Only the two
// "nothing is there" cases dangle.
func TestReferenceProcessor_DescribeJob_aBrokenResolverFailsTheJob(t *testing.T) {
	boom := errors.New("library is unreadable")
	p := NewReferenceProcessor(block.BlockServices{Nodes: fakeNodes{err: boom}})
	blk := &block.SieveBlock{ID: "at-1", Kind: "reference", Attrs: map[string]interface{}{
		"uri": "sieve://" + ident.New(), "status": block.BlockStatusPending,
	}}
	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "doc", Block: blk})
	if _, err := job.Work(); !errors.Is(err, boom) {
		t.Errorf("Work must surface a broken resolver as a job error; got %v", err)
	}
}

// ── BuildContext ──────────────────────────────────────────────────────────────

// A held file is named by its BARE FILENAME because the CLI's cwd is the document
// directory, and it is addressed by the coordinate it already carries.
func TestReferenceProcessor_BuildContext_heldFile(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	docUUID := ident.New()
	uri := domain.NewLeafAddress(docUUID, "at-1.yml").String()
	blk := block.SieveBlock{ID: "at-1", Kind: "reference", Attrs: map[string]interface{}{
		"uri": uri, "mime": "text/yaml", "bytes": "421888",
		"summary": "openapi: 3.0.0",
	}}
	ctx := p.BuildContext(blk, block.DocView{UUID: docUUID}, map[string]bool{})
	if ctx.IsEmpty() {
		t.Fatal("a held file must contribute context")
	}
	got := ctx.String()
	for _, want := range []string{
		"Reference: at-1.yml",
		uri,
		"yaml · 412 KB",
		"openapi: 3.0.0",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("context must state %q; got:\n%s", want, got)
		}
	}
}

// A pointer contributes the SAME three facts — which is why holding and pointing
// are one kind. The noun comes off the one mime attr, not a second one.
func TestReferenceProcessor_BuildContext_pointer(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	uri := "sieve://" + ident.New()
	blk := block.SieveBlock{ID: "at-1", Kind: "reference", Attrs: map[string]interface{}{
		"uri": uri, "title": "Auth Design", "mime": "sieve/note",
		"summary": "Token rotation and session binding",
	}}
	got := p.BuildContext(blk, block.DocView{UUID: ident.New()}, map[string]bool{}).String()
	for _, want := range []string{
		"Reference: Auth Design",
		uri,
		"note",
		"Token rotation and session binding",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("context must state %q; got:\n%s", want, got)
		}
	}
}

func TestReferenceProcessor_BuildContext_addresslessIsEmpty(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	blk := block.SieveBlock{ID: "at-1", Kind: "reference", Attrs: map[string]interface{}{}}
	if !p.BuildContext(blk, block.DocView{UUID: ident.New()}, map[string]bool{}).IsEmpty() {
		t.Error("an addressless reference contributes nothing")
	}
}

func TestReferenceProcessor_MarkdownRepresentation(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	docUUID := ident.New()
	held := domain.NewLeafAddress(docUUID, "at-1.yml").String()
	uri := "sieve://" + ident.New()
	cases := []struct {
		name  string
		attrs map[string]interface{}
		want  string
	}{
		{
			name:  "held file links to its served asset",
			attrs: map[string]interface{}{"uri": held, "mime": "text/yaml", "title": "swagger.yml"},
			want:  "[swagger.yml](/ui/assets/" + docUUID + "/at-1.yml)",
		},
		{
			name:  "held file with no title falls back to the asset key",
			attrs: map[string]interface{}{"uri": held, "mime": "text/yaml"},
			want:  "[at-1.yml](/ui/assets/" + docUUID + "/at-1.yml)",
		},
		{
			name:  "pointer links to its coordinate",
			attrs: map[string]interface{}{"uri": uri, "mime": "sieve/note", "title": "Auth Design"},
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
			blk := block.SieveBlock{ID: "at-1", Kind: "reference", Attrs: tc.attrs}
			if got := p.MarkdownRepresentation(blk, docUUID); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// The fenced round-trip is inherited whole from FencedSerializer/Deserializer —
// this asserts the kind is wired to them, not that YAML works.
func TestReferenceProcessor_SerializeRoundTrip(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	id := ident.New()
	blk := block.NewSieveBlock("reference", id, map[string]interface{}{
		"uri": "sieve://" + ident.New(), "title": "Auth Design", "mime": "sieve/note",
	})
	md, err := p.Serialize(blk)
	if err != nil {
		t.Fatalf("Serialize: %v", err)
	}
	if !strings.HasPrefix(md, "```reference") {
		t.Errorf("Serialize must emit the kind-tagged fence; got:\n%s", md)
	}
	region := block.Region{Kind: "reference", Body: md, Raw: md}
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

// A ```attachment fence must still be scanned, still parse, and come back as a
// `reference` block — then re-serialise under the CANONICAL head. Without the
// alias such a fence is not a region at all: the scanner walks past it, prose
// claims the text, and the block is torn apart on save.
func TestReferenceProcessor_LegacyAttachmentFenceLoadsAsReference(t *testing.T) {
	p := NewReferenceProcessor(block.BlockServices{})
	id := ident.New()
	uri := "sieve://" + ident.New()
	legacy := "```attachment\nid: " + id + "\nuri: " + uri + "\ntitle: Auth Design\n```"

	region := block.Region{Kind: "attachment", Body: legacy, Raw: legacy}
	if !p.Accepts(region) {
		t.Fatal("an aliased fence must still be claimed by this kind")
	}
	back, err := p.Deserialize(region)
	if err != nil {
		t.Fatalf("Deserialize: %v", err)
	}
	if len(back) != 1 {
		t.Fatalf("got %d blocks, want 1", len(back))
	}
	if back[0].Kind != "reference" {
		t.Errorf("kind: got %q, want reference — an aliased fence canonicalises", back[0].Kind)
	}
	if back[0].ID != id || back[0].Attrs["uri"] != uri {
		t.Errorf("the parsed block lost its payload: %+v", back[0])
	}

	md, err := p.Serialize(back[0])
	if err != nil {
		t.Fatalf("Serialize: %v", err)
	}
	if !strings.HasPrefix(md, "```reference") {
		t.Errorf("a legacy block must re-serialise under the canonical head; got:\n%s", md)
	}
}
