package sieve

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSmartCardProcessor_InitAttrs_defaults(t *testing.T) {
	p := NewSmartCardProcessor(BlockServices{})
	attrs := p.InitAttrs("ri-a1b2", nil)

	if attrs["id"] != "ri-a1b2" {
		t.Errorf("id: got %v, want ri-a1b2", attrs["id"])
	}
	if attrs["status"] != BlockStatusPending {
		t.Errorf("status: got %v, want PENDING", attrs["status"])
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
	p := NewSmartCardProcessor(BlockServices{})
	attrs := p.InitAttrs("ri-0001", map[string]interface{}{"id": "injected"})
	if attrs["id"] != "ri-0001" {
		t.Error("id must not be overridable")
	}
}

func TestSmartCardProcessor_InitAttrs_hrefPreserved(t *testing.T) {
	p := NewSmartCardProcessor(BlockServices{})
	attrs := p.InitAttrs("ri-0002", map[string]interface{}{"href": "https://example.com"})
	if attrs["href"] != "https://example.com" {
		t.Errorf("href override: got %v, want https://example.com", attrs["href"])
	}
}

func TestSmartCardProcessor_Mode(t *testing.T) {
	p := NewSmartCardProcessor(BlockServices{})
	if p.Mode() != BlockModeBlock {
		t.Errorf("Mode: got %v, want block", p.Mode())
	}
}

func TestSmartCardProcessor_IsBlock_neverMatches(t *testing.T) {
	p := NewSmartCardProcessor(BlockServices{})
	if !p.IsBlock([]ContentEntry{{MIMEType: "text/plain", Content: "https://example.com"}}) {
		t.Error("IsBlock must always return true — URLs can become SmartLinks and Cards")
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

	p := NewSmartCardProcessor(BlockServices{LinkPreview: NewLinkPreviewService()})
	block := &SieveBlock{
		ID:   "ri-0001",
		Kind: "smart-card",
		Attrs: map[string]interface{}{
			"href":      srv.URL,
			"status":    BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}

	if err := p.RunJob(JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: block}); err != nil {
		t.Fatalf("RunJob returned error: %v", err)
	}
	if block.Attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", block.Attrs["status"])
	}
	if block.Attrs["title"] != "Test Title" {
		t.Errorf("title: got %v, want Test Title", block.Attrs["title"])
	}
	if block.Attrs["description"] != "Test Desc" {
		t.Errorf("description: got %v, want Test Desc", block.Attrs["description"])
	}
	if block.Attrs["siteName"] != "Test Site" {
		t.Errorf("siteName: got %v, want Test Site", block.Attrs["siteName"])
	}
	if block.Attrs["fetchedAt"] == "" || block.Attrs["fetchedAt"] == nil {
		t.Error("fetchedAt must be set on success")
	}
	if block.Attrs["completedAt"] == "" || block.Attrs["completedAt"] == nil {
		t.Error("completedAt must be set on success")
	}
}

func TestSmartCardProcessor_RunJob_emptyHrefCompletes(t *testing.T) {
	p := NewSmartCardProcessor(BlockServices{LinkPreview: NewLinkPreviewService()})
	block := &SieveBlock{
		ID:   "ri-0002",
		Kind: "smart-card",
		Attrs: map[string]interface{}{
			"href":      "",
			"status":    BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}
	if err := p.RunJob(JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: block}); err != nil {
		t.Fatalf("RunJob must not error on empty href; got %v", err)
	}
	if block.Attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", block.Attrs["status"])
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

	p := NewSmartCardProcessor(BlockServices{LinkPreview: NewLinkPreviewService()})
	block := &SieveBlock{
		ID:   "ri-0003",
		Kind: "smart-card",
		Attrs: map[string]interface{}{
			"href":      pageSrv.URL,
			"status":    BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}

	if err := p.RunJob(JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: block}); err != nil {
		t.Fatalf("RunJob must not error when image download fails; got %v", err)
	}
	if block.Attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE even when image fails", block.Attrs["status"])
	}
	if block.Attrs["image"] != "" && block.Attrs["image"] != nil {
		t.Errorf("image must be empty when download fails; got %v", block.Attrs["image"])
	}
}

func TestSmartCardProcessor_BuildContext(t *testing.T) {
	p := NewSmartCardProcessor(BlockServices{})
	block := SieveBlock{
		ID:   "ri-0001",
		Kind: "smart-card",
		Attrs: map[string]interface{}{
			"href":        "https://example.com",
			"title":       "Example",
			"description": "A test site",
			"siteName":    "Example.com",
		},
	}
	ctx := p.BuildContext(block, ShadowDocument{}, map[string]bool{})
	if ctx == "" {
		t.Error("BuildContext must return non-empty string for complete block")
	}
}
