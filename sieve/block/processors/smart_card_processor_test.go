package processors

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sieve/sieve/block"
	"sieve/sieve/services"
	"testing"
	"time"
)

func TestSmartCardProcessor_InitAttrs_defaults(t *testing.T) {
	p := NewSmartCardProcessor(block.BlockServices{})
	attrs := p.InitAttrs("ri-a1b2", nil)

	if attrs["id"] != "ri-a1b2" {
		t.Errorf("id: got %v, want ri-a1b2", attrs["id"])
	}
	// No href ⇒ no fetch job ⇒ born COMPLETE (mirrors DescribeJob==nil).
	if attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE for empty href", attrs["status"])
	}
	if attrs["href"] != "" {
		t.Errorf("href: got %v, want empty", attrs["href"])
	}
	if attrs["createdAt"] == nil || attrs["createdAt"] == "" {
		t.Error("createdAt must be set")
	}
	for _, field := range []string{"title", "description", "image", "siteName", "fetchedAt", "completedAt", "error", "supportsEmbedding"} {
		if _, ok := attrs[field]; !ok {
			t.Errorf("InitAttrs must declare field %q", field)
		}
	}
}

func TestSmartCardProcessor_InitAttrs_idNotOverridable(t *testing.T) {
	p := NewSmartCardProcessor(block.BlockServices{})
	attrs := p.InitAttrs("ri-0001", map[string]interface{}{"id": "injected"})
	if attrs["id"] != "ri-0001" {
		t.Error("id must not be overridable")
	}
}

func TestSmartCardProcessor_InitAttrs_hrefPreserved(t *testing.T) {
	p := NewSmartCardProcessor(block.BlockServices{})
	attrs := p.InitAttrs("ri-0002", map[string]interface{}{"href": "https://example.com"})
	if attrs["href"] != "https://example.com" {
		t.Errorf("href override: got %v, want https://example.com", attrs["href"])
	}
}

func TestSmartCardProcessor_Mode(t *testing.T) {
	p := NewSmartCardProcessor(block.BlockServices{})
	if p.Mode() != block.BlockModeBlock {
		t.Errorf("Mode: got %v, want block", p.Mode())
	}
}

// A URL is reached by an explicit Transform, never by paste: a pasted URL stays an
// ordinary markdown link (#67). Only a copied card round-trips via paste.
func TestSmartCardProcessor_IsSupportedContent(t *testing.T) {
	p := NewSmartCardProcessor(block.BlockServices{})
	cases := []struct {
		name    string
		entries []block.ContentEntry
		want    []block.Action
	}{
		{
			name:    "bare url",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "https://example.com"}},
			want:    []block.Action{block.ActionTransform},
		},
		{
			name:    "markdown link",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "[Example](https://example.com)"}},
			want:    []block.Action{block.ActionTransform},
		},
		{
			name: "rendered link — href only in the html view",
			entries: []block.ContentEntry{
				{MIMEType: "text/plain", Content: "Example"},
				{MIMEType: "text/html", Content: `<p>see <a href="https://example.com">Example</a></p>`},
			},
			want: []block.Action{block.ActionTransform},
		},
		{
			name:    "image url belongs to smart-image",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "https://example.com/pic.png"}},
			want:    nil,
		},
		{
			name:    "plain prose",
			entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "no link here"}},
			want:    nil,
		},
		{
			name:    "copied card round-trips",
			entries: []block.ContentEntry{{MIMEType: "sieve/smart-card", Content: `{"href":"https://example.com"}`}},
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

// Transform recovers the href from every link form and seeds the card title from
// the link's own text until the OG fetch lands.
func TestSmartCardProcessor_Transform_linkForms(t *testing.T) {
	p := NewSmartCardProcessor(block.BlockServices{})
	cases := []struct {
		name      string
		entries   []block.ContentEntry
		wantHref  string
		wantTitle interface{}
	}{
		{
			name:     "bare url has no title to seed",
			entries:  []block.ContentEntry{{MIMEType: "text/plain", Content: "https://example.com"}},
			wantHref: "https://example.com",
		},
		{
			name:      "markdown link seeds the title",
			entries:   []block.ContentEntry{{MIMEType: "text/plain", Content: "[Example Title](https://example.com)"}},
			wantHref:  "https://example.com",
			wantTitle: "Example Title",
		},
		{
			name: "rendered link seeds the title from the anchor",
			entries: []block.ContentEntry{
				{MIMEType: "text/plain", Content: "Example Title"},
				{MIMEType: "text/html", Content: `<a href="https://example.com">Example Title</a>`},
			},
			wantHref:  "https://example.com",
			wantTitle: "Example Title",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			overrides := p.Transform(tc.entries, "u", "crd-1", block.ActionTransform)
			if overrides == nil {
				t.Fatal("Transform declined a link")
			}
			if overrides["href"] != tc.wantHref {
				t.Errorf("href: got %v, want %q", overrides["href"], tc.wantHref)
			}
			if overrides["title"] != tc.wantTitle {
				t.Errorf("title: got %v, want %v", overrides["title"], tc.wantTitle)
			}
		})
	}
}

