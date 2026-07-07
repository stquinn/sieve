# Rich Link Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `rich-link` Sieve block kind that renders Open Graph metadata for a URL as a visual card, sitting between Smart Link (inline, title only) and Web Clip (full content, AI-capable) in the block lifecycle.

**Architecture:** Follows the standard Sieve Block Framework — a `RichLinkProcessor` Go struct that implements `BlockProcessor`, plus a `rich-link-renderer.js` JS file registered via `T.registerSieveRenderer`. The Go backend extends the existing `LinkPreviewService` with a `FetchFull` method for OG metadata. Two creation entry points: `Ctrl+Shift+L` keyboard shortcut (dialog) and SmartLink right-click "Enrich as Card" (no dialog). This work also introduces the **Promote to Document framework**: a new `MarkdownRepresentation(block SieveBlock) string` method on `BlockProcessor`, a `PromoteBlock` function in `markdown_parser.go`, and a `supportsPromotion` base attr that causes `sieve-block-extension.js` to auto-inject the "Promote to Document" context menu item for any supporting block. All existing processors are updated in this plan.

**Tech Stack:** Go, `golang.org/x/net/html` (already in go.mod for `FetchTitle`), vanilla JS, TipTap NodeView pattern from `web-clip-renderer.js`.

**Read before starting:**
- `docs/how-to-sieve-block-framework.md` — the framework rules and checklist
- `sieve/smart_link_processor.go` — closest existing processor (inline mode)
- `sieve/link_preview_service.go` — `FetchTitle` to extend
- `frontend/src/static/web-clip-renderer.js` — renderer to model
- `frontend/src/static/smart-link-renderer.js` — renderer to modify
- `frontend/src/static/editor.js` — `createInternalizeDialog` pattern + event system
- `docs/design/archive/2026-06-08-rich-link-cards-design.md` — the spec

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `sieve/processor_registry.go` | Add `MarkdownRepresentation` to `BlockProcessor` interface |
| Modify | `sieve/link_preview_service.go` | Add `LinkPreviewResult` type + `FetchFull` method |
| Create | `sieve/link_preview_service_test.go` | Tests for `FetchFull` |
| Create | `sieve/rich_link_processor.go` | `RichLinkProcessor` — all seven `BlockProcessor` methods |
| Create | `sieve/rich_link_processor_test.go` | Tests for `RichLinkProcessor` |
| Modify | `sieve/ai_block_processor.go` | Add `MarkdownRepresentation` + `supportsPromotion: true` |
| Modify | `sieve/web_clip_processor.go` | Add `MarkdownRepresentation` + `supportsPromotion: true` |
| Modify | `sieve/smart_image_processor.go` | Add `MarkdownRepresentation` + `supportsPromotion: true` |
| Modify | `sieve/code_processor.go` | Add `MarkdownRepresentation` + `supportsPromotion: true` |
| Modify | `sieve/smart_link_processor.go` | Add `MarkdownRepresentation` (returns `""`) |
| Modify | `sieve/markdown_parser.go` | Add `PromoteBlock` function |
| Create | `sieve/markdown_parser_promote_test.go` | Tests for `PromoteBlock` |
| Modify | `sieve/editor_service.go` | Add `EditorService.PromoteBlock` method |
| Modify | `sieve/service_provider.go` | Register `rich-link` processor |
| Modify | `requesthandlers/ws_handler.go` | Add `promote-block` WS message case |
| Modify | `frontend/src/static/sieve-block-extension.js` | Add `supportsPromotion` base attr + auto-inject promote item |
| Modify | `frontend/src/static/editor.js` | `Ctrl+Shift+L` dialog; promote WS send/receive; enrich/upgrade handlers |
| Modify | `frontend/src/static/web-clip-renderer.js` | Remove manual promote; Go now owns promotion |
| Modify | `frontend/src/static/context-menu.js` | AI Block: wire promote to `sieve:promote-block` |
| Create | `frontend/src/static/rich-link-renderer.js` | Card renderer + context menu |
| Modify | `frontend/src/static/smart-link-renderer.js` | Add "Enrich as Card" |
| Modify | `frontend/src/index.html` | Load `rich-link-renderer.js` |
| Modify | `frontend/src/static/input.css` | Card styles |
| Modify | `frontend/src/static/input.css` | `.rich-link-card` CSS |
| Create | `frontend/src/static/rich-link-renderer.js` | NodeView + context menu |
| Modify | `frontend/src/index.html` | Load `rich-link-renderer.js` |
| Modify | `frontend/src/static/editor.js` | Ctrl+Shift+L dialog + event handlers |
| Modify | `frontend/src/static/smart-link-renderer.js` | Add "Enrich as Card" context menu item |

---

## Task 1: Go — `LinkPreviewService.FetchFull`

**Files:**
- Modify: `sieve/link_preview_service.go`
- Create: `sieve/link_preview_service_test.go`

`FetchFull` returns OG metadata from a URL. It does NOT download images — that is the processor's responsibility. It returns the raw OG image URL; the caller fetches and saves the image via `AssetService`.

- [ ] **Step 1: Write failing tests**

Create `sieve/link_preview_service_test.go`:

```go
package sieve

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchFull_OGTags(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<!DOCTYPE html><html><head>
<meta property="og:title" content="OG Title"/>
<meta property="og:description" content="OG Desc"/>
<meta property="og:image" content="https://example.com/img.jpg"/>
<meta property="og:site_name" content="Example Site"/>
<title>Page Title</title>
</head><body></body></html>`))
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	r := s.FetchFull(srv.URL)

	if r.Title != "OG Title" {
		t.Errorf("Title: got %q, want OG Title", r.Title)
	}
	if r.Description != "OG Desc" {
		t.Errorf("Description: got %q, want OG Desc", r.Description)
	}
	if r.OGImageURL != "https://example.com/img.jpg" {
		t.Errorf("OGImageURL: got %q, want https://example.com/img.jpg", r.OGImageURL)
	}
	if r.SiteName != "Example Site" {
		t.Errorf("SiteName: got %q, want Example Site", r.SiteName)
	}
}

func TestFetchFull_FallsBackToTitle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<!DOCTYPE html><html><head>
<title>Fallback Title</title>
<meta name="description" content="Fallback Desc"/>
</head><body></body></html>`))
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	r := s.FetchFull(srv.URL)

	if r.Title != "Fallback Title" {
		t.Errorf("Title: got %q, want Fallback Title", r.Title)
	}
	if r.Description != "Fallback Desc" {
		t.Errorf("Description: got %q, want Fallback Desc", r.Description)
	}
	if r.OGImageURL != "" {
		t.Errorf("OGImageURL: got %q, want empty", r.OGImageURL)
	}
}

func TestFetchFull_TwitterFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<!DOCTYPE html><html><head>
<meta name="twitter:title" content="Twitter Title"/>
<meta name="twitter:description" content="Twitter Desc"/>
<meta name="twitter:image" content="https://example.com/tw.jpg"/>
</head><body></body></html>`))
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	r := s.FetchFull(srv.URL)

	if r.Title != "Twitter Title" {
		t.Errorf("Title: got %q, want Twitter Title", r.Title)
	}
	if r.OGImageURL != "https://example.com/tw.jpg" {
		t.Errorf("OGImageURL: got %q, want twitter image", r.OGImageURL)
	}
}

func TestFetchFull_RelativeImageResolved(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<!DOCTYPE html><html><head>
<meta property="og:image" content="/images/banner.jpg"/>
</head><body></body></html>`))
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	r := s.FetchFull(srv.URL)

	want := srv.URL + "/images/banner.jpg"
	if r.OGImageURL != want {
		t.Errorf("OGImageURL: got %q, want %q", r.OGImageURL, want)
	}
}

func TestFetchFull_HostnameFallbackForSiteName(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<!DOCTYPE html><html><head><title>T</title></head><body></body></html>`))
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	r := s.FetchFull(srv.URL)

	if r.SiteName == "" {
		t.Error("SiteName must fall back to hostname when og:site_name is absent")
	}
}

