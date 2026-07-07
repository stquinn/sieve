# Promotion Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `PasteMatch` with `IsBlock`+`Transform`, rename `PasteEntry` → `ContentEntry`, and add the Extract framework: `/api/detect-extractions` endpoint, `extract` WS handler, JS DOM walk, context-aware menu header, and `resolveEntries` hook.

**Architecture:** The `BlockProcessor` interface gains `IsBlock` (fast boolean detection) and `Transform` (attr extraction), replacing the single `PasteMatch`. A new `DetectExtractions` registry function runs `IsBlock` across all processors to power a new HTTP endpoint. A new `extract` WS message type mirrors the paste flow but with a pre-selected processor. On the JS side, right-click fires a DOM walk to classify the clicked element as a `ContentEntry`, calls `detect-extractions`, and shows contextual "Extract as…" menu items. A `resolveEntries` hook on target renderers allows async transformation (e.g. mermaid→SVG) before the WS event is sent.

**Tech Stack:** Go (chi router, processor registry), vanilla JS ES modules, existing WS infrastructure

**Robustness Principle (Postel's Law):** The JS client sends MIME types as accurately as possible — `text/plain` for text content, `text/uri-list` for URLs, `image/svg+xml` for SVG, `image/*` for binary blobs. The Go `IsBlock` implementations are tolerant of what they accept — text-pattern processors (Diagram, Code, SmartLink) check content only and do not gate on MIME type. A wrong MIME type must never cause a paste or extract to silently fail. MIME type is used as a primary signal only where content alone is insufficient (binary image blobs in SmartImageProcessor).

**Spec:** `docs/design/archive/2026-06-08-sieve-block-promotion-framework.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `sieve/processor_registry.go` | Modify | Rename `PasteEntry`→`ContentEntry`; replace `PasteMatch` with `IsBlock`+`Transform` in interface; add `DetectExtractions` |
| `sieve/editor_service.go` | Modify | Update `HandlePaste` to use `IsBlock`+`Transform`; add `CreateBlockFromEntries` |
| `sieve/code_processor.go` | Modify | Migrate `PasteMatch` → `IsBlock` + `Transform` |
| `sieve/web_clip_processor.go` | Modify | Migrate `PasteMatch` → `IsBlock` + `Transform` |
| `sieve/smart_link_processor.go` | Modify | Migrate `PasteMatch` → `IsBlock` + `Transform` |
| `sieve/rich_link_processor.go` | Modify | Migrate `PasteMatch` → `IsBlock` + `Transform` |
| `sieve/shared_patterns.go` | Create | Package-level shared regex vars used by multiple processors |
| `sieve/smart_image_processor.go` | Modify | Migrate `PasteMatch` → `IsBlock` + `Transform`; add mermaid detection to `IsBlock` |
| `sieve/ai_block_processor.go` | Modify | Migrate `PasteMatch` → `IsBlock` + `Transform` |
| `sieve/diagram_processor.go` | Modify | Migrate `PasteMatch` → `IsBlock` + `Transform` |
| `sieve/*_processor_test.go` | Modify | Update test names/signatures to match new interface |
| `requesthandlers/extraction_handler.go` | Create | `POST /api/detect-extractions` endpoint |
| `requesthandlers/ws_handler.go` | Modify | Add `case "extract":` + `handleExtract` |
| `requesthandlers/editor_handler.go` | Modify | Update `[]sieve.PasteEntry` → `[]sieve.ContentEntry` |
| `handlers.go` | Modify | Register `ExtractionHandler` |
| `frontend/src/static/sieve-block-extension.js` | Modify | DOM walk; context-aware header; async detect-extractions; Extract section; `resolveEntries` default; `sieve:extract` dispatch; rename "Embed in document" |
| `frontend/src/static/editor.js` | Modify | Add `sieve:extract` WS listener |
| `frontend/src/static/diagram-renderer.js` | Modify | Export `ensureMermaid` and `renderMermaidToSvg` |
| `frontend/src/static/smart-image-renderer.js` | Modify | Add `resolveEntries` override for mermaid→SVG |

---

## Task 1: Rename PasteEntry → ContentEntry

**Files:**
- Modify: `sieve/processor_registry.go`
- Modify: `sieve/editor_service.go`
- Modify: `requesthandlers/editor_handler.go`
- Modify: all `sieve/*_processor.go` files (signature-only change)
- Modify: all `sieve/*_processor_test.go` files (type reference change)

This is a pure rename — no logic changes. The interface method `PasteMatch` signature still uses the type; it will be replaced in Task 2.

- [ ] **Step 1.1 — Rename the type in `sieve/processor_registry.go`**

Replace lines 10-14:
```go
// ContentEntry is one item from the browser clipboard DataTransfer,
// or a content-model description of a DOM element for extraction detection.
type ContentEntry struct {
	MIMEType string `json:"mimeType"`
	Content  string `json:"content"`
}
```

Update the interface comment (lines 53-56) to reference `ContentEntry`:
```go
// Transform receives uuid and blockID so processors that need to persist
// assets synchronously (e.g. smart-image) can do so with the correct ID
// before CreateBlock is called.
```

Update the `PasteMatch` signature in the interface (line 62) — change parameter type only, keep name for now:
```go
PasteMatch(entries []ContentEntry, uuid string, blockID string) (matched bool, overrides map[string]interface{})
```

- [ ] **Step 1.2 — Update editor_handler.go**

In `requesthandlers/editor_handler.go` line 135, change:
```go
Entries []sieve.ContentEntry `json:"entries"`
```

- [ ] **Step 1.3 — Update all processor method signatures**

In each of the following files, change `[]PasteEntry` to `[]ContentEntry` in the `PasteMatch` method signature only:
- `sieve/code_processor.go`
- `sieve/web_clip_processor.go`
- `sieve/smart_link_processor.go`
- `sieve/rich_link_processor.go`
- `sieve/smart_image_processor.go`
- `sieve/ai_block_processor.go`
- `sieve/diagram_processor.go`

Also update `sieve/editor_service.go` — find `[]PasteEntry` in `HandlePaste` and change to `[]ContentEntry`.

- [ ] **Step 1.4 — Update test files**

In each `sieve/*_processor_test.go`, change any literal `PasteEntry{` to `ContentEntry{`.

- [ ] **Step 1.5 — Build check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors. If you see `undefined: PasteEntry`, grep for remaining references:
```bash
grep -rn "PasteEntry" /home/stephen/Development/projects/sieve/sieve/
```

- [ ] **Step 1.6 — Run tests**

```bash
go test -tags webkit2_41 ./sieve/... -v 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 1.7 — Commit**

```bash
git add -p
git commit -m "refactor: rename PasteEntry → ContentEntry"
```

---

## Task 2: Split PasteMatch → IsBlock + Transform

**Files:**
- Modify: `sieve/processor_registry.go`
- Modify: `sieve/editor_service.go`
- Modify: all 7 processor files
- Modify: all processor test files

- [ ] **Step 2.1 — Update the BlockProcessor interface**

In `sieve/processor_registry.go`, replace the `PasteMatch` line in the interface with:

```go
// IsBlock returns true if this processor can create a block from entries.
// Pure detection — no side effects, no asset creation.
IsBlock(entries []ContentEntry) bool

// Transform produces the attrs overrides map from entries.
// Called only after IsBlock returns true.
// Receives uuid and blockID so processors that save assets synchronously
// (e.g. SmartImageProcessor) can do so with the correct ID.
// Should call IsBlock defensively and return nil if entries are not handled.
Transform(entries []ContentEntry, uuid string, blockID string) map[string]interface{}
```

Remove `PasteMatch` from the interface entirely.

- [ ] **Step 2.2 — Add DetectExtractions to processor_registry.go**

Add after `GetProcessor`:

```go
// ExtractionCandidate is one result from DetectExtractions.
type ExtractionCandidate struct {
	Kind string `json:"kind"`
}

// DetectExtractions runs IsBlock on every registered processor except sourceKind
// and returns the kinds that match. Used by /api/detect-extractions.
func DetectExtractions(sourceKind string, entries []ContentEntry) []ExtractionCandidate {
	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	var results []ExtractionCandidate
	for _, pm := range matchers {
		if pm.Kind == sourceKind {
			continue
		}
		if pm.Processor.IsBlock(entries) {
			results = append(results, ExtractionCandidate{Kind: pm.Kind})
		}
	}
	return results
}
```

- [ ] **Step 2.3 — Migrate DiagramProcessor**

In `sieve/diagram_processor.go`, replace `PasteMatch` with:

```go
// Tolerant of MIME type — content pattern is the authority (Postel's Law).
func (p *DiagramProcessor) IsBlock(entries []ContentEntry) bool {
	for _, e := range entries {
		if mermaidFenceRe.MatchString(strings.TrimSpace(e.Content)) {
			return true
		}
	}
	return false
}

func (p *DiagramProcessor) Transform(entries []ContentEntry, _ string, _ string) map[string]interface{} {
	if !p.IsBlock(entries) {
		return nil
	}
	for _, e := range entries {
		m := mermaidFenceRe.FindStringSubmatch(strings.TrimSpace(e.Content))
		if m != nil {
			return map[string]interface{}{
				"source": strings.TrimSpace(m[1]),
				"mode":   "render",
			}
		}
	}
	return nil
}
```

- [ ] **Step 2.4 — Migrate CodeBlockProcessor**

In `sieve/code_processor.go`, replace `PasteMatch` with:

```go
// Tolerant of MIME type — content pattern is the authority (Postel's Law).
// Skips binary entries (image/*) where content is not text.
func (p *CodeBlockProcessor) IsBlock(entries []ContentEntry) bool {
	for _, e := range entries {
		if strings.HasPrefix(e.MIMEType, "image/") {
			continue
		}
		trimmed := strings.TrimSpace(e.Content)
		if trimmed == "" {
			continue
		}
		if codeFenceRe.MatchString(trimmed) {
			return true
		}
		if strings.Contains(trimmed, "\n") {
			if _, ok := detectByHeuristics(trimmed, ""); ok {
				return true
			}
			if looksLikeCode(trimmed) {
				return true
			}
		}
	}
	return false
}

func (p *CodeBlockProcessor) Transform(entries []ContentEntry, uuid string, blockID string) map[string]interface{} {
	if !p.IsBlock(entries) {
		return nil
	}
	for _, e := range entries {
		if strings.HasPrefix(e.MIMEType, "image/") {
			continue
		}
		trimmed := strings.TrimSpace(e.Content)
		if m := codeFenceRe.FindStringSubmatch(trimmed); m != nil {
			overrides := map[string]interface{}{"source": m[2]}
			if m[1] != "" {
				overrides["hint"] = m[1]
			}
			return overrides
		}
		if strings.Contains(trimmed, "\n") {
			if _, ok := detectByHeuristics(trimmed, ""); ok {
				return map[string]interface{}{"source": trimmed}
			}
			if looksLikeCode(trimmed) {
				return map[string]interface{}{"source": trimmed}
			}
		}
	}
	return nil
}
```

- [ ] **Step 2.5 — Migrate SmartLinkProcessor**

In `sieve/smart_link_processor.go`, replace `PasteMatch` with:

```go
// Tolerant of MIME type — URL pattern in content is the authority (Postel's Law).
func (p *SmartLinkProcessor) IsBlock(entries []ContentEntry) bool {
	for _, e := range entries {
		trimmed := strings.TrimSpace(e.Content)
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
			continue
		}
		if strings.ContainsAny(trimmed, " \t\n\r") {
			continue
		}
		return true
	}
	return false
}

func (p *SmartLinkProcessor) Transform(entries []ContentEntry, _ string, _ string) map[string]interface{} {
	if !p.IsBlock(entries) {
		return nil
	}
	for _, e := range entries {
		trimmed := strings.TrimSpace(e.Content)
			if (strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://")) &&
				!strings.ContainsAny(trimmed, " \t\n\r") {
				return map[string]interface{}{"href": trimmed, "label": trimmed}
			}
		}
	}
	return nil
}
```

- [ ] **Step 2.6 — Migrate no-op processors**

`RichLinkProcessor`, `WebClipBlockProcessor`, and `AIBlockProcessor` all return `false, nil` in their current `PasteMatch`. Replace each with:

In `sieve/rich_link_processor.go`:
```go
func (p *RichLinkProcessor) IsBlock(_ []ContentEntry) bool                                             { return false }
func (p *RichLinkProcessor) Transform(_ []ContentEntry, _ string, _ string) map[string]interface{} { return nil }
```

In `sieve/web_clip_processor.go`:
```go
func (p *WebClipBlockProcessor) IsBlock(_ []ContentEntry) bool                                             { return false }
func (p *WebClipBlockProcessor) Transform(_ []ContentEntry, _ string, _ string) map[string]interface{} { return nil }
```

In `sieve/ai_block_processor.go`:
```go
func (p *AIBlockProcessor) IsBlock(_ []ContentEntry) bool                                             { return false }
func (p *AIBlockProcessor) Transform(_ []ContentEntry, _ string, _ string) map[string]interface{} { return nil }
```

- [ ] **Step 2.7a — Create sieve/shared_patterns.go**

`mermaidFenceRe` is defined in `diagram_processor.go` but `SmartImageProcessor` also needs it for mermaid detection in `IsBlock`. Move it to a shared file rather than duplicating the regex string.

Create `sieve/shared_patterns.go`:

```go
package sieve

import "regexp"

// MermaidFenceRe matches a complete ```mermaid ... ``` fenced block.
// Used by both DiagramProcessor and SmartImageProcessor.
var MermaidFenceRe = regexp.MustCompile("(?s)^```mermaid\n(.+)\n```$")
```

Then in `sieve/diagram_processor.go`, replace:
```go
var mermaidFenceRe = regexp.MustCompile("(?s)^```mermaid\n(.+)\n```$")
```
with:
```go
// mermaidFenceRe is an alias for the shared pattern — kept for readability.
var mermaidFenceRe = MermaidFenceRe
```

Build to confirm no breakage:
```bash
go build -tags webkit2_41 ./...
```

- [ ] **Step 2.7 — Migrate SmartImageProcessor**

In `sieve/smart_image_processor.go`, replace `PasteMatch` with:

```go
func (p *SmartImageProcessor) IsBlock(entries []ContentEntry) bool {
	for _, e := range entries {
		if strings.HasPrefix(e.MIMEType, "image/") && strings.HasPrefix(e.Content, "data:image/") {
			return true
		}
		if e.MIMEType == "text/plain" || e.MIMEType == "text/uri-list" {
			if isImageURL(strings.TrimSpace(e.Content)) {
				return true
			}
		}
		if e.MIMEType == "text/html" {
			if src := extractHTMLImageSrc(e.Content); src != "" && isImageURL(src) {
				return true
			}
		}
		// SVG already rendered (e.g. from diagram block via resolveEntries)
		if e.MIMEType == "image/svg+xml" {
			return true
		}
		// Mermaid source text — resolveEntries will render it to SVG at execution time,
		// but we must return true here at detection time so the menu item appears.
		// Tolerant of MIME type — content pattern is the authority (Postel's Law).
		if MermaidFenceRe.MatchString(strings.TrimSpace(e.Content)) {
			return true
		}
	}
	return false
}

func (p *SmartImageProcessor) Transform(entries []ContentEntry, uuid string, blockID string) map[string]interface{} {
	if !p.IsBlock(entries) {
		return nil
	}
	for _, e := range entries {
		if strings.HasPrefix(e.MIMEType, "image/") && strings.HasPrefix(e.Content, "data:image/") {
			filename, err := p.saveBase64(uuid, e.Content, blockID)
			if err != nil {
				logger.Warn("smart-image: paste save failed", "block", blockID, "err", err)
				return nil
			}
			return map[string]interface{}{"src": filename}
		}
		if e.MIMEType == "image/svg+xml" {
			filename, err := p.saveSVG(uuid, e.Content, blockID)
			if err != nil {
				logger.Warn("smart-image: svg save failed", "block", blockID, "err", err)
				return nil
			}
			return map[string]interface{}{"src": filename}
		}
		if e.MIMEType == "text/plain" || e.MIMEType == "text/uri-list" {
			s := strings.TrimSpace(e.Content)
			if isImageURL(s) {
				filename, err := p.downloadImage(uuid, s, blockID)
				if err != nil {
					logger.Warn("smart-image: paste download failed", "block", blockID, "url", s, "err", err)
					return nil
				}
				return map[string]interface{}{"src": filename}
			}
		}
		if e.MIMEType == "text/html" {
			if src := extractHTMLImageSrc(e.Content); src != "" && isImageURL(src) {
				filename, err := p.downloadImage(uuid, src, blockID)
				if err != nil {
					logger.Warn("smart-image: paste html-img download failed", "block", blockID, "url", src, "err", err)
					return nil
				}
				return map[string]interface{}{"src": filename}
			}
		}
	}
	return nil
}
```

You also need to add a `saveSVG` method. Check how `saveBase64` is implemented in `sieve/smart_image_processor.go` and add alongside it:

```go
// saveSVG saves raw SVG content as an asset file and returns the asset filename.
func (p *SmartImageProcessor) saveSVG(uuid, svgContent, blockID string) (string, error) {
	data := []byte(svgContent)
	filename := blockID + ".svg"
	return filename, p.svc.Assets.SaveAsset(uuid, filename, data)
}
```

Read `saveBase64` first to confirm the `Assets.SaveAsset` signature before writing `saveSVG`.

- [ ] **Step 2.8 — Update HandlePaste in editor_service.go**

Find `HandlePaste` (around line 443). Replace it with:

```go
func (es *EditorService) HandlePaste(uuid string, entries []ContentEntry) (kind, id, rawYaml string, matched bool) {
	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		if !pm.Processor.IsBlock(entries) {
			continue
		}
		blockID := GenerateBlockIDFor(pm.Kind)
		overrides := pm.Processor.Transform(entries, uuid, blockID)
		if overrides == nil {
			continue
		}
		id, raw, err := es.createBlockWithID(uuid, pm.Kind, blockID, overrides)
		if err != nil {
			return "", "", "", false
		}
		return pm.Kind, id, raw, true
	}
	return "", "", "", false
}
```

Also add `CreateBlockFromEntries` after `HandlePaste`:

```go
// CreateBlockFromEntries creates a block of the given kind from ContentEntry data.
// Used by the extract WS handler — processor is pre-selected, no first-match scan.
func (es *EditorService) CreateBlockFromEntries(uuid string, kind string, entries []ContentEntry) (id, rawYaml string, err error) {
	processor := GetProcessor(kind)
	if processor == nil {
		return "", "", fmt.Errorf("extract: unknown kind %q", kind)
	}
	if !processor.IsBlock(entries) {
		return "", "", fmt.Errorf("extract: processor %q cannot handle entries", kind)
	}
	blockID := GenerateBlockIDFor(kind)
	overrides := processor.Transform(entries, uuid, blockID)
	if overrides == nil {
		return "", "", fmt.Errorf("extract: Transform returned nil for kind %q", kind)
	}
	id, raw, err := es.createBlockWithID(uuid, kind, blockID, overrides)
	return id, raw, err
}
```

Add `"fmt"` to the import block if not already present.

- [ ] **Step 2.9 — Update processor test files**

In each `sieve/*_processor_test.go` file:
- Rename test functions: `TestXxx_PasteMatch_*` → `TestXxx_IsBlock_*` and `TestXxx_Transform_*`
- Split combined paste tests: one test for `IsBlock` (returns bool), one for `Transform` (returns attrs)
- Update method calls from `p.PasteMatch(entries, ...)` to `p.IsBlock(entries)` / `p.Transform(entries, uuid, id)`

For `sieve/diagram_processor_test.go`, replace the two paste tests:

```go
func TestDiagramProcessor_IsBlock_mermaidFence(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	src := "graph TD\n  A[Start] --> B[End]"
	content := "```mermaid\n" + src + "\n```"
	if !p.IsBlock([]ContentEntry{{MIMEType: "text/plain", Content: content}}) {
		t.Fatal("IsBlock must return true for a mermaid fenced block")
	}
}

func TestDiagramProcessor_IsBlock_otherFence(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	if p.IsBlock([]ContentEntry{{MIMEType: "text/plain", Content: "```go\nfunc main() {}\n```"}}) {
		t.Error("IsBlock must return false for non-mermaid fenced block")
	}
}

func TestDiagramProcessor_IsBlock_plainText(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	if p.IsBlock([]ContentEntry{{MIMEType: "text/plain", Content: "hello world"}}) {
		t.Error("IsBlock must return false for plain text")
	}
}

func TestDiagramProcessor_Transform_mermaidFence(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	src := "graph TD\n  A[Start] --> B[End]"
	content := "```mermaid\n" + src + "\n```"
	overrides := p.Transform([]ContentEntry{{MIMEType: "text/plain", Content: content}}, "", "")
	if overrides == nil {
		t.Fatal("Transform must return non-nil for a mermaid fenced block")
	}
	if overrides["source"] != src {
		t.Errorf("source: got %v, want %q", overrides["source"], src)
	}
	if overrides["mode"] != "render" {
		t.Errorf("mode: got %v, want render", overrides["mode"])
	}
}

func TestDiagramProcessor_Transform_notIsBlock(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	overrides := p.Transform([]ContentEntry{{MIMEType: "text/plain", Content: "hello world"}}, "", "")
	if overrides != nil {
		t.Error("Transform must return nil when IsBlock is false")
	}
}
```

Apply the same pattern to the other processor test files — check current test names with `grep -n "func Test" sieve/*_processor_test.go` and rename/split as needed.

- [ ] **Step 2.10 — Build and test**

```bash
go build -tags webkit2_41 ./...
go test -tags webkit2_41 ./sieve/... -v 2>&1 | tail -30
```

Expected: BUILD OK, all tests PASS.

- [ ] **Step 2.11 — Commit**

```bash
git add sieve/processor_registry.go sieve/editor_service.go sieve/*_processor.go sieve/*_processor_test.go
git commit -m "refactor: split PasteMatch into IsBlock + Transform; add DetectExtractions"
```

---

## Task 3: detect-extractions HTTP endpoint

**Files:**
- Create: `requesthandlers/extraction_handler.go`
- Modify: `handlers.go`

- [ ] **Step 3.1 — Write the test**

Create `sieve/detect_extractions_test.go`:

```go
package sieve

import (
	"testing"
)

func TestDetectExtractions_diagram(t *testing.T) {
	RegisterProcessor("diagram-test", NewDiagramProcessor(BlockServices{}))
	defer UnregisterProcessor("diagram-test")

	entries := []ContentEntry{{MIMEType: "text/plain", Content: "```mermaid\ngraph TD\n  A-->B\n```"}}
	results := DetectExtractions("ai-block", entries)

	found := false
	for _, r := range results {
		if r.Kind == "diagram-test" {
			found = true
		}
	}
	if !found {
		t.Errorf("DetectExtractions must include diagram-test; got %v", results)
	}
}

func TestDetectExtractions_selfSuppression(t *testing.T) {
	RegisterProcessor("diagram-self", NewDiagramProcessor(BlockServices{}))
	defer UnregisterProcessor("diagram-self")

	entries := []ContentEntry{{MIMEType: "text/plain", Content: "```mermaid\ngraph TD\n  A-->B\n```"}}
	results := DetectExtractions("diagram-self", entries)

	for _, r := range results {
		if r.Kind == "diagram-self" {
			t.Error("DetectExtractions must not include source kind")
		}
	}
}

func TestDetectExtractions_noMatch(t *testing.T) {
	entries := []ContentEntry{{MIMEType: "text/plain", Content: "just some plain text"}}
	results := DetectExtractions("ai-block", entries)
	// No processor should match plain prose
	for _, r := range results {
		if r.Kind == "diagram" || r.Kind == "code" {
			t.Errorf("DetectExtractions must not match plain text; got kind %q", r.Kind)
		}
	}
}
```

- [ ] **Step 3.2 — Run test to verify it passes (DetectExtractions already added in Task 2)**

```bash
go test -tags webkit2_41 ./sieve/... -run TestDetectExtractions -v
```

Expected: all 3 tests PASS (the function was written in Task 2 Step 2.2).

- [ ] **Step 3.3 — Create extraction_handler.go**

Create `requesthandlers/extraction_handler.go`:

```go
package requesthandlers

import (
	"encoding/json"
	"net/http"

	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type ExtractionHandler struct {
	ServiceProvider *sieve.ServiceProvider
}

func (h *ExtractionHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/detect-extractions", h.handleDetectExtractions)
}

func (h *ExtractionHandler) handleDetectExtractions(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UUID       string              `json:"uuid"`
		SourceKind string              `json:"sourceKind"`
		Entries    []sieve.ContentEntry `json:"entries"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Entries) == 0 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	results := sieve.DetectExtractions(req.SourceKind, req.Entries)
	if results == nil {
		results = []sieve.ExtractionCandidate{}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(results)
}
```

- [ ] **Step 3.4 — Register in handlers.go**

In `handlers.go`, find the `requestHandlers` slice (around line 121). Add `ExtractionHandler` alongside `EditorHandler`:

```go
&requesthandlers.EditorHandler{ServiceProvider: sp, Tmpl: tmpl, Broadcast: hub.broadcast},
&requesthandlers.ExtractionHandler{ServiceProvider: sp},
```

- [ ] **Step 3.5 — Build check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors.

- [ ] **Step 3.6 — Commit**

```bash
git add requesthandlers/extraction_handler.go handlers.go sieve/detect_extractions_test.go
git commit -m "feat(extract): add /api/detect-extractions endpoint"
```

---

## Task 4: extract WebSocket handler

**Files:**
- Modify: `requesthandlers/ws_handler.go`

- [ ] **Step 4.1 — Add the case to the message dispatch switch**

In `requesthandlers/ws_handler.go`, find the `switch msg.Type` block (around line 108). Add after `case "promote-block":`:

```go
case "extract":
    h.handleExtract(uuid, raw, writeMsg)
```

- [ ] **Step 4.2 — Add the handler function**

Add after `handleCreateBlock`:

```go
func (h *WsHandler) handleExtract(uuid string, raw []byte, writeMsg func(interface{})) {
	var msg struct {
		Kind    string               `json:"kind"`
		Entries []sieve.ContentEntry `json:"entries"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || msg.Kind == "" {
		return
	}

	_, _, err := h.ServiceProvider.Editor.CreateBlockFromEntries(uuid, msg.Kind, msg.Entries)
	if err != nil {
		logger.Warn("ws: extract failed", "uuid", uuid, "kind", msg.Kind, "err", err)
		return
	}
}
```

`CreateBlockFromEntries` was added in Task 2 Step 2.8. It generates the blockID, calls `Transform`, and calls `createBlockWithID`. The `OnBlockCreated` lifecycle listener already fires from `createBlockWithID`, so the `insert-block` WS response is sent automatically — no extra code needed here.

- [ ] **Step 4.3 — Build check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors.

- [ ] **Step 4.4 — Commit**

```bash
git add requesthandlers/ws_handler.go
git commit -m "feat(extract): add extract WS message handler"
```

---

## Task 5: JS — DOM walk, context-aware header, rename Embed

**Files:**
- Modify: `frontend/src/static/sieve-block-extension.js`

This task adds the DOM walk utility and context-aware header to the right-click handler. It does NOT yet call the backend — that is Task 6. It also renames "Promote to Document" → "Embed in document".

- [ ] **Step 5.1 — Add the DOM walk utility near the top of sieve-block-extension.js**

Read the top of `sieve-block-extension.js` to find a good insertion point (after `'use strict'` or after existing utilities). Add:

```js
// walkForContentEntry walks up from the click target to the nearest .sieve-block.
// Returns a ContentEntry describing the clicked element in content-model terms,
// or null if the walk reached the block boundary without finding anything specific.
// The JS has zero knowledge of what is *extractable* — it just classifies DOM elements.
// Go's IsBlock decides whether the content is promotable.
function walkForContentEntry(target, blockRoot) {
  var el = target
  while (el && el !== blockRoot && !el.classList.contains('sieve-block')) {
    // Fenced code block (any language — Go decides if it's extractable)
    if (el.matches('code[class*="language-"]') || el.tagName === 'CODE') {
      var lang = ''
      var cls = el.className || ''
      var m = cls.match(/language-([^\s]+)/)
      if (m) lang = m[1]
      // Include the full fence delimiters so IsBlock regex works correctly
      var src = el.textContent || ''
      var content = lang ? ('```' + lang + '\n' + src + '\n```') : src
      return { mimeType: 'text/plain', content: content }
    }
    // Image
    if (el.tagName === 'IMG' && el.src) {
      return { mimeType: 'text/uri-list', content: el.src }
    }
    // Hyperlink
    if (el.tagName === 'A' && el.href) {
      return { mimeType: 'text/uri-list', content: el.href }
    }
    el = el.parentElement
  }
  return null
}

// contentEntryHint returns a short human-readable label for a ContentEntry,
// used to annotate the context menu header.
function contentEntryHint(entry) {
  if (!entry) return null
  if (entry.mimeType === 'text/uri-list') {
    // Check if it looks like an image URL
    if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(entry.content)) return 'image'
    return 'link'
  }
  if (entry.mimeType === 'text/plain') {
    var m = entry.content.match(/^```([^\n`]+)/)
    if (m) return m[1] === 'mermaid' ? 'diagram' : m[1]
  }
  return null
}
```

- [ ] **Step 5.2 — Update the right-click handler to use the DOM walk and context-aware header**

Find the `contextmenu` event listener in `sieve-block-extension.js` (around line 98). Change it to:

1. Extract the click entry immediately after `e.stopPropagation()`
2. Compute `targetHint`
3. Prepend a `{ type: 'header', label: headerLabel }` item

The beginning of the handler should become:

```js
view.dom.addEventListener('contextmenu', function (e) {
  e.preventDefault()
  e.stopPropagation()

  var currentNode = (typeof getPos === 'function') ? editor.state.doc.nodeAt(getPos()) : node
  var n = currentNode || node
  var IC = window.SieveIcons || {}

  // DOM walk — classify what was clicked in content-model terms
  var clickEntry = walkForContentEntry(e.target, view.dom)
  var targetHint = contentEntryHint(clickEntry)

  // Context-aware header: "AI BLOCK · diagram" or just "AI BLOCK"
  var kindLabel = n.type && n.type.name
    ? n.type.name.replace(/^sieve-/, '').replace(/-/g, ' ').toUpperCase()
    : (n.attrs.kind || 'BLOCK').toUpperCase()
  var headerLabel = kindLabel + (targetHint ? ' · ' + targetHint : '')

  var items = [{ type: 'header', label: headerLabel }]
  var rendererItems = renderer.buildContextMenuItems
    ? renderer.buildContextMenuItems({ node: n, editor: editor, getPos: getPos })
    : []
  items = items.concat(rendererItems)
```

- [ ] **Step 5.3 — Rename "Promote to Document" → "Embed in document"**

Find the line (around line 168):
```js
{ icon: IC.promote, label: 'Promote to Document',
```

Change to:
```js
{ icon: IC.promote, label: 'Embed in document',
```

- [ ] **Step 5.4 — Verify build is clean**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors (this is JS-only but a build check confirms nothing was accidentally broken in Go files).

- [ ] **Step 5.5 — Commit**

```bash
git add frontend/src/static/sieve-block-extension.js
git commit -m "feat(extract): JS DOM walk, context-aware header, rename Embed"
```

---

## Task 6: JS — detect-extractions call + Extract menu section

**Files:**
- Modify: `frontend/src/static/sieve-block-extension.js`

This task wires the DOM walk result into a backend call and renders "Extract as…" menu items.

- [ ] **Step 6.1 — Make the contextmenu handler async and add the detect-extractions fetch**

The `contextmenu` event listener needs to be async to await the backend call. Change:
```js
view.dom.addEventListener('contextmenu', function (e) {
```
to:
```js
view.dom.addEventListener('contextmenu', async function (e) {
```

After building `items` from `rendererItems` (end of Step 5.2), add a `// [extract section added in Task 6]` comment. That comment is where this code goes:

```js
  // Fetch extraction candidates from backend (fast — pure IsBlock calls, no I/O)
  var extractItems = []
  if (clickEntry) {
    var sourceKind = (n.attrs && n.attrs.kind) || (n.type && n.type.name) || ''
    try {
      // uuid is not yet accessible in sieve-block-extension.js scope;
      // the handler accepts but does not currently validate it.
      // Read it from the editor URL query param as a best-effort.
      var docUuid = new URLSearchParams(window.location.search).get('uuid') || ''
      var resp = await fetch('/api/detect-extractions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uuid: docUuid,
          sourceKind: sourceKind,
          entries: [clickEntry],
        }),
      })
      if (resp.ok) {
        var candidates = await resp.json()
        extractItems = candidates.map(function (c) {
          return {
            icon: IC.promote,
            label: 'Extract as ' + kindToLabel(c.kind),
            action: makeExtractAction(c.kind, clickEntry, n, editor),
          }
        })
      }
    } catch (_) {
      // Backend unavailable — degrade gracefully, no extract items shown
    }
  }

  if (extractItems.length > 0) {
    items = items.concat([{ type: 'divider' }].concat(extractItems))
  }
```

- [ ] **Step 6.2 — Add kindToLabel and makeExtractAction helpers**

Add these two helpers near `walkForContentEntry` in `sieve-block-extension.js`:

```js
// kindToLabel converts a block kind to a display label for the Extract menu.
function kindToLabel(kind) {
  var labels = {
    'diagram':     'Diagram',
    'smart-image': 'Smart Image',
    'code':        'Code Block',
    'smart-link':  'Smart Link',
    'rich-link':   'Link Card',
  }
  return labels[kind] || (kind.charAt(0).toUpperCase() + kind.slice(1))
}

// makeExtractAction returns the action function for an Extract menu item.
// Stored in closure — each item has its own kind and entry.
function makeExtractAction(kind, entry, node, editor) {
  return function () {
    document.dispatchEvent(new CustomEvent('sieve:extract', {
      detail: { kind: kind, entries: [entry], sourceId: node.attrs && node.attrs.id },
    }))
  }
}
```

- [ ] **Step 6.3 — Verify the Extract section appears**

Open the app (`wails dev`), create an AI block with a response containing a mermaid fence, right-click it. The context menu should show:
- "AI BLOCK · diagram" as the header
- "Extract as Diagram" in a dedicated section above "Embed in document"

If the header shows correctly but Extract items do not appear, check the browser console for fetch errors.

- [ ] **Step 6.4 — Commit**

```bash
git add frontend/src/static/sieve-block-extension.js
git commit -m "feat(extract): call detect-extractions on right-click, render Extract menu items"
```

---

## Task 7: JS — sieve:extract listener + resolveEntries hook + spinner

**Files:**
- Modify: `frontend/src/static/editor.js`
- Modify: `frontend/src/static/sieve-block-extension.js`

- [ ] **Step 7.1 — Add sieve:extract listener to editor.js**

In `frontend/src/static/editor.js`, find the block of `document.addEventListener('sieve:...')` calls (around line 377). Add:

```js
document.addEventListener('sieve:extract', async function (e) {
  if (!currentUuid || !e.detail.kind || !e.detail.entries) return

  var kind = e.detail.kind
  var entries = e.detail.entries
  var sourceId = e.detail.sourceId

  // resolveEntries: give the target renderer a chance to transform entries
  // before sending to backend (e.g. SmartImageRenderer renders mermaid → SVG)
  var targetRenderer = window.TipTap && window.TipTap.getSieveRenderer
    ? window.TipTap.getSieveRenderer(kind)
    : null

  var resolvedEntries = entries
  if (targetRenderer && typeof targetRenderer.resolveEntries === 'function') {
    // Show spinner on source block while resolving
    if (sourceId) {
      document.dispatchEvent(new CustomEvent('sieve:block-extracting', { detail: { id: sourceId } }))
    }
    try {
      resolvedEntries = await targetRenderer.resolveEntries(entries)
    } catch (err) {
      console.warn('sieve:extract resolveEntries failed', err)
      if (sourceId) {
        document.dispatchEvent(new CustomEvent('sieve:block-extract-done', { detail: { id: sourceId } }))
      }
      return
    }
    if (sourceId) {
      document.dispatchEvent(new CustomEvent('sieve:block-extract-done', { detail: { id: sourceId } }))
    }
  }

  wsSend({ type: 'extract', kind: kind, entries: resolvedEntries, uuid: currentUuid })
})
```

- [ ] **Step 7.2 — Add default resolveEntries to the renderer registration in sieve-block-extension.js**

In `sieve-block-extension.js`, find where `T.registerSieveRenderer` is called or where the renderer object is used. Add a default `resolveEntries` to the framework registration so every renderer gets it automatically:

In the `createSieveBlockExtension` function (or wherever renderers are used), after building the renderer object, ensure the default exists:

```js
// Default resolveEntries — pass-through. Target renderers override this for
// async transformation (e.g. SmartImageRenderer renders mermaid → SVG).
if (!renderer.resolveEntries) {
  renderer.resolveEntries = function (entries) { return Promise.resolve(entries) }
}
```

Find the right insertion point by searching for `renderer.buildContextMenuItems` — add this default nearby.

- [ ] **Step 7.3 — Add spinner events to sieve-block-extension.js**

The `sieve:block-extracting` and `sieve:block-extract-done` events should show/hide a loading indicator on the source block. Listeners are added to `document` but **must be removed in the NodeView `destroy` hook** to avoid accumulating one listener pair per block creation over the session lifetime.

Inside `addNodeView()`, the NodeView's `return` statement already has a `destroy` function. Add the listeners alongside it:

```js
var onExtracting = function (e) {
  if (e.detail && e.detail.id === (n && n.attrs && n.attrs.id)) {
    view.dom.style.opacity = '0.6'
    view.dom.style.pointerEvents = 'none'
  }
}
var onExtractDone = function (e) {
  if (e.detail && e.detail.id === (n && n.attrs && n.attrs.id)) {
    view.dom.style.opacity = ''
    view.dom.style.pointerEvents = ''
  }
}
document.addEventListener('sieve:block-extracting', onExtracting)
document.addEventListener('sieve:block-extract-done', onExtractDone)
```

Then in the `return { ..., destroy: function () { ... } }` block, add the removals to the existing `destroy`:

```js
destroy: function () {
  document.removeEventListener('sieve:block-extracting', onExtracting)
  document.removeEventListener('sieve:block-extract-done', onExtractDone)
  // any existing destroy logic here
}
```

Read the current `destroy` implementation in `sieve-block-extension.js` to find what already exists there and merge rather than replace.

Note: `n` here refers to the node variable in the outer closure — verify it is in scope at this insertion point by reading the surrounding code.

- [ ] **Step 7.4 — Verify TipTap.getSieveRenderer exists**

Check `frontend/src/static/sieve-block-extension.js` for a `getSieveRenderer` or `registerSieveRenderer` function:

```bash
grep -n "getSieveRenderer\|registerSieveRenderer\|registeredRenderers\|rendererMap" frontend/src/static/sieve-block-extension.js | head -10
```

If `getSieveRenderer` does not exist, add it alongside `registerSieveRenderer`:

```js
var registeredRenderers = {}
T.registerSieveRenderer = function (kind, renderer) { registeredRenderers[kind] = renderer }
T.getSieveRenderer    = function (kind) { return registeredRenderers[kind] || null }
```

Read the file to find the existing `registerSieveRenderer` pattern first.

- [ ] **Step 7.5 — Build check**

```bash
go build -tags webkit2_41 ./...
```

- [ ] **Step 7.6 — Commit**

```bash
git add frontend/src/static/sieve-block-extension.js frontend/src/static/editor.js
git commit -m "feat(extract): resolveEntries hook, extract WS dispatch, spinner on source block"
```

---

## Task 8: SmartImageRenderer.resolveEntries + export ensureMermaid

**Files:**
- Modify: `frontend/src/static/diagram-renderer.js`
- Modify: `frontend/src/static/smart-image-renderer.js`

- [ ] **Step 8.1 — Export ensureMermaid and renderMermaidToSvg from diagram-renderer.js**

In `frontend/src/static/diagram-renderer.js`, find the `ensureMermaid` function (it already exists for internal use). Add an export at the module scope (outside the IIFE if the file uses one, or as a window global):

Find where the IIFE closes `)()` or find the bottom of the file. Before the closing, add:

```js
  // Export for use by SmartImageRenderer.resolveEntries
  window.DiagramUtils = {
    ensureMermaid: ensureMermaid,
    renderToSvg: function (source) {
      var id = 'mermaid-extract-' + Date.now()
      return ensureMermaid().then(function () {
        return window.mermaid.render(id, source)
      }).then(function (result) {
        return result.svg
      })
    },
  }
```

Read the file to confirm `ensureMermaid` is in scope at the export point.

- [ ] **Step 8.2 — Add resolveEntries to SmartImageRenderer**

In `frontend/src/static/smart-image-renderer.js`, find where `T.registerSieveRenderer('smart-image', SmartImageRenderer)` is called. Before that line, add `resolveEntries` to the renderer:

```js
SmartImageRenderer.resolveEntries = async function (entries) {
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i]
    // SVG or image bytes already — pass through
    if (e.mimeType === 'image/svg+xml' || e.mimeType.startsWith('image/')) {
      return entries
    }
    // Mermaid fence in text/plain — render to SVG
    if (e.mimeType === 'text/plain') {
      var m = e.content.match(/^```mermaid\n([\s\S]+)\n```$/)
      if (m) {
        var utils = window.DiagramUtils
        if (!utils) {
          throw new Error('DiagramUtils not loaded — ensure diagram-renderer.js is included before smart-image-renderer.js')
        }
        var svg = await utils.renderToSvg(m[1])
        return [{ mimeType: 'image/svg+xml', content: svg }]
      }
    }
  }
  return entries
}
```

- [ ] **Step 8.3 — Ensure diagram-renderer.js loads before smart-image-renderer.js**

Check `frontend/src/index.html` for the script tag order. `diagram-renderer.js` must appear before `smart-image-renderer.js`. If not, reorder them.

```bash
grep -n "diagram-renderer\|smart-image-renderer" frontend/src/index.html
```

- [ ] **Step 8.4 — End-to-end test**

Open the app (`wails dev`). Create an AI block with a mermaid response. Right-click the mermaid fence. The menu should show:
1. Header: `AI BLOCK · diagram`
2. Extract section: "Extract as Diagram" and "Extract as Smart Image"
3. Divider + "Embed in document"

Click "Extract as Smart Image". The source block should briefly dim (spinner), then a new Smart Image block should appear with the SVG rendered and AI description pending.

Click "Extract as Diagram". A new Diagram block should appear in render mode showing the diagram.

- [ ] **Step 8.5 — Commit**

```bash
git add frontend/src/static/diagram-renderer.js frontend/src/static/smart-image-renderer.js frontend/src/index.html
git commit -m "feat(extract): SmartImageRenderer.resolveEntries renders mermaid→SVG via DiagramUtils"
```

---

## Self-Review

### Spec Coverage Check

| Spec requirement | Task |
|---|---|
| `ContentEntry` replaces `PasteEntry` | Task 1 |
| `IsBlock` + `Transform` replace `PasteMatch` | Task 2 |
| `DetectExtractions` in registry | Task 2 Step 2.2 |
| Smart paste flow unchanged (first match) | Task 2 Step 2.8 |
| `CreateBlockFromEntries` for extract path | Task 2 Step 2.8 |
| `/api/detect-extractions` endpoint | Task 3 |
| Self-suppression (sourceKind skipped) | Task 3 (DetectExtractions) |
| `extract` WS handler | Task 4 |
| JS DOM walk — generic, no business logic | Task 5 Step 5.1 |
| Context-aware header (`AI BLOCK · diagram`) | Task 5 Step 5.2 |
| Rename "Promote to Document" → "Embed in document" | Task 5 Step 5.3 |
| detect-extractions call on right-click | Task 6 |
| Extract section in context menu | Task 6 |
| `resolveEntries` default pass-through | Task 7 Step 7.2 |
| `sieve:extract` WS dispatch | Task 7 Step 7.1 |
| Spinner on source block during async resolveEntries | Task 7 Step 7.3 |
| `SmartImageProcessor.IsBlock` detects mermaid `text/plain` | Task 2 Step 2.7 (explicit mermaid fence check) |
| `SmartImageProcessor.IsBlock` detects `image/svg+xml` (already-rendered) | Task 2 Step 2.7 |
| Shared `MermaidFenceRe` regex — no duplication | Task 2 Step 2.7a (`shared_patterns.go`) |
| `SmartImageProcessor.Transform` handles image/svg+xml | Task 2 Step 2.7 (saveSVG) |
| `SmartImageRenderer.resolveEntries` renders mermaid→SVG | Task 8 |
| `ensureMermaid` exported from diagram-renderer.js | Task 8 Step 8.1 |
| Asset saved before block created | Task 2 (Transform does save) + Task 7 (resolveEntries before WS) |

### Type Consistency Check

- `ContentEntry` used throughout (not `PasteEntry`) ✓
- `IsBlock(entries []ContentEntry) bool` ✓
- `Transform(entries []ContentEntry, uuid string, blockID string) map[string]interface{}` ✓
- `DetectExtractions(sourceKind string, entries []ContentEntry) []ExtractionCandidate` ✓
- `ExtractionCandidate{Kind string}` ✓
- `CreateBlockFromEntries(uuid, kind string, entries []ContentEntry) (id, rawYaml string, err error)` ✓
- JS: `resolveEntries(entries []ContentEntry) Promise<ContentEntry[]>` ✓
- JS: `DiagramUtils.renderToSvg(source string) Promise<string>` ✓
