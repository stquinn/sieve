package sieve

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ── InitAttrs ────────────────────────────────────────────────────────────────

func TestSmartLinkProcessor_InitAttrs_defaults(t *testing.T) {
	p := NewSmartLinkProcessor(BlockServices{})
	attrs := p.InitAttrs("sl-a1b2", nil)

	if attrs["id"] != "sl-a1b2" {
		t.Errorf("id: got %q, want sl-a1b2", attrs["id"])
	}
	if attrs["status"] != BlockStatusPending {
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
	p := NewSmartLinkProcessor(BlockServices{})
	attrs := p.InitAttrs("sl-0001", map[string]interface{}{"href": "https://example.com"})
	if attrs["label"] != "https://example.com" {
		t.Errorf("label should default to href; got %q", attrs["label"])
	}
}

func TestSmartLinkProcessor_InitAttrs_explicitLabelPreserved(t *testing.T) {
	p := NewSmartLinkProcessor(BlockServices{})
	attrs := p.InitAttrs("sl-0001", map[string]interface{}{
		"href":  "https://example.com",
		"label": "My Site",
	})
	if attrs["label"] != "My Site" {
		t.Errorf("explicit label must be preserved; got %q", attrs["label"])
	}
}

func TestSmartLinkProcessor_InitAttrs_idNotOverridable(t *testing.T) {
	p := NewSmartLinkProcessor(BlockServices{})
	attrs := p.InitAttrs("sl-0001", map[string]interface{}{"id": "injected"})
	if attrs["id"] != "sl-0001" {
		t.Error("id must not be overridable via overrides")
	}
}

// ── PasteMatch ───────────────────────────────────────────────────────────────

func TestSmartLinkProcessor_PasteMatch_httpsURL(t *testing.T) {
	p := NewSmartLinkProcessor(BlockServices{})
	ok, overrides := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "https://example.com"}}, "", "")
	if !ok {
		t.Fatal("expected match for plain HTTPS URL")
	}
	if overrides["href"] != "https://example.com" {
		t.Errorf("href: got %q, want https://example.com", overrides["href"])
	}
	if overrides["status"] != nil {
		t.Error("PasteMatch must not set status — that belongs to InitAttrs")
	}
	if overrides["id"] != nil {
		t.Error("PasteMatch must not set id — that belongs to InitAttrs")
	}
}

func TestSmartLinkProcessor_PasteMatch_httpURL(t *testing.T) {
	p := NewSmartLinkProcessor(BlockServices{})
	ok, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "http://example.com/path?q=1"}}, "", "")
	if !ok {
		t.Fatal("expected match for plain HTTP URL")
	}
}

func TestSmartLinkProcessor_PasteMatch_multiLine(t *testing.T) {
	p := NewSmartLinkProcessor(BlockServices{})
	ok, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "https://a.com\nhttps://b.com"}}, "", "")
	if ok {
		t.Error("multi-line paste must not match")
	}
}

func TestSmartLinkProcessor_PasteMatch_plainText(t *testing.T) {
	p := NewSmartLinkProcessor(BlockServices{})
	ok, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "just some text"}}, "", "")
	if ok {
		t.Error("plain text must not match")
	}
}

func TestSmartLinkProcessor_PasteMatch_noEntries(t *testing.T) {
	p := NewSmartLinkProcessor(BlockServices{})
	ok, _ := p.PasteMatch(nil, "", "")
	if ok {
		t.Error("empty clipboard must not match")
	}
}

// ── RunJob ───────────────────────────────────────────────────────────────────

func TestSmartLinkProcessor_RunJob_fetchesTitle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<html><head><title>Example Domain</title></head><body></body></html>`))
	}))
	defer srv.Close()

	p := NewSmartLinkProcessor(BlockServices{LinkPreview: NewLinkPreviewService()})
	block := &SieveBlock{
		ID:   "sl-0001",
		Kind: "smart-link",
		Attrs: map[string]interface{}{
			"href":      srv.URL,
			"label":     srv.URL,
			"status":    BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}

	if err := p.RunJob(context.Background(), "uuid-1", block, nil); err != nil {
		t.Fatalf("RunJob returned error: %v", err)
	}
	if block.Attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %q, want COMPLETE", block.Attrs["status"])
	}
	if block.Attrs["label"] != "Example Domain" {
		t.Errorf("label: got %q, want Example Domain", block.Attrs["label"])
	}
	if block.Attrs["completedAt"] == "" {
		t.Error("completedAt must be set on success")
	}
}

func TestSmartLinkProcessor_RunJob_gracefulOnTitleFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer srv.Close()

	p := NewSmartLinkProcessor(BlockServices{LinkPreview: NewLinkPreviewService()})
	block := &SieveBlock{
		ID:   "sl-0002",
		Kind: "smart-link",
		Attrs: map[string]interface{}{
			"href":      srv.URL,
			"label":     srv.URL,
			"status":    BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}

	if err := p.RunJob(context.Background(), "uuid-1", block, nil); err != nil {
		t.Fatalf("RunJob must not return error on non-200; got %v", err)
	}
	if block.Attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %q; non-200 must still COMPLETE the block", block.Attrs["status"])
	}
	if block.Attrs["label"] != srv.URL {
		t.Errorf("label must fall back to href; got %q", block.Attrs["label"])
	}
}

func TestSmartLinkProcessor_RunJob_emptyHref(t *testing.T) {
	p := NewSmartLinkProcessor(BlockServices{})
	block := &SieveBlock{
		ID:   "sl-0003",
		Kind: "smart-link",
		Attrs: map[string]interface{}{
			"href":      "",
			"label":     "",
			"status":    BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}
	if err := p.RunJob(context.Background(), "uuid-1", block, nil); err != nil {
		t.Fatalf("RunJob must not error on empty href; got %v", err)
	}
	if block.Attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %q, want COMPLETE", block.Attrs["status"])
	}
}