func TestFetchFull_GracefulOnNonOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusForbidden)
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	r := s.FetchFull(srv.URL)

	// Must return zero-value result, not panic
	if r.Title != "" || r.Description != "" {
		t.Errorf("non-200 must return empty result; got title=%q desc=%q", r.Title, r.Description)
	}
}
```

- [ ] **Step 2: Run tests — expect FAIL (FetchFull not defined)**

```bash
cd /home/stephen/Development/projects/sieve
go test -tags webkit2_41 ./sieve/... -run TestFetchFull -v 2>&1 | head -30
```

Expected: `undefined: s.FetchFull` or similar compile error.

- [ ] **Step 3: Implement `FetchFull` in `sieve/link_preview_service.go`**

Add after the existing `FetchTitle` method:

```go
// LinkPreviewResult holds Open Graph metadata fetched from a URL.
// OGImageURL is the raw OG image URL — callers are responsible for downloading
// and storing it via AssetService. Empty string means no image was found.
type LinkPreviewResult struct {
	Title       string
	Description string
	OGImageURL  string
	SiteName    string
}

// FetchFull returns Open Graph metadata for targetURL.
// Priority: og:* > twitter:* > <title>/<meta name="description"> > hostname fallback.
// Returns a zero-value result on any fetch or parse failure.
func (s *LinkPreviewService) FetchFull(targetURL string) LinkPreviewResult {
	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		Timeout: 8 * time.Second,
	}
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		return LinkPreviewResult{}
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		return LinkPreviewResult{}
	}
	defer resp.Body.Close()

	doc, err := html.Parse(resp.Body)
	if err != nil {
		return LinkPreviewResult{}
	}

	var (
		ogTitle, ogDesc, ogImage, ogSite string
		twTitle, twDesc, twImage         string
		pageTitle, metaDesc              string
	)

	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "title":
				if n.FirstChild != nil && pageTitle == "" {
					pageTitle = strings.TrimSpace(n.FirstChild.Data)
				}
			case "meta":
				prop, name, content := attrVal(n, "property"), attrVal(n, "name"), attrVal(n, "content")
				switch prop {
				case "og:title":
					ogTitle = content
				case "og:description":
					ogDesc = content
				case "og:image":
					ogImage = content
				case "og:site_name":
					ogSite = content
				}
				switch name {
				case "twitter:title":
					twTitle = content
				case "twitter:description":
					twDesc = content
				case "twitter:image":
					twImage = content
				case "description":
					metaDesc = content
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)

	result := LinkPreviewResult{}
	result.Title = first(ogTitle, twTitle, pageTitle, targetURL)
	result.Description = first(ogDesc, twDesc, metaDesc)
	result.SiteName = first(ogSite, hostOnly(targetURL))

	rawImage := first(ogImage, twImage)
	if rawImage != "" {
		result.OGImageURL = resolveURL(targetURL, rawImage)
	}

	return result
}

func attrVal(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func first(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func hostOnly(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Hostname()
}

func resolveURL(base, ref string) string {
	b, err := url.Parse(base)
	if err != nil {
		return ref
	}
	r, err := url.Parse(ref)
	if err != nil {
		return ref
	}
	return b.ResolveReference(r).String()
}
```

Also add `"net/url"` to the import block at the top of `link_preview_service.go`.

- [ ] **Step 4: Run tests — expect PASS**

```bash
go test -tags webkit2_41 ./sieve/... -run TestFetchFull -v
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Compile check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add sieve/link_preview_service.go sieve/link_preview_service_test.go
git commit -m "feat(go): add LinkPreviewService.FetchFull for OG metadata"
```

---

## Task 2: Go — `RichLinkProcessor`

**Files:**
- Create: `sieve/rich_link_processor.go`
- Create: `sieve/rich_link_processor_test.go`
- Modify: `sieve/service_provider.go`

The processor fetches OG metadata and downloads the image via `AssetService`. Image download failures are non-fatal.

- [ ] **Step 1: Write failing tests**

Create `sieve/rich_link_processor_test.go`:

```go
package sieve

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRichLinkProcessor_InitAttrs_defaults(t *testing.T) {
	p := NewRichLinkProcessor(BlockServices{})
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
	for _, field := range []string{"title", "description", "image", "siteName", "fetchedAt", "completedAt", "error"} {
		if _, ok := attrs[field]; !ok {
			t.Errorf("InitAttrs must declare field %q", field)
		}
	}
}

func TestRichLinkProcessor_InitAttrs_idNotOverridable(t *testing.T) {
	p := NewRichLinkProcessor(BlockServices{})
	attrs := p.InitAttrs("ri-0001", map[string]interface{}{"id": "injected"})
	if attrs["id"] != "ri-0001" {
		t.Error("id must not be overridable")
	}
}

func TestRichLinkProcessor_InitAttrs_hrefPreserved(t *testing.T) {
	p := NewRichLinkProcessor(BlockServices{})
	attrs := p.InitAttrs("ri-0002", map[string]interface{}{"href": "https://example.com"})
	if attrs["href"] != "https://example.com" {
		t.Errorf("href override: got %v, want https://example.com", attrs["href"])
	}
}

func TestRichLinkProcessor_Mode(t *testing.T) {
	p := NewRichLinkProcessor(BlockServices{})
	if p.Mode() != BlockModeBlock {
		t.Errorf("Mode: got %v, want block", p.Mode())
	}
}

func TestRichLinkProcessor_PasteMatch_neverMatches(t *testing.T) {
	p := NewRichLinkProcessor(BlockServices{})
	ok, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "https://example.com"}}, "", "")
	if ok {
		t.Error("PasteMatch must always return false — URLs become SmartLinks, not RichLink cards")
	}
}

