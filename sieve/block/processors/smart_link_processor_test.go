package processors

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sieve/sieve/block"
	"sieve/sieve/services"
	"testing"
	"time"
)

// ── InitAttrs ────────────────────────────────────────────────────────────────

func TestSmartLinkProcessor_InitAttrs_defaults(t *testing.T) {
	p := NewSmartLinkProcessor(block.BlockServices{})
	attrs := p.InitAttrs("sl-a1b2", nil)

	if attrs["id"] != "sl-a1b2" {
		t.Errorf("id: got %q, want sl-a1b2", attrs["id"])
	}
	if attrs["status"] != block.BlockStatusPending {
		t.Errorf("status: got %q, want PENDING", attrs["status"])
	}
	if attrs["href"] != "" {
		t.Errorf("href: got %q, want empty", attrs["href"])
	}
	if attrs["createdAt"] == "" || attrs["createdAt"] == nil {
		t.Error("createdAt must be set")
	}
}

func TestSmartLinkProcessor_InitAttrs_labelDefaultsToHref(t *testing.T) {
	p := NewSmartLinkProcessor(block.BlockServices{})
	attrs := p.InitAttrs("sl-0001", map[string]interface{}{"href": "https://example.com"})
	if attrs["label"] != "https://example.com" {
		t.Errorf("label should default to href; got %q", attrs["label"])
	}
}

func TestSmartLinkProcessor_InitAttrs_explicitLabelPreserved(t *testing.T) {
	p := NewSmartLinkProcessor(block.BlockServices{})
	attrs := p.InitAttrs("sl-0001", map[string]interface{}{
		"href":  "https://example.com",
		"label": "My Site",
	})
	if attrs["label"] != "My Site" {
		t.Errorf("explicit label must be preserved; got %q", attrs["label"])
	}
}

func TestSmartLinkProcessor_InitAttrs_idNotOverridable(t *testing.T) {
	p := NewSmartLinkProcessor(block.BlockServices{})
	attrs := p.InitAttrs("sl-0001", map[string]interface{}{"id": "injected"})
	if attrs["id"] != "sl-0001" {
		t.Error("id must not be overridable via overrides")
	}
}

// ── IsSupportedContent + Transform ───────────────────────────────────────────

func TestSmartLinkProcessor_IsBlock_httpsURL(t *testing.T) {
	p := NewSmartLinkProcessor(block.BlockServices{})
	if !p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "https://example.com"}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must offer paste for a plain HTTPS URL")
	}
}

func TestSmartLinkProcessor_Transform_httpsURL(t *testing.T) {
	p := NewSmartLinkProcessor(block.BlockServices{})
	overrides := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: "https://example.com"}}, "", "", block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform must return non-nil for a plain HTTPS URL")
	}
	if overrides["href"] != "https://example.com" {
		t.Errorf("href: got %q, want https://example.com", overrides["href"])
	}
	// Transform must not set status or id — those belong to InitAttrs
	if overrides["status"] != nil {
		t.Error("Transform must not set status")
	}
	if overrides["id"] != nil {
		t.Error("Transform must not set id")
	}
}

func TestSmartLinkProcessor_IsBlock_httpURL(t *testing.T) {
	p := NewSmartLinkProcessor(block.BlockServices{})
	if !p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "http://example.com/path?q=1"}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must offer paste for a plain HTTP URL")
	}
}

func TestSmartLinkProcessor_IsBlock_multiLine(t *testing.T) {
	p := NewSmartLinkProcessor(block.BlockServices{})
	if p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "https://a.com\nhttps://b.com"}}).Has(block.ActionPaste) {
		t.Error("IsSupportedContent must not offer paste for multi-line content")
	}
}

func TestSmartLinkProcessor_IsBlock_plainText(t *testing.T) {
	p := NewSmartLinkProcessor(block.BlockServices{})
	if p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "just some text"}}).Has(block.ActionPaste) {
		t.Error("IsSupportedContent must not offer paste for plain text")
	}
}

func TestSmartLinkProcessor_IsBlock_noEntries(t *testing.T) {
	p := NewSmartLinkProcessor(block.BlockServices{})
	if p.IsSupportedContent(nil).Has(block.ActionPaste) {
		t.Error("IsSupportedContent must not offer paste for nil entries")
	}
}

// ── RunJob ───────────────────────────────────────────────────────────────────

func TestSmartLinkProcessor_RunJob_fetchesTitle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<html><head><title>Example Domain</title></head><body></body></html>`))
	}))
	defer srv.Close()

	p := NewSmartLinkProcessor(block.BlockServices{LinkPreview: services.NewLinkPreviewService()})
	blk := &block.SieveBlock{
		ID:   "sl-0001",
		Kind: "smart-link",
		Attrs: map[string]interface{}{
			"href":      srv.URL,
			"label":     srv.URL,
			"status":    block.BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}

	if err := p.RunJob(block.JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: blk}); err != nil {
		t.Fatalf("RunJob returned error: %v", err)
	}
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %q, want COMPLETE", blk.Attrs["status"])
	}
	if blk.Attrs["label"] != "Example Domain" {
		t.Errorf("label: got %q, want Example Domain", blk.Attrs["label"])
	}
	if blk.Attrs["completedAt"] == "" {
		t.Error("completedAt must be set on success")
	}
}

func TestSmartLinkProcessor_RunJob_gracefulOnTitleFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer srv.Close()

	p := NewSmartLinkProcessor(block.BlockServices{LinkPreview: services.NewLinkPreviewService()})
	blk := &block.SieveBlock{
		ID:   "sl-0002",
		Kind: "smart-link",
		Attrs: map[string]interface{}{
			"href":      srv.URL,
			"label":     srv.URL,
			"status":    block.BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}

	if err := p.RunJob(block.JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: blk}); err != nil {
		t.Fatalf("RunJob must not return error on non-200; got %v", err)
	}
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %q; non-200 must still COMPLETE the block", blk.Attrs["status"])
	}
	if blk.Attrs["label"] != srv.URL {
		t.Errorf("label must fall back to href; got %q", blk.Attrs["label"])
	}
}

func TestSmartLinkProcessor_RunJob_emptyHref(t *testing.T) {
	p := NewSmartLinkProcessor(block.BlockServices{})
	blk := &block.SieveBlock{
		ID:   "sl-0003",
		Kind: "smart-link",
		Attrs: map[string]interface{}{
			"href":      "",
			"label":     "",
			"status":    block.BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}
	if err := p.RunJob(block.JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: blk}); err != nil {
		t.Fatalf("RunJob must not error on empty href; got %v", err)
	}
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %q, want COMPLETE", blk.Attrs["status"])
	}
}