func TestSmartCardProcessor_RunJob_fetchesOGData(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!DOCTYPE html><html><head>
<meta property="og:title" content="Test Title"/>
<meta property="og:description" content="Test Desc"/>
<meta property="og:site_name" content="Test Site"/>
</head><body></body></html>`)
	}))
	defer srv.Close()

	p := NewSmartCardProcessor(block.BlockServices{LinkPreview: services.NewLinkPreviewService()})
	blk := &block.SieveBlock{
		ID:   "ri-0001",
		Kind: "smart-card",
		Attrs: map[string]interface{}{
			"href":      srv.URL,
			"status":    block.BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}

	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: blk})
	res, werr := job.Work()
	if werr != nil {
		t.Fatalf("Work returned error: %v", werr)
	}
	job.Apply(res, blk)
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", blk.Attrs["status"])
	}
	if blk.Attrs["title"] != "Test Title" {
		t.Errorf("title: got %v, want Test Title", blk.Attrs["title"])
	}
	if blk.Attrs["description"] != "Test Desc" {
		t.Errorf("description: got %v, want Test Desc", blk.Attrs["description"])
	}
	if blk.Attrs["siteName"] != "Test Site" {
		t.Errorf("siteName: got %v, want Test Site", blk.Attrs["siteName"])
	}
	if blk.Attrs["fetchedAt"] == "" || blk.Attrs["fetchedAt"] == nil {
		t.Error("fetchedAt must be set on success")
	}
	if blk.Attrs["completedAt"] == "" || blk.Attrs["completedAt"] == nil {
		t.Error("completedAt must be set on success")
	}
}

func TestSmartCardProcessor_RunJob_emptyHrefNoJob(t *testing.T) {
	p := NewSmartCardProcessor(block.BlockServices{LinkPreview: services.NewLinkPreviewService()})
	blk := &block.SieveBlock{
		ID:   "ri-0002",
		Kind: "smart-card",
		Attrs: map[string]interface{}{
			"href":      "",
			"status":    block.BlockStatusComplete,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}
	// No href ⇒ no fetch job. The block is born COMPLETE by InitAttrs, so it is
	// never dispatched; DescribeJob returns nil.
	if job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: blk}); job != nil {
		t.Errorf("empty href must return a nil job, got %+v", job)
	}
}

func TestSmartCardProcessor_RunJob_imageFailureIsNonFatal(t *testing.T) {
	// Page has an OG image URL that will fail to download.
	imgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "gone", http.StatusGone)
	}))
	defer imgSrv.Close()

	pageSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!DOCTYPE html><html><head>
<meta property="og:title" content="T"/>
<meta property="og:image" content="%s/img.jpg"/>
</head><body></body></html>`, imgSrv.URL)
	}))
	defer pageSrv.Close()

	p := NewSmartCardProcessor(block.BlockServices{LinkPreview: services.NewLinkPreviewService()})
	blk := &block.SieveBlock{
		ID:   "ri-0003",
		Kind: "smart-card",
		Attrs: map[string]interface{}{
			"href":      pageSrv.URL,
			"status":    block.BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}

	job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: blk})
	res, werr := job.Work()
	if werr != nil {
		t.Fatalf("Work must not error when image download fails; got %v", werr)
	}
	job.Apply(res, blk)
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE even when image fails", blk.Attrs["status"])
	}
	if blk.Attrs["image"] != "" && blk.Attrs["image"] != nil {
		t.Errorf("image must be empty when download fails; got %v", blk.Attrs["image"])
	}
}

func TestSmartCardProcessor_BuildContext(t *testing.T) {
	p := NewSmartCardProcessor(block.BlockServices{})
	blk := block.SieveBlock{
		ID:   "ri-0001",
		Kind: "smart-card",
		Attrs: map[string]interface{}{
			"href":        "https://example.com",
			"title":       "Example",
			"description": "A test site",
			"siteName":    "Example.com",
		},
	}
	ctx := p.BuildContext(blk, block.DocView{}, map[string]bool{})
	if ctx.IsEmpty() {
		t.Error("BuildContext must return non-empty string for complete block")
	}
}