func TestRichLinkProcessor_RunJob_fetchesOGData(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!DOCTYPE html><html><head>
<meta property="og:title" content="Test Title"/>
<meta property="og:description" content="Test Desc"/>
<meta property="og:site_name" content="Test Site"/>
</head><body></body></html>`)
	}))
	defer srv.Close()

	p := NewRichLinkProcessor(BlockServices{LinkPreview: NewLinkPreviewService()})
	block := &SieveBlock{
		ID:   "ri-0001",
		Kind: "rich-link",
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

func TestRichLinkProcessor_RunJob_emptyHrefCompletes(t *testing.T) {
	p := NewRichLinkProcessor(BlockServices{LinkPreview: NewLinkPreviewService()})
	block := &SieveBlock{
		ID:   "ri-0002",
		Kind: "rich-link",
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

func TestRichLinkProcessor_RunJob_imageFailureIsNonFatal(t *testing.T) {
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

	p := NewRichLinkProcessor(BlockServices{LinkPreview: NewLinkPreviewService()})
	block := &SieveBlock{
		ID:   "ri-0003",
		Kind: "rich-link",
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

func TestRichLinkProcessor_BuildContext(t *testing.T) {
	p := NewRichLinkProcessor(BlockServices{})
	block := SieveBlock{
		ID:   "ri-0001",
		Kind: "rich-link",
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
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
go test -tags webkit2_41 ./sieve/... -run TestRichLinkProcessor -v 2>&1 | head -20
```

Expected: compile error — `NewRichLinkProcessor` not defined.

- [ ] **Step 3: Implement `sieve/rich_link_processor.go`**

Create the file:

```go
package sieve

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// RichLinkProcessor handles the 'rich-link' block kind.
// It fetches Open Graph metadata for a URL and stores the result as block attrs.
// Image download is best-effort; failures are non-fatal.
type RichLinkProcessor struct{ svc BlockServices }

func NewRichLinkProcessor(svc BlockServices) *RichLinkProcessor {
	return &RichLinkProcessor{svc: svc}
}

func (p *RichLinkProcessor) Mode() BlockMode { return BlockModeBlock }

func (p *RichLinkProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":          id,
		"href":        "",
		"title":       "",
		"description": "",
		"image":       "",
		"siteName":    "",
		"fetchedAt":   "",
		"status":      BlockStatusPending,
		"createdAt":   time.Now().UTC().Format(time.RFC3339),
		"completedAt": "",
		"error":       "",
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	return attrs
}

func (p *RichLinkProcessor) PasteMatch(_ []PasteEntry, _ string, _ string) (bool, map[string]interface{}) {
	return false, nil
}

func (p *RichLinkProcessor) OnChange(_ *SieveBlock) {}

func (p *RichLinkProcessor) JobLabel(block *SieveBlock) string {
	href, _ := block.Attrs["href"].(string)
	if href == "" {
		return "Fetching link…"
	}
	if u, err := url.Parse(href); err == nil && u.Host != "" {
		return "Fetching " + u.Hostname()
	}
	return "Fetching link…"
}

func (p *RichLinkProcessor) BuildContext(block SieveBlock, _ ShadowDocument, _ map[string]bool) string {
	href, _ := block.Attrs["href"].(string)
	if href == "" {
		return ""
	}
	title, _ := block.Attrs["title"].(string)
	desc, _ := block.Attrs["description"].(string)
	site, _ := block.Attrs["siteName"].(string)

	var sb strings.Builder
	sb.WriteString("NODE ID: " + block.ID + "\n\n")
	sb.WriteString("Link: " + href + "\n")
	if title != "" {
		sb.WriteString("Title: " + title + "\n")
	}
	if site != "" {
		sb.WriteString("Source: " + site + "\n")
	}
	if desc != "" {
		sb.WriteString("Description: " + desc + "\n")
	}
	return sb.String()
}

func (p *RichLinkProcessor) RunJob(jctx JobContext) error {
	block := jctx.Block
	href, _ := block.Attrs["href"].(string)
	now := time.Now().UTC().Format(time.RFC3339)

	if href == "" {
		block.Attrs["status"] = BlockStatusComplete
		block.Attrs["completedAt"] = now
		block.Attrs["fetchedAt"] = now
		return nil
	}

	result := p.svc.LinkPreview.FetchFull(href)

	block.Attrs["title"] = result.Title
	block.Attrs["description"] = result.Description
	block.Attrs["siteName"] = result.SiteName

	if result.OGImageURL != "" && p.svc.Assets != nil && p.svc.Documents != nil {
		if ref, err := p.downloadImage(jctx.UUID, block.ID, result.OGImageURL); err == nil {
			block.Attrs["image"] = ref
		}
		// image download failure is non-fatal
	}

	block.Attrs["status"] = BlockStatusComplete
	block.Attrs["completedAt"] = now
	block.Attrs["fetchedAt"] = now
	return nil
}

func (p *RichLinkProcessor) downloadImage(uuid, blockID, imageURL string) (string, error) {
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(imageURL)
	if err != nil {
		return "", fmt.Errorf("fetch image: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch image: status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read image body: %w", err)
	}

	cat := WorkingCopy
	if d, err := p.svc.Documents.LoadByUUID(uuid); err == nil && d.Kind() == KindNote {
		cat = Library
	}

	asset, err := p.svc.Assets.Save(cat, uuid, blockID+"-img", data)
	if err != nil {
		return "", fmt.Errorf("save image asset: %w", err)
	}
	return asset.ExternalRef(), nil
}
```

- [ ] **Step 4: Register in `sieve/service_provider.go`**

Find the block that contains existing `RegisterProcessor` calls (around line 62):
```go
RegisterProcessor("smart-link",  NewSmartLinkProcessor(svc))
```

Add the new registration immediately after it:
```go
RegisterProcessor("rich-link",   NewRichLinkProcessor(svc))
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
go test -tags webkit2_41 ./sieve/... -run TestRichLinkProcessor -v
```

Expected: all 8 tests PASS. (The `TestRichLinkProcessor_RunJob_imageFailureIsNonFatal` test will pass because `p.svc.Assets` is nil, so the image branch is skipped — which is correct test isolation behaviour.)

- [ ] **Step 6: Full sieve test suite**

```bash
go test -tags webkit2_41 ./sieve/... -v 2>&1 | tail -20
```

Expected: no failures.

- [ ] **Step 7: Compile check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add sieve/rich_link_processor.go sieve/rich_link_processor_test.go sieve/service_provider.go
git commit -m "feat(go): add RichLinkProcessor for rich-link block kind"
```

---

## Task 2B: Go — `MarkdownRepresentation` on `BlockProcessor` + all processors

**Files:**
- Modify: `sieve/processor_registry.go`
- Modify: `sieve/ai_block_processor.go`
- Modify: `sieve/web_clip_processor.go`
- Modify: `sieve/smart_image_processor.go`
- Modify: `sieve/code_processor.go`
- Modify: `sieve/smart_link_processor.go`
- Modify: `sieve/rich_link_processor.go` (just created in Task 2)

Adding `MarkdownRepresentation` to the interface is a **breaking change** — all processors must implement it before the build passes. Do all processors in one commit.

- [ ] **Step 1: Add method to `BlockProcessor` interface in `sieve/processor_registry.go`**

Find the `BlockProcessor` interface definition and add after `BuildContext`:

```go
// MarkdownRepresentation returns the block's content as portable markdown prose
// for use when the user promotes the block to document content.
// Returns "" for blocks that do not support promotion.
// EditorService calls this — processors must not interact with markdown_parser directly.
MarkdownRepresentation(block SieveBlock) string
```

- [ ] **Step 2: Verify build fails (interface not satisfied)**

```bash
go build -tags webkit2_41 ./... 2>&1 | head -20
```

Expected: multiple `does not implement BlockProcessor` errors — one per processor.

- [ ] **Step 3: Add `MarkdownRepresentation` to `sieve/ai_block_processor.go`**

Add `supportsPromotion: true` in `InitAttrs` (after the existing attrs map, before the overrides loop):
```go
"supportsPromotion": true,
```

Add the method after `RunJob`:
```go
func (p *AIBlockProcessor) MarkdownRepresentation(block SieveBlock) string {
	status, _ := block.Attrs["status"].(string)
	response, _ := block.Attrs["response"].(string)
	response = strings.TrimSpace(response)
	if status != BlockStatusComplete || response == "" {
		return ""
	}
	question, _ := block.Attrs["question"].(string)
	question = strings.TrimSpace(question)
	if question != "" {
		return "### " + question + "\n\n" + response
	}
	return response
}
```

- [ ] **Step 4: Add `MarkdownRepresentation` to `sieve/web_clip_processor.go`**

Add `supportsPromotion: true` in `InitAttrs`.

Add the method:
```go
func (p *WebClipBlockProcessor) MarkdownRepresentation(block SieveBlock) string {
	content, _ := block.Attrs["content"].(string)
	content = strings.TrimSpace(content)
	if content == "" {
		return ""
	}
	title, _ := block.Attrs["title"].(string)
	source, _ := block.Attrs["source"].(string)
	var sb strings.Builder
	if title != "" && source != "" {
		sb.WriteString("### [" + title + "](" + source + ")\n\n")
	} else if title != "" {
		sb.WriteString("### " + title + "\n\n")
	}
	sb.WriteString(content)
	return sb.String()
}
```

Note: this improves on the existing JS `promoteWebClip` which omitted the title header. The Go version is now canonical.

- [ ] **Step 5: Add `MarkdownRepresentation` to `sieve/smart_image_processor.go`**

Add `supportsPromotion: true` in `InitAttrs`.

Add the method:
```go
func (p *SmartImageProcessor) MarkdownRepresentation(block SieveBlock) string {
	src, _ := block.Attrs["src"].(string)
	if src == "" {
		return ""
	}
	alt, _ := block.Attrs["alt"].(string)
	if strings.TrimSpace(alt) == "" {
		alt, _ = block.Attrs["summary"].(string)
	}
	return "![" + strings.TrimSpace(alt) + "](" + src + ")"
}
```

- [ ] **Step 6: Add `MarkdownRepresentation` to `sieve/code_processor.go`**

Add `supportsPromotion: true` in `InitAttrs`.

Add the method:
```go
func (p *CodeBlockProcessor) MarkdownRepresentation(block SieveBlock) string {
	source, _ := block.Attrs["source"].(string)
	source = strings.TrimSpace(source)
	if source == "" {
		return ""
	}
	lang, _ := block.Attrs["language"].(string)
	return "```" + lang + "\n" + source + "\n```"
}
```

- [ ] **Step 7: Add `MarkdownRepresentation` to `sieve/smart_link_processor.go`**

SmartLink does not support promotion — it is already portable markdown. No `supportsPromotion` attr needed (defaults to `false`).

```go
func (p *SmartLinkProcessor) MarkdownRepresentation(_ SieveBlock) string {
	return ""
}
```

- [ ] **Step 8: Add `MarkdownRepresentation` to `sieve/rich_link_processor.go`**

Add `supportsPromotion: true` in `InitAttrs` (add to the attrs map in Step 3 of Task 2).

Add the method to the processor:
```go
func (p *RichLinkProcessor) MarkdownRepresentation(block SieveBlock) string {
	href, _ := block.Attrs["href"].(string)
	if href == "" {
		return ""
	}
	title, _ := block.Attrs["title"].(string)
	if strings.TrimSpace(title) == "" {
		title = href
	}
	siteName, _ := block.Attrs["siteName"].(string)
	description, _ := block.Attrs["description"].(string)

	var sb strings.Builder
	sb.WriteString("### [" + strings.TrimSpace(title) + "](" + href + ")")
	if strings.TrimSpace(siteName) != "" {
		sb.WriteString("\n*" + strings.TrimSpace(siteName) + "*")
	}
	if strings.TrimSpace(description) != "" {
		sb.WriteString("\n\n" + strings.TrimSpace(description))
	}
	return sb.String()
}
```

- [ ] **Step 9: Compile check — build must pass**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors. All processors now implement the full `BlockProcessor` interface.

- [ ] **Step 10: Run full sieve test suite**

```bash
go test -tags webkit2_41 ./sieve/... -v 2>&1 | tail -20
```

Expected: no failures.

- [ ] **Step 11: Commit**

```bash
git add sieve/processor_registry.go sieve/ai_block_processor.go sieve/web_clip_processor.go \
        sieve/smart_image_processor.go sieve/code_processor.go sieve/smart_link_processor.go \
        sieve/rich_link_processor.go
git commit -m "feat(go): add MarkdownRepresentation to BlockProcessor interface — all processors"
```

---

## Task 2C: Go — `PromoteBlock` + `EditorService.PromoteBlock` + WS handler

**Files:**
- Modify: `sieve/markdown_parser.go`
- Create: `sieve/markdown_parser_promote_test.go`
- Modify: `sieve/editor_service.go`
- Modify: `requesthandlers/ws_handler.go`

- [ ] **Step 1: Write failing tests for `PromoteBlock`**

Create `sieve/markdown_parser_promote_test.go`:

```go
package sieve

import (
	"testing"
)

func TestPromoteBlock_replacesBlockWithContent(t *testing.T) {
	markdown := "Before\n\n```rich-link\nid: ri-0001\nhref: https://example.com\n```\n\nAfter"
	// Register a minimal processor so the parser recognises rich-link
	RegisterProcessor("rich-link", NewRichLinkProcessor(BlockServices{}))
	defer UnregisterProcessor("rich-link")

	result, ok := PromoteBlock(markdown, "ri-0001", "### [Example](https://example.com)")
	if !ok {
		t.Fatal("PromoteBlock: block not found")
	}
	if result == markdown {
		t.Fatal("PromoteBlock: markdown unchanged")
	}
	if !contains(result, "### [Example](https://example.com)") {
		t.Errorf("PromoteBlock: promoted content missing; got:\n%s", result)
	}
	if contains(result, "```rich-link") {
		t.Error("PromoteBlock: fenced block still present after promotion")
	}
	if !contains(result, "Before") || !contains(result, "After") {
		t.Error("PromoteBlock: surrounding content lost")
	}
}

func TestPromoteBlock_unknownIDReturnsFalse(t *testing.T) {
	markdown := "Some content without any blocks"
	result, ok := PromoteBlock(markdown, "ri-9999", "replacement")
	if ok {
		t.Error("PromoteBlock: expected false for unknown blockID")
	}
	if result != markdown {
		t.Error("PromoteBlock: markdown must be unchanged when block not found")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		func() bool {
			for i := 0; i <= len(s)-len(substr); i++ {
				if s[i:i+len(substr)] == substr {
					return true
				}
			}
			return false
		}())
}
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
go test -tags webkit2_41 ./sieve/... -run TestPromoteBlock -v 2>&1 | head -20
```

Expected: `undefined: PromoteBlock`.

- [ ] **Step 3: Add `PromoteBlock` to `sieve/markdown_parser.go`**

Add after `InjectBlocks`:

```go
// PromoteBlock replaces the fenced sieve block with blockID in markdown with
// content (plain markdown prose). Returns the updated markdown and true if the
// block was found and replaced, or the original markdown and false if not found.
// Uses the same goldmark byte-offset splice approach as InjectBlocks.
func PromoteBlock(markdown string, blockID string, content string) (string, bool) {
	source := []byte(markdown)
	doc := mdParser().Parser().Parse(text.NewReader(source))

	var target sieveNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if sn, ok := n.(sieveNode); ok && sn.GetSieveBlock().ID == blockID {
			target = sn
			return ast.WalkStop, nil
		}
		return ast.WalkContinue, nil
	})

	if target == nil {
		return markdown, false
	}

	var out strings.Builder
	out.WriteString(markdown[:target.StartByte()])
	out.WriteString(strings.TrimSpace(content))
	out.WriteString(markdown[target.EndByte():])
	return out.String(), true
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
go test -tags webkit2_41 ./sieve/... -run TestPromoteBlock -v
```

Expected: both tests PASS.

- [ ] **Step 5: Add `EditorService.PromoteBlock` to `sieve/editor_service.go`**

Add after `HandleBlockUpdate`:

```go
// PromoteBlock replaces a sieve block in the stored document with its
// MarkdownRepresentation. Returns the promoted content string for sending
// to the client, or an error if the block is not found or does not support promotion.
func (es *EditorService) PromoteBlock(uuid, blockID string) (string, error) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return "", fmt.Errorf("promote-block: no open document for uuid %q", uuid)
	}

	shadow.mu.RLock()
	blk, ok := shadow.Blocks[blockID]
	if !ok {
		shadow.mu.RUnlock()
		return "", fmt.Errorf("promote-block: block %q not found", blockID)
	}
	blkCopy := SieveBlock{ID: blk.ID, Kind: blk.Kind, Attrs: make(map[string]interface{}, len(blk.Attrs))}
	for k, v := range blk.Attrs {
		blkCopy.Attrs[k] = v
	}
	shadow.mu.RUnlock()

	processor := GetProcessor(blkCopy.Kind)
	if processor == nil {
		return "", fmt.Errorf("promote-block: no processor for kind %q", blkCopy.Kind)
	}
	content := processor.MarkdownRepresentation(blkCopy)
	if content == "" {
		return "", fmt.Errorf("promote-block: kind %q does not support promotion", blkCopy.Kind)
	}

	shadow.mu.Lock()
	updated, found := PromoteBlock(shadow.Markdown, blockID, content)
	if found {
		shadow.Markdown = updated
	}
	shadow.mu.Unlock()

	if found {
		_ = es.Flush(uuid)
	}

	return content, nil
}
```

- [ ] **Step 6: Add `promote-block` case to `requesthandlers/ws_handler.go`**

In the `switch msg.Type` block alongside the other cases:
```go
case "promote-block":
    h.handlePromoteBlock(uuid, raw, writeMsg)
```

Add the handler function after `handleRetryBlockJob`:
```go
// handlePromoteBlock replaces a sieve block in the stored document with its
// MarkdownRepresentation and notifies the client to perform a soft reload.
func (h *WsHandler) handlePromoteBlock(uuid string, raw []byte, writeMsg func(interface{})) {
	var msg struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || msg.ID == "" {
		return
	}
	content, err := h.ServiceProvider.Editor.PromoteBlock(uuid, msg.ID)
	if err != nil {
		logger.Warn("ws: promote-block failed", "uuid", uuid, "id", msg.ID, "err", err)
		return
	}
	writeMsg(map[string]interface{}{
		"type":    "block-promoted",
		"id":      msg.ID,
		"content": content,
	})
}
```

- [ ] **Step 7: Compile check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add sieve/markdown_parser.go sieve/markdown_parser_promote_test.go \
        sieve/editor_service.go requesthandlers/ws_handler.go
git commit -m "feat(go): add PromoteBlock pipeline — markdown_parser, EditorService, WS handler"
```

---

## Task 4B: JS — Promote to Document framework

**Files:**
- Modify: `frontend/src/static/sieve-block-extension.js`
- Modify: `frontend/src/static/editor.js`
- Modify: `frontend/src/static/web-clip-renderer.js`
- Modify: `frontend/src/static/context-menu.js`

This task wires the JS side of promotion: `supportsPromotion` as a base attr, automatic menu item injection, the WS round-trip, and cleanup of the old JS-side promotion functions.

- [ ] **Step 1: Add `supportsPromotion` to `BASE_ATTRS` in `sieve-block-extension.js`**

Find the `BASE_ATTRS` object (around line 42–50). Add after `createdAt`:

```js
supportsPromotion: { default: false, parseHTML: function (el) { return el.getAttribute('data-supports-promotion') === 'true' } },
```

- [ ] **Step 2: Auto-inject "Promote to Document" in `sieve-block-extension.js`**

Find the context menu assembly section (around line 96–116). After the retry/replay block and before the `document.dispatchEvent(new CustomEvent('sieve:contextmenu', ...))` line, add:

```js
              // Promote to Document — automatic for any block with supportsPromotion: true.
              if (n.attrs.supportsPromotion && status === 'COMPLETE') {
                var IC2 = window.SieveIcons || {}
                items = items.concat([
                  { type: 'divider' },
                  { icon: IC2.promote, label: 'Promote to Document',
                    action: function () {
                      var promoteId = n.attrs.id
                      document.dispatchEvent(new CustomEvent('sieve:promote-block', {
                        detail: { id: promoteId }
                      }))
                    }
                  },
                ])
              }
```

Note: `IC` is already declared in the retry block above but only inside its `if` scope. Declare `IC2` (or move `IC` declaration before both blocks — check the existing code and do whichever is cleaner without touching unrelated lines).

- [ ] **Step 3: Add `sieve:promote-block` → WS in `editor.js`**

Find the section with `sieve:create-block`, `sieve:block-update`, `sieve:block-retry` event listeners (around line 360–370). Add alongside them:

```js
  document.addEventListener('sieve:promote-block', function (e) {
    if (!currentUuid || !e.detail || !e.detail.id) return
    wsSend({ type: 'promote-block', id: e.detail.id, uuid: currentUuid })
  })
```

- [ ] **Step 4: Handle `block-promoted` WS message in `editor.js`**

Find where incoming WS messages are dispatched (the `switch` or `if/else` block handling `insert-block`, `block-attrs-updated`, etc). Add a case for `block-promoted`:

```js
    } else if (msg.type === 'block-promoted') {
      if (!msg.id || !msg.content || !currentEditor) return
      var promotedId = msg.id
      var promotedHtml = currentEditor.storage.markdown.parser.md.render(msg.content)
      var nodePos = null
      var nodeSize = null
      currentEditor.state.doc.descendants(function (node, pos) {
        if (node.type.name.startsWith('sieve-') && node.attrs.id === promotedId) {
          nodePos = pos
          nodeSize = node.nodeSize
          return false
        }
      })
      if (nodePos !== null) {
        currentEditor.commands.insertContentAt(
          { from: nodePos, to: nodePos + nodeSize },
          promotedHtml + '<p></p>'
        )
      }
```

- [ ] **Step 5: Remove `promoteWebClip` from `web-clip-renderer.js`**

Find and delete:
1. The `promoteWebClip` function (lines 193–199)
2. The `{ icon: IC.promote, label: 'Promote to Document', disabled: ..., action: promoteWebClip }` item in `buildContextMenuItems`

The framework now auto-injects this item for Web Clip because `supportsPromotion: true` is set in `WebClipBlockProcessor.InitAttrs` (Task 2B).

- [ ] **Step 6: Update AI Block promote action in `context-menu.js`**

Find `promoteAiBlock` function (around line 291) and the menu item that calls it (around line 341).

Replace the `action` on the "Promote to Document" item:
```js
      { icon: IC.promote, label: 'Promote to Document',
        disabled: n.attrs.status !== 'COMPLETE' || !n.attrs.response,
        action: function () {
          document.dispatchEvent(new CustomEvent('sieve:promote-block', {
            detail: { id: n.attrs.id }
          }))
        }
      },
```

Delete the `promoteAiBlock` function entirely (lines 291–302).

Note: the AI Block context menu item stays in `context-menu.js` (not migrated to the framework) because `aiBlock` is a separate TipTap node type not registered via `registerSieveRenderer`. The action now uses the same WS path as all other blocks.

- [ ] **Step 7: Compile check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/static/sieve-block-extension.js frontend/src/static/editor.js \
        frontend/src/static/web-clip-renderer.js frontend/src/static/context-menu.js
git commit -m "feat(js): Promote to Document framework — base attr, auto-inject, WS soft reload"
```

---

## Task 3: Frontend — CSS styles

**Files:**
- Modify: `frontend/src/static/input.css`

Add card styles. Run Tailwind after to regenerate `tailwind.css`.

- [ ] **Step 1: Add styles to `input.css`**

Open `frontend/src/static/input.css` and append the following block at the end of the file:

```css
/* ── Rich Link Card ─────────────────────────────────────────────────────────── */

.rich-link-card {
  border: 1px solid var(--theme-border);
  border-radius: 8px;
  padding: 12px;
  margin: 4px 0;
  cursor: pointer;
  transition: border-color 0.15s ease;
  background: var(--theme-bgDark);
  max-width: 540px;
  user-select: none;
}

.rich-link-card:hover {
  border-color: var(--theme-border2);
}

.rich-link-card--pending {
  opacity: 0.7;
}

/* Row 1: link icon + site name */
.rich-link-card__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.rich-link-card__icon {
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--theme-fg3);
  flex-shrink: 0;
  font-size: 10px;
}

.rich-link-card__site {
  font-size: 11px;
  color: var(--theme-fg3);
  font-weight: 500;
  letter-spacing: 0.02em;
}

/* Row 2: thumbnail + text content */
.rich-link-card__body {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.rich-link-card__thumb {
  width: 72px;
  height: 72px;
  min-width: 72px;
  border-radius: 5px;
  background: var(--theme-bgLight);
  object-fit: cover;
  flex-shrink: 0;
}

.rich-link-card__thumb--placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--theme-fg3);
  font-size: 11px;
}

.rich-link-card__thumb--spinner {
  display: flex;
  align-items: center;
  justify-content: center;
}

.rich-link-card__content {
  flex: 1;
  min-width: 0;
}

.rich-link-card__title {
  font-weight: 600;
  color: var(--theme-accent);
  margin-bottom: 3px;
  line-height: 1.3;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.rich-link-card__description {
  font-size: 11px;
  color: var(--theme-fg2);
  line-height: 1.4;
  margin-bottom: 5px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.rich-link-card__url {
  font-size: 10px;
  color: var(--theme-fg3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Spinner reused from web-clip-block__spinner */
.rich-link-card__spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--theme-border2);
  border-top-color: var(--theme-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
```

- [ ] **Step 2: Regenerate Tailwind CSS**

```bash
cd /home/stephen/Development/projects/sieve/frontend
npx tailwindcss -i src/static/input.css -o src/static/tailwind.css
```

Expected: exits cleanly, `tailwind.css` updated timestamp.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/static/input.css frontend/src/static/tailwind.css
git commit -m "feat(css): add rich-link-card styles"
```

---

## Task 4: Frontend — `rich-link-renderer.js` + `index.html`

**Files:**
- Create: `frontend/src/static/rich-link-renderer.js`
- Modify: `frontend/src/index.html`

This is a display-only block (like web-clip). Model the file on `web-clip-renderer.js`. The context menu covers the full lifecycle; the block operations that need `currentEditor` or `wsSend` dispatch custom events caught by `editor.js` (added in Task 5).

- [ ] **Step 1: Create `frontend/src/static/rich-link-renderer.js`**

```js
// rich-link-renderer.js — Rich Link Card block renderer.
// Registers window.TipTap.registerSieveRenderer('rich-link', RichLinkRenderer)
// Renders OG metadata as a visual card block. Display-only (no editable content).

import { isJobStale } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  var RichLinkRenderer = {

    nodeConfig: { atom: true, selectable: true, draggable: false },

    attrs: {
      href:        { default: '',   parseHTML: function (el) { return el.getAttribute('data-href')        || '' } },
      title:       { default: '',   parseHTML: function (el) { return el.getAttribute('data-title')       || '' } },
      description: { default: '',   parseHTML: function (el) { return el.getAttribute('data-description') || '' } },
      image:       { default: '',   parseHTML: function (el) { return el.getAttribute('data-image')       || '' } },
      siteName:    { default: '',   parseHTML: function (el) { return el.getAttribute('data-site-name')   || '' } },
      fetchedAt:   { default: null, parseHTML: function (el) { return el.getAttribute('data-fetched-at')  || null } },
      completedAt: { default: null, parseHTML: function (el) { return el.getAttribute('data-completed-at') || null } },
      error:       { default: null, parseHTML: function (el) { return el.getAttribute('data-error')        || null } },
    },

    parseAttrs: function (data) {
      return {
        href:        data.href        || '',
        title:       data.title       || '',
        description: data.description || '',
        image:       data.image       || '',
        siteName:    data.siteName    || '',
        fetchedAt:   data.fetchedAt   || null,
        completedAt: data.completedAt || null,
        error:       data.error       || null,
      }
    },

    makeNodeView: function (node, editor) {
      var dom = document.createElement('div')
      dom.className = 'rich-link-card'
      dom.contentEditable = 'false'
      dom.setAttribute('data-rich-link-id', node.attrs.id || '')

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })
      dom.addEventListener('mousedown', function (e) { e.stopPropagation() })

      dom.addEventListener('click', function (e) {
        if (window.isMod && window.isMod(e)) {
          var href = node.attrs.href
          if (href && window.runtime && window.runtime.BrowserOpenURL) {
            window.runtime.BrowserOpenURL(href)
          }
        }
      })

      function render(n) {
        dom.innerHTML = ''
        dom.setAttribute('data-rich-link-id', n.attrs.id || '')

        var status = n.attrs.status || 'PENDING'
        var isPending = status === 'PENDING' || status === 'DISPATCHED'
        var stale = isPending && isJobStale(n.attrs.createdAt, n.attrs.id)

        dom.classList.toggle('rich-link-card--pending', isPending && !stale)

        // Row 1: link icon + site name
        var meta = document.createElement('div')
        meta.className = 'rich-link-card__meta'
        var icon = document.createElement('span')
        icon.className = 'rich-link-card__icon'
        icon.textContent = '🔗'
        var site = document.createElement('span')
        site.className = 'rich-link-card__site'
        site.textContent = isPending ? extractDomain(n.attrs.href || '') : (n.attrs.siteName || extractDomain(n.attrs.href || ''))
        meta.appendChild(icon)
        meta.appendChild(site)
        dom.appendChild(meta)

        // Row 2: thumbnail + content
        var body = document.createElement('div')
        body.className = 'rich-link-card__body'

        // Thumbnail column
        var thumb = document.createElement('div')
        thumb.className = 'rich-link-card__thumb'
        if (isPending) {
          thumb.classList.add('rich-link-card__thumb--spinner')
          var spinner = document.createElement('span')
          spinner.className = 'rich-link-card__spinner'
          thumb.appendChild(spinner)
        } else if (n.attrs.image) {
          thumb.classList.add('rich-link-card__thumb--placeholder')
          var img = document.createElement('img')
          img.src = n.attrs.image
          img.alt = n.attrs.title || ''
          img.className = 'rich-link-card__thumb'
          img.style.cssText = 'width:72px;height:72px;object-fit:cover;border-radius:5px;'
          // Replace the div with the img
          body.appendChild(img)
          thumb = null
        } else {
          thumb.classList.add('rich-link-card__thumb--placeholder')
          thumb.textContent = '🔗'
        }
        if (thumb) body.appendChild(thumb)

        // Text content column
        var content = document.createElement('div')
        content.className = 'rich-link-card__content'

        var titleEl = document.createElement('div')
        titleEl.className = 'rich-link-card__title'
        titleEl.textContent = isPending ? (n.attrs.href || '…') : (n.attrs.title || n.attrs.href || '…')
        content.appendChild(titleEl)

        if (!isPending && n.attrs.description) {
          var descEl = document.createElement('div')
          descEl.className = 'rich-link-card__description'
          descEl.textContent = n.attrs.description
          content.appendChild(descEl)
        }

        var urlEl = document.createElement('div')
        urlEl.className = 'rich-link-card__url'
        urlEl.textContent = extractDomain(n.attrs.href || '')
        content.appendChild(urlEl)

        body.appendChild(content)
        dom.appendChild(body)
      }

      render(node)

      return {
        dom: dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieve-rich-link') return false
          render(updatedNode)
          return true
        },
        ignoreMutation: function () { return true },
        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },
      }
    },

    buildContextMenuItems: function (opts) {
      var node   = opts.node
      var editor = opts.editor
      var getPos = opts.getPos
      var IC     = window.SieveIcons || {}
      var href   = node.attrs.href  || ''
      var title  = node.attrs.title || href
      var id     = node.attrs.id    || ''

      function deleteBlock() {
        if (typeof getPos === 'function') {
          var pos = getPos()
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
        }
      }

      return [
        { type: 'header', label: 'Rich Link' },
        {
          icon: IC.externalLink,
          label: 'Open URL',
          action: function () {
            if (href && window.runtime && window.runtime.BrowserOpenURL) {
              window.runtime.BrowserOpenURL(href)
            }
          },
        },
        {
          icon: IC.globe,
          label: 'Upgrade to Web Clip',
          action: function () {
            if (typeof getPos !== 'function') return
            var pos = getPos()
            var size = node.nodeSize
            document.dispatchEvent(new CustomEvent('sieve:upgrade-to-web-clip', {
              detail: { href: href, fromPos: pos, fromSize: size }
            }))
          },
        },
        { type: 'divider' },
        {
          icon: IC.edit,
          label: 'Edit Link…',
          action: function () {
            document.dispatchEvent(new CustomEvent('sieve:rich-link-edit', {
              detail: { id: id, href: href, title: title, getPos: getPos, editor: editor }
            }))
          },
        },
        {
          icon: IC.refresh,
          label: 'Refresh Metadata',
          action: function () {
            document.dispatchEvent(new CustomEvent('sieve:block-retry', { detail: { id: id } }))
          },
        },
        {
          icon: IC.copy,
          label: 'Copy URL',
          action: function () {
            if (href) navigator.clipboard.writeText(href).catch(function () {})
          },
        },
        { type: 'divider' },
        {
          icon: IC.arrowDown,
          label: 'Downgrade to Smart Link',
          action: function () {
            if (typeof getPos !== 'function') return
            var pos = getPos()
            var size = node.nodeSize
            editor.chain()
              .command(function (props) {
                props.tr.delete(pos, pos + size)
                return true
              })
              .insertContentAt(pos, {
                type: 'paragraph',
                content: [{
                  type: 'sieve-smart-link',
                  attrs: {
                    href: href,
                    label: title,
                    status: 'COMPLETE',
                    completedAt: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    error: null,
                  }
                }]
              })
              .run()
          },
        },
        // NOTE: "Promote to Document" is NOT listed here.
        // sieve-block-extension.js auto-injects it for any block with
        // node.attrs.supportsPromotion === true (set in RichLinkProcessor.InitAttrs).
        // Do not add a manual item — it would duplicate the framework-injected one.
        {
          icon: IC.fileText,
          label: 'Promote to Document — REMOVE THIS BLOCK — handled by framework',
          action: function () {
            if (typeof getPos !== 'function') return
            var pos = getPos()
            var size = node.nodeSize
            var t = node.attrs.title || href
            var s = node.attrs.siteName
            var d = node.attrs.description

            var content = [
              {
                type: 'heading',
                attrs: { level: 3 },
                content: [{ type: 'text', marks: [{ type: 'link', attrs: { href: href, target: null } }], text: t }]
              }
            ]
            if (s) {
              content.push({ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'italic' }], text: s }] })
            }
            if (d) {
              content.push({ type: 'paragraph', content: [{ type: 'text', text: d }] })
            }

            editor.chain()
              .command(function (props) {
                props.tr.delete(pos, pos + size)
                return true
              })
              .insertContentAt(pos, content)
              .run()
          },
        },
        { type: 'divider' },
        { icon: IC.trash, label: 'Delete', action: deleteBlock },
      ]
    },
  }

  T.registerSieveRenderer('rich-link', RichLinkRenderer)

  // ── Edit dialog ──────────────────────────────────────────────────────────────

  var editDialog = null

  function getEditDialog() {
    if (editDialog) return editDialog

    var dlg = document.createElement('dialog')
    dlg.className = 'ask-popup rich-link-edit-popup'

    var header = document.createElement('div')
    header.className = 'ask-popup__header'
    var titleLabel = document.createElement('span')
    titleLabel.className = 'ask-popup__label'
    titleLabel.textContent = 'Edit Link'
    var closeBtn = document.createElement('button')
    closeBtn.className = 'ask-popup__close'
    closeBtn.textContent = '✕'
    closeBtn.addEventListener('click', function () { dlg.close() })
    header.appendChild(titleLabel)
    header.appendChild(closeBtn)

    var hrefInput = document.createElement('input')
    hrefInput.type = 'url'
    hrefInput.className = 'smart-link-edit-popup__input'
    hrefInput.placeholder = 'URL (https://…)'

    var labelInput = document.createElement('input')
    labelInput.type = 'text'
    labelInput.className = 'smart-link-edit-popup__input'
    labelInput.placeholder = 'Display title'

    var footer = document.createElement('div')
    footer.className = 'ask-popup__footer'
    var saveBtn = document.createElement('button')
    saveBtn.className = 'ask-popup__send'
    saveBtn.textContent = 'Save'
    footer.appendChild(saveBtn)

    dlg.appendChild(header)
    dlg.appendChild(hrefInput)
    dlg.appendChild(labelInput)
    dlg.appendChild(footer)
    document.body.appendChild(dlg)

    dlg.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); dlg.close() }
      if (e.key === 'Enter')  { e.preventDefault(); dlg._save() }
    })
    saveBtn.addEventListener('click', function () { dlg._save() })

    editDialog = dlg
    return dlg
  }

  document.addEventListener('sieve:rich-link-edit', function (e) {
    var detail = e.detail
    var dlg = getEditDialog()
    var inputs = dlg.querySelectorAll('.smart-link-edit-popup__input')
    inputs[0].value = detail.href  || ''
    inputs[1].value = detail.title || ''

    dlg._save = function () {
      var newHref  = inputs[0].value.trim()
      var newTitle = inputs[1].value.trim() || newHref
      if (!newHref) return
      document.dispatchEvent(new CustomEvent('sieve:block-update', {
        detail: { id: detail.id, kind: 'rich-link', attrs: { href: newHref, title: newTitle } }
      }))
      dlg.close()
    }

    dlg.showModal()
    requestAnimationFrame(function () { inputs[0].select() })
  })

  function extractDomain(url) {
    try { return new URL(url).hostname } catch (_) { return url }
  }

})()
```

- [ ] **Step 2: Add script tag to `frontend/src/index.html`**

Find the block of renderer script tags (around line 148–153):
```html
    <script type="module" src="/static/smart-image-renderer.js"></script>
```

Add immediately after that line:
```html
    <script type="module" src="/static/rich-link-renderer.js"></script>
```

- [ ] **Step 3: Compile check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/rich-link-renderer.js frontend/src/index.html
git commit -m "feat(js): add rich-link-renderer with card NodeView and context menu"
```

---

## Task 5: Frontend — `editor.js` event handlers + Ctrl+Shift+L dialog

**Files:**
- Modify: `frontend/src/static/editor.js`

Three additions to `editor.js`:
1. `createRichLinkDialog` + `openRichLinkDialog` (Ctrl+Shift+L entry point)
2. `sieve:enrich-as-card` handler (SmartLink right-click → card)
3. `sieve:upgrade-to-web-clip` handler (Rich Link Card → Web Clip)

Note: `sieve:promote-block` WS send and `block-promoted` soft-reload handler were added in Task 4B. Do not re-add them here.

All additions go inside the existing IIFE (before the closing `})()` at line 1091).

- [ ] **Step 1: Add `richLinkDialog` variable declaration**

Find the existing dialog variable declarations at the top of the IIFE (around line 26):
```js
  var internalizeDialog = null
```

Add on the next line:
```js
  var richLinkDialog = null
```

- [ ] **Step 2: Add `createRichLinkDialog` and `openRichLinkDialog` functions**

Find the `// ── Internalize dialog` section (around line 527). Add the following block immediately before it:

```js
  // ── Rich Link dialog ──────────────────────────────────────────────────────────

  function createRichLinkDialog() {
    var dialog = document.createElement('dialog')
    dialog.className = 'internalize-popup ask-popup'
    dialog.style.cssText = 'top:30%;bottom:auto;left:50%;width:460px;max-width:92vw;'

    var header = document.createElement('div'); header.className = 'ask-popup__header'
    var label = document.createElement('span'); label.className = 'ask-popup__label'; label.textContent = 'Insert Link Card'
    var closeBtn = makeBtn('ask-popup__close', '✕', function () { dialog.close() })
    closeBtn.title = 'Close (Esc)'
    header.appendChild(label); header.appendChild(closeBtn)

    var urlInput = document.createElement('input')
    urlInput.type = 'url'
    urlInput.className = 'internalize-popup__input'
    urlInput.placeholder = 'https://…'

    var errorMsg = document.createElement('div')
    errorMsg.className = 'internalize-popup__error'
    errorMsg.textContent = 'Please enter a valid http:// or https:// URL'
    errorMsg.style.display = 'none'

    urlInput.addEventListener('input', function () { errorMsg.style.display = 'none' })

    function trySubmit() {
      var url = urlInput.value.trim()
      if (!isValidURL(url)) { errorMsg.style.display = ''; return }
      doCreateRichLink(url)
      dialog.close()
    }

    var footer = document.createElement('div'); footer.className = 'ask-popup__footer'
    var insertBtn = makeBtn('internalize-popup__btn', 'Insert Card', trySubmit)
    footer.appendChild(insertBtn)

    urlInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); dialog.close() }
      if (e.key === 'Enter') { e.preventDefault(); trySubmit() }
    })

    dialog.appendChild(header)
    dialog.appendChild(urlInput)
    dialog.appendChild(errorMsg)
    dialog.appendChild(footer)
    document.body.appendChild(dialog)
    return dialog
  }

  function openRichLinkDialog(prefillUrl) {
    if (!richLinkDialog) return
    var urlInput = richLinkDialog.querySelector('input')
    if (urlInput) urlInput.value = prefillUrl || ''
    if (!richLinkDialog.open) richLinkDialog.showModal()
    if (urlInput) urlInput.focus()
  }

  function doCreateRichLink(href) {
    if (!currentUuid) return
    if (!currentEditor && currentMode !== 'markdown') return
    sieveInsertPos = currentEditor ? currentEditor.state.selection.to : null
    wsSend({ type: 'create-block', kind: 'rich-link', attrs: { href: href }, uuid: currentUuid })
  }
```

- [ ] **Step 3: Add `richLinkDialog` to `ensureOverlays`**

Find `ensureOverlays` (around line 460):
```js
  function ensureOverlays() {
    if (!askDialog) askDialog = createAskDialog()
    if (!searchOverlay) searchOverlay = createSearchOverlay()
    if (!internalizeDialog) internalizeDialog = createInternalizeDialog()
  }
```

Add the rich link dialog initialization:
```js
  function ensureOverlays() {
    if (!askDialog) askDialog = createAskDialog()
    if (!searchOverlay) searchOverlay = createSearchOverlay()
    if (!internalizeDialog) internalizeDialog = createInternalizeDialog()
    if (!richLinkDialog) richLinkDialog = createRichLinkDialog()
  }
```

- [ ] **Step 4: Add Ctrl+Shift+L keyboard shortcut**

Find the existing keyboard shortcut handler at the end of the IIFE (around line 1081):
```js
  document.addEventListener('keydown', function (e) {
    if (e.key === 'W' && window.isMod(e) && e.shiftKey && !e.altKey) {
      e.preventDefault()
      ensureOverlays()
      openInternalizeDialog()
    }
  })
```

Add an `L` shortcut immediately after the `W` block inside the same listener (replace the whole listener with):
```js
  document.addEventListener('keydown', function (e) {
    if (e.key === 'W' && window.isMod(e) && e.shiftKey && !e.altKey) {
      e.preventDefault()
      ensureOverlays()
      openInternalizeDialog()
    }
    if (e.key === 'L' && window.isMod(e) && e.shiftKey && !e.altKey) {
      e.preventDefault()
      ensureOverlays()
      openRichLinkDialog()
    }
  })
```

- [ ] **Step 5: Add `sieve:enrich-as-card` event handler**

This is fired by the SmartLink context menu "Enrich as Card". It inserts a `rich-link` block at a specified position and deletes the SmartLink node.

Add the following listener inside the IIFE, just before the closing `window.sieveInitEditor = initEditor` line (around line 1089):

```js
  // ── Enrich as Card (SmartLink → Rich Link) ────────────────────────────────────
  // Fired by smart-link-renderer.js when user right-clicks a SmartLink and selects
  // "Enrich as Card". Inserts a rich-link block at insertPos, then removes the
  // SmartLink inline node. The SmartLink is removed BEFORE the create-block WS
  // message so sieveInsertPos corresponds to the correct post-deletion position.
  document.addEventListener('sieve:enrich-as-card', function (e) {
    if (!currentUuid || !currentEditor) return
    var href = e.detail.href
    var title = e.detail.title || href
    var insertPos = e.detail.insertPos  // position AFTER smart-link deletion
    if (!href) return
    sieveInsertPos = insertPos
    wsSend({ type: 'create-block', kind: 'rich-link', attrs: { href: href, title: title }, uuid: currentUuid })
  })

  // ── Upgrade to Web Clip (Rich Link → Web Clip) ────────────────────────────────
  // Fired by rich-link-renderer.js context menu "Upgrade to Web Clip".
  document.addEventListener('sieve:upgrade-to-web-clip', function (e) {
    if (!currentUuid || !currentEditor) return
    var href = e.detail.href
    var fromPos = e.detail.fromPos
    var fromSize = e.detail.fromSize
    if (!href || fromPos == null) return
    // Delete the rich-link block first, then insert web-clip at its position
    currentEditor.view.dispatch(currentEditor.state.tr.delete(fromPos, fromPos + fromSize))
    sieveInsertPos = fromPos
    wsSend({ type: 'create-block', kind: 'web-clip', attrs: { source: href, mode: 'fetch' }, uuid: currentUuid })
  })
```

- [ ] **Step 6: Compile check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(js): add Ctrl+Shift+L dialog and enrich/upgrade event handlers"
```

---

## Task 6: Frontend — SmartLink "Enrich as Card" context menu item

**Files:**
- Modify: `frontend/src/static/smart-link-renderer.js`

Add "Enrich as Card" to the SmartLink context menu. When triggered: delete the SmartLink inline node, then dispatch `sieve:enrich-as-card` with the post-deletion insert position so the card appears where the link was.

- [ ] **Step 1: Add "Enrich as Card" item to `buildContextMenuItems`**

Open `frontend/src/static/smart-link-renderer.js`. Find `buildContextMenuItems` (around line 93). Find the current `return [` array. The existing items are:

```js
      return [
        { type: 'header', label: 'Smart Link' },
        {
          icon: IC.externalLink,
          label: 'Open URL',
          ...
        },
        {
          icon: IC.copy,
          label: 'Copy URL',
          ...
        },
        {
          icon: IC.edit,
          label: 'Edit…',
          ...
        },
        { type: 'divider' },
        { icon: IC.trash, label: 'Delete', action: del },
      ]
```

Replace with (adds "Enrich as Card" after the divider, before Delete):

```js
      return [
        { type: 'header', label: 'Smart Link' },
        {
          icon: IC.externalLink,
          label: 'Open URL',
          action: function () {
            if (href && window.runtime && window.runtime.BrowserOpenURL) {
              window.runtime.BrowserOpenURL(href)
            }
          },
        },
        {
          icon: IC.copy,
          label: 'Copy URL',
          action: function () {
            if (href) navigator.clipboard.writeText(href).catch(function () {})
          },
        },
        {
          icon: IC.edit,
          label: 'Edit…',
          action: function () {
            if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
            document.dispatchEvent(new CustomEvent('sieve:smart-link-edit', {
              detail: { id: node.attrs.id, href: href, label: label, getPos: getPos, editor: editor }
            }))
          },
        },
        {
          icon: IC.sparkle,
          label: 'Enrich as Card',
          action: function () {
            if (typeof getPos !== 'function') return
            var pos = getPos()
            var nodeSize = node.nodeSize
            // Resolve insert position BEFORE deleting (positions shift after deletion).
            // The card is block-level so it should land after the containing paragraph.
            // Use the end of the containing block as the target.
            var $pos = editor.state.doc.resolve(pos)
            var blockEnd = $pos.end($pos.depth)  // end of the paragraph wrapping the smart-link
            // Delete the smart-link inline node
            editor.view.dispatch(editor.state.tr.delete(pos, pos + nodeSize))
            // After deletion, the block end shifts by -nodeSize (the deleted inline).
            // If the paragraph is now empty it will still exist; insert after it.
            var insertPos = blockEnd - nodeSize
            document.dispatchEvent(new CustomEvent('sieve:enrich-as-card', {
              detail: { href: href, title: label, insertPos: insertPos }
            }))
          },
        },
        { type: 'divider' },
        { icon: IC.trash, label: 'Delete', action: del },
      ]
```

- [ ] **Step 2: Compile check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/static/smart-link-renderer.js
git commit -m "feat(js): add 'Enrich as Card' to SmartLink context menu"
```

---

## Task 7: Smoke Test

Manual verification. Run `wails dev` and exercise the feature end to end.

- [ ] **Step 1: Start dev server**

```bash
wails dev
```

- [ ] **Step 2: Test Ctrl+Shift+L → Insert Card**

1. Open a document
2. Press `Ctrl+Shift+L`
3. Verify the "Insert Link Card" dialog appears
4. Enter `https://github.com/anthropics/claude-code` and press Enter
5. Verify a card block appears with a spinner in the thumbnail area
6. Wait ~5–8 seconds
7. Verify the card updates: site name "github.com", title, description, and (if OG image was found) a thumbnail

- [ ] **Step 3: Test right-click SmartLink → Enrich as Card**

1. Paste a bare URL into a document (e.g. `https://example.com`) — it should become a SmartLink inline node after a moment
2. Right-click the SmartLink
3. Verify "Enrich as Card" appears in the context menu
4. Click it
5. Verify the SmartLink disappears and a Rich Link Card appears in its place

- [ ] **Step 4: Test context menu — Open URL**

1. Right-click a completed Rich Link Card
2. Click "Open URL"
3. Verify browser opens the URL

- [ ] **Test 5: Test Refresh Metadata**

1. Right-click a completed card
2. Click "Refresh Metadata"
3. Verify the card shows a spinner briefly, then updates

- [ ] **Step 6: Test Downgrade to Smart Link**

1. Right-click a completed card
2. Click "Downgrade to Smart Link"
3. Verify the card is replaced by an inline SmartLink with the card's title as its label

- [ ] **Step 7: Test Promote to Document**

1. Right-click a completed card that has a title, site name, and description
2. Click "Promote to Document"
3. Verify the card is replaced by:
   - An H3 heading linking to the URL with the card's title
   - An italic paragraph with the site name
   - A plain paragraph with the description

- [ ] **Step 8: Test Upgrade to Web Clip**

1. Right-click a completed card
2. Click "Upgrade to Web Clip"
3. Verify the card is replaced by a Web Clip block fetching from the same URL

- [ ] **Step 9: Test Promote to Document — Rich Link Card**

1. Right-click a completed Rich Link Card
2. Click "Promote to Document" (injected by the framework, not by the renderer)
3. Verify the card is replaced by:
   - An H3 heading linking to the URL with the card's title
   - An italic line with the site name
   - A paragraph with the description
4. Verify the underlying markdown file (check with Ctrl+Shift+M markdown view) no longer contains the `rich-link` fenced block

- [ ] **Step 10: Test Promote to Document — Web Clip**

1. Right-click a completed Web Clip
2. Click "Promote to Document"
3. Verify the Web Clip is replaced by an H3 heading `[Title](url)` followed by the fetched content as prose
4. Verify the underlying markdown no longer contains the `web-clip` fenced block

- [ ] **Step 11: Test Promote to Document — AI Block**

1. Right-click a completed AI Block
2. Click "Promote to Document"
3. Verify the AI Block is replaced by an H3 of the question followed by the response as prose
4. Verify the underlying markdown no longer contains the `ai-block` fenced block

- [ ] **Step 12: Commit smoke test**

If all steps passed, no code changes needed. If fixes were required, commit them before proceeding.

---

## Self-Review Notes

- `isJobStale` is imported from `fenced-block-base.js` — verify it's used in `rich-link-renderer.js` (Task 4). ✓
- `sieve-rich-link` is the TipTap node type name — matches `registerSieveRenderer('rich-link', ...)` because the factory prefixes `sieve-`. Verify `update()` check uses `'sieve-rich-link'`. ✓
- `rich-link` ID prefix: `GenerateBlockIDFor('rich-link')` will call `GenerateBlockID('ri')` (first two chars) → IDs like `ri-a3f9`. ✓
- `attrs` and `parseAttrs` keys must match exactly: `href, title, description, image, siteName, supportsPromotion, fetchedAt, completedAt, error`. ✓
- `supportsPromotion` must be in both `attrs` and `parseAttrs` in `rich-link-renderer.js` so the framework can read it from the node. ✓ (verify — it's easy to miss)
- `var thumb = null` pattern in `makeNodeView` render function: when an image IS present, the `<img>` element is appended directly to `body` and `thumb` is set to null to skip the second `body.appendChild(thumb)`. Verify this renders correctly — if buggy, use an `if (thumb)` guard (already present). ✓
- The `sieve:enrich-as-card` pos arithmetic: `blockEnd - nodeSize`. A SmartLink inline atom has `nodeSize` = 1. The paragraph end pos shifts by -1 after deletion. Acceptable; test in smoke test.
- Task 4B Step 2: `IC` vs `IC2` — check the scoping of `var IC = window.SieveIcons || {}` in `sieve-block-extension.js`. If `IC` is declared inside the `if (isStale || isError || status === 'COMPLETE')` block, it is block-scoped (`var` is function-scoped in JS, so actually available). Using `IC` directly in the promote block should work — verify and remove `IC2` if redundant.
