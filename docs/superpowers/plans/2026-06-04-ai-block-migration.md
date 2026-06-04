# AI Block Migration to SieveBlock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the AI Block from its bespoke HTTP-handler + fenced-YAML pattern into the SieveBlock framework, moving all context assembly (ref chain resolution, `BuildContext` dispatch) into Go — eliminating the frontend's responsibility for building `content` and `history` strings.

**Architecture:** This plan has three layers that build on each other:
1. **ContextProvider infrastructure** — a `ContextProvider` interface (subset of `BlockProcessor`) + `GetContextProvider`/`RegisterContextProvider` registry + `BlockAnchorProvider` (the only non-processor implementor). This gives the system a uniform way to extract AI context from any block kind or block anchor.
2. **`AIBlockProcessor`** — a full `BlockProcessor` implementation that stores `question`, `ref`, `type`, `imageBlockIds` in attrs and in `RunJob` resolves the ref chain via `ResolveChain`, assembles context, and calls the AI service.
3. **Frontend migration** — `ai-block-renderer.js` replaces `ai-block-extension.js`; `buildAiContext` in `extensions.js` is simplified to return only the `blockRef`; `editor.js` sends `create-block` over WS instead of POSTing to `/api/ai/ask`.

**Prerequisite:** `docs/superpowers/plans/2026-06-04-block-anchors.md` must be fully implemented before starting this plan. `BlockAnchorNode` and `BlockAnchorExtension` must be wired into `mdParser()`.

**Tech Stack:** Go, Goldmark AST, TipTap vanilla JS, WebSocket `create-block` flow, existing `BlockProcessor` / `SieveBlock` framework.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| CREATE | `sieve/context_provider.go` | `ContextProvider` interface, `GetContextProvider`/`RegisterContextProvider`, `processorContextProvider` adapter |
| MODIFY | `sieve/block_anchor.go` | Add `BlockAnchorProvider` and `ResolveChain` |
| MODIFY | `sieve/markdown_parser.go` | Add `FindBlockByID` |
| CREATE | `sieve/ai_block_processor.go` | `AIBlockProcessor` — full `BlockProcessor` implementation |
| CREATE | `sieve/context_provider_test.go` | Registry tests |
| CREATE | `sieve/ai_block_processor_test.go` | Processor unit tests |
| MODIFY | `sieve/service_provider.go` | Register `AIBlockProcessor` and `BlockAnchorProvider` |
| MODIFY | `sieve/editor_service.go` | Add `GetMarkdown(uuid string) string` to `EditorService` |
| CREATE | `frontend/src/static/ai-block-renderer.js` | SieveBlock renderer (replaces `ai-block-extension.js`) |
| MODIFY | `frontend/src/index.html` | Swap script tag from `ai-block-extension.js` → `ai-block-renderer.js` |
| MODIFY | `frontend/src/static/extensions.js` | Simplify `buildAiContext` — return `blockRef` only, remove `content`/`history` assembly |
| MODIFY | `frontend/src/static/editor.js` | Replace `/api/ai/ask` POST with `create-block` WS; remove `/api/ai/explain` POST |
| MODIFY | `requesthandlers/ai_handler.go` | Remove `handleAiAsk`, `handleAiExplain`, `insertPendingBlock`, `runAiBlock` |

---

## Task 1: Define `ContextProvider` interface and registry

**Context:** `BlockProcessor` already has `BuildContext(block SieveBlock, doc ShadowDocument) string`. `ContextProvider` is a subset interface with only that method. Because the signature is identical, every `BlockProcessor` automatically satisfies `ContextProvider` at zero cost. The registry allows registering a *different* provider for a kind if needed (e.g., `BlockAnchorProvider`) without touching the `BlockProcessor` registry.

**Files:**
- Create: `sieve/context_provider.go`
- Create: `sieve/context_provider_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// sieve/context_provider_test.go
package sieve

import (
	"testing"
)

type mockContextProcessor struct{ returnVal string }

func (m *mockContextProcessor) BuildContext(block SieveBlock, _ ShadowDocument) string {
	return m.returnVal
}
func (m *mockContextProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{"id": id}
}
func (m *mockContextProcessor) PasteMatch(entries []PasteEntry, uuid, blockID string) (bool, map[string]interface{}) {
	return false, nil
}
func (m *mockContextProcessor) RunJob(_ interface{}, uuid string, block *SieveBlock, notify func(string, map[string]interface{})) error {
	return nil
}
func (m *mockContextProcessor) JobLabel(_ *SieveBlock) string { return "" }
func (m *mockContextProcessor) OnChange(_ *SieveBlock)        {}
func (m *mockContextProcessor) Mode() BlockMode               { return BlockModeBlock }

func TestGetContextProviderFallsBackToProcessor(t *testing.T) {
	RegisterProcessor("test-cp-kind", &mockContextProcessor{returnVal: "from-processor"})

	cp := GetContextProvider("test-cp-kind")
	if cp == nil {
		t.Fatal("expected ContextProvider, got nil")
	}
	result := cp.BuildContext(SieveBlock{ID: "x", Kind: "test-cp-kind", Attrs: map[string]interface{}{}}, ShadowDocument{})
	if result != "from-processor" {
		t.Errorf("expected 'from-processor', got %q", result)
	}
}

func TestGetContextProviderUsesRegisteredOverride(t *testing.T) {
	RegisterProcessor("test-override-kind", &mockContextProcessor{returnVal: "from-processor"})
	RegisterContextProvider("test-override-kind", &mockContextProcessor{returnVal: "from-override"})

	cp := GetContextProvider("test-override-kind")
	if cp == nil {
		t.Fatal("expected ContextProvider, got nil")
	}
	result := cp.BuildContext(SieveBlock{ID: "y", Kind: "test-override-kind", Attrs: map[string]interface{}{}}, ShadowDocument{})
	if result != "from-override" {
		t.Errorf("expected 'from-override', got %q", result)
	}
}

func TestGetContextProviderReturnsNilForUnknownKind(t *testing.T) {
	cp := GetContextProvider("definitely-not-registered-xyz")
	if cp != nil {
		t.Error("expected nil for unregistered kind")
	}
}
```

- [ ] **Step 2: Run to confirm compile error**

```bash
go test -tags webkit2_41 ./sieve/... -run TestGetContextProvider -v
```

Expected: compile error — `GetContextProvider` not defined.

- [ ] **Step 3: Implement `sieve/context_provider.go`**

```go
package sieve

import "sync"

// ContextProvider is the interface for anything that can contribute
// plain-text context to the AI chain. BlockProcessor already satisfies
// this interface — its BuildContext signature is identical.
type ContextProvider interface {
	BuildContext(block SieveBlock, doc ShadowDocument) string
}

var (
	contextProviderMu       sync.RWMutex
	contextProviderRegistry = map[string]ContextProvider{}
)

// RegisterContextProvider registers a ContextProvider override for kind.
// When set, GetContextProvider returns this instead of the BlockProcessor.
func RegisterContextProvider(kind string, provider ContextProvider) {
	contextProviderMu.Lock()
	defer contextProviderMu.Unlock()
	contextProviderRegistry[kind] = provider
}

// GetContextProvider returns the ContextProvider for kind.
// Checks the contextProvider registry first; falls back to GetProcessor.
// Returns nil if neither registry has an entry for kind.
func GetContextProvider(kind string) ContextProvider {
	contextProviderMu.RLock()
	if cp, ok := contextProviderRegistry[kind]; ok {
		contextProviderMu.RUnlock()
		return cp
	}
	contextProviderMu.RUnlock()
	return GetProcessor(kind)
}
```

Note: `BlockProcessor` satisfies `ContextProvider` directly since the `BuildContext` signatures match — no adapter wrapper is needed.

- [ ] **Step 4: Run tests**

```bash
go test -tags webkit2_41 ./sieve/... -run TestGetContextProvider -v
```

Expected: all three pass.

- [ ] **Step 5: Build check**

```bash
go build -tags webkit2_41 ./...
```

- [ ] **Step 6: Commit**

```bash
git add sieve/context_provider.go sieve/context_provider_test.go
git commit -m "feat(context-provider): add ContextProvider interface and registry"
```

---

## Task 2: Add `FindBlockByID` and `ResolveChain`

**Context:** `FindBlockByID` parses the markdown and returns the `SieveBlock` representation of any block (SieveBlock or BlockAnchor) by ID. BlockAnchors are returned as `SieveBlock{ID: anchorID, Kind: "block-anchor"}`. `ResolveChain` splits a comma-separated ref string, deduplicates, looks up each ID, dispatches to `GetContextProvider`, and returns an assembled context string. These functions live in `markdown_parser.go` since they depend on Goldmark.

**Files:**
- Modify: `sieve/markdown_parser.go`
- Modify: `sieve/block_anchor.go` (add `BlockAnchorProvider`)
- Modify: `sieve/block_anchor_test.go` (add provider tests)

- [ ] **Step 1: Write failing tests for `FindBlockByID`**

Add to `sieve/block_anchor_test.go`:

```go
func TestFindBlockByIDAnchor(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nSome content\n\n[!block-end]\n"
	block, found := FindBlockByID(md, "blk-1234")
	if !found {
		t.Fatal("expected to find blk-1234")
	}
	if block.ID != "blk-1234" {
		t.Errorf("expected ID=blk-1234, got %q", block.ID)
	}
	if block.Kind != "block-anchor" {
		t.Errorf("expected Kind=block-anchor, got %q", block.Kind)
	}
}

func TestFindBlockByIDSieveBlock(t *testing.T) {
	md := "```code\nid: co-abcd\nstatus: COMPLETE\nsource: fmt.Println()\n```\n"
	block, found := FindBlockByID(md, "co-abcd")
	if !found {
		t.Fatal("expected to find co-abcd")
	}
	if block.Kind != "code" {
		t.Errorf("expected Kind=code, got %q", block.Kind)
	}
}

func TestFindBlockByIDNotFound(t *testing.T) {
	md := "Just some plain markdown.\n"
	_, found := FindBlockByID(md, "blk-9999")
	if found {
		t.Error("expected not found")
	}
}
```

- [ ] **Step 2: Run to confirm compile error**

```bash
go test -tags webkit2_41 ./sieve/... -run TestFindBlockByID -v
```

- [ ] **Step 3: Add `FindBlockByID` to `sieve/markdown_parser.go`**

Add at the end of `sieve/markdown_parser.go`, after the existing `InjectBlocks` function:

```go
// FindBlockByID parses markdown and returns the SieveBlock for the given ID.
// For BlockAnchorNodes, returns SieveBlock{ID: id, Kind: "block-anchor"}.
// For SieveBlockNodes, returns the full SieveBlock with Attrs.
// Returns (SieveBlock{}, false) if not found.
func FindBlockByID(markdown string, id string) (SieveBlock, bool) {
	source := []byte(markdown)
	doc := mdParser().Parser().Parse(text.NewReader(source))

	var result SieveBlock
	found := false

	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if ba, ok := n.(*BlockAnchorNode); ok {
			if ba.AnchorID == id {
				result = SieveBlock{ID: id, Kind: "block-anchor", Attrs: map[string]interface{}{"id": id}}
				found = true
				return ast.WalkStop, nil
			}
		}
		if sn, ok := n.(*SieveBlockNode); ok {
			if sn.SieveBlock.ID == id {
				result = sn.SieveBlock
				found = true
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})

	return result, found
}
```

- [ ] **Step 4: Run `FindBlockByID` tests**

```bash
go test -tags webkit2_41 ./sieve/... -run TestFindBlockByID -v
```

Expected: all three pass.

- [ ] **Step 5: Implement `BlockAnchorProvider` in `sieve/block_anchor.go`**

Add at the end of `sieve/block_anchor.go`:

```go
// BlockAnchorProvider implements ContextProvider for block anchors.
// It re-parses the anchor content from doc.Markdown and renders the
// text of its children, calling GetContextProvider for any SieveBlock children.
type BlockAnchorProvider struct{}

func (p *BlockAnchorProvider) BuildContext(block SieveBlock, doc ShadowDocument) string {
	source := []byte(doc.Markdown)
	parsed := mdParser().Parser().Parse(text.NewReader(source))

	var anchor *BlockAnchorNode
	_ = ast.Walk(parsed, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*BlockAnchorNode); ok && ba.AnchorID == block.ID {
				anchor = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if anchor == nil {
		return ""
	}

	var sb strings.Builder
	for child := anchor.FirstChild(); child != nil; child = child.NextSibling() {
		if sn, ok := child.(*SieveBlockNode); ok {
			cp := GetContextProvider(sn.Kind)
			if cp != nil {
				ctx := cp.BuildContext(sn.SieveBlock, doc)
				if ctx != "" {
					sb.WriteString(ctx)
					sb.WriteString("\n\n")
				}
			}
			continue
		}
		// Plain markdown child: walk its text nodes
		_ = ast.Walk(child, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
			if entering {
				if t, ok := n.(*ast.Text); ok {
					sb.Write(t.Segment.Value(source))
					if t.SoftLineBreak() {
						sb.WriteByte('\n')
					}
				}
				if _, ok := n.(*ast.Paragraph); ok && n != child {
					// blank line between paragraphs
				}
			}
			return ast.WalkContinue, nil
		})
		sb.WriteString("\n\n")
	}

	return strings.TrimSpace(sb.String())
}
```

Add `"strings"` to the import block in `block_anchor.go` if not already present. Also add `"github.com/yuin/goldmark/text"` and `"github.com/yuin/goldmark/ast"` imports.

- [ ] **Step 6: Write `BlockAnchorProvider` tests**

Add to `sieve/block_anchor_test.go`:

```go
func TestBlockAnchorProviderReturnsTextContent(t *testing.T) {
	RegisterContextProvider("block-anchor", &BlockAnchorProvider{})

	md := "[!block] id=\"blk-1234\"\n\nHello world.\n\n[!block-end]\n"
	doc := ShadowDocument{Markdown: md}
	block := SieveBlock{ID: "blk-1234", Kind: "block-anchor"}

	cp := GetContextProvider("block-anchor")
	if cp == nil {
		t.Fatal("expected BlockAnchorProvider to be registered")
	}
	result := cp.BuildContext(block, doc)
	if result == "" {
		t.Error("expected non-empty context")
	}
	if !strings.Contains(result, "Hello world") {
		t.Errorf("expected 'Hello world' in context, got %q", result)
	}
}

func TestBlockAnchorProviderReturnsEmptyForUnknownID(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nHello world.\n\n[!block-end]\n"
	doc := ShadowDocument{Markdown: md}
	block := SieveBlock{ID: "blk-9999", Kind: "block-anchor"}

	cp := GetContextProvider("block-anchor")
	if cp == nil {
		t.Fatal("expected BlockAnchorProvider to be registered")
	}
	result := cp.BuildContext(block, doc)
	if result != "" {
		t.Errorf("expected empty string for unknown ID, got %q", result)
	}
}
```

Add `"strings"` to test imports.

- [ ] **Step 7: Add `ResolveChain` to `sieve/markdown_parser.go`**

Append after `FindBlockByID`:

```go
// ResolveChain resolves a comma-separated ref string into an ordered, deduplicated
// slice of context strings — one per unique block ID in the chain.
// IDs not found in the document are silently skipped.
// "doc" is treated as a sentinel meaning "whole document" and is also skipped.
func ResolveChain(markdown string, refs string, doc ShadowDocument) []string {
	seen := map[string]bool{}
	var parts []string

	for _, raw := range strings.Split(refs, ",") {
		id := strings.TrimSpace(raw)
		if id == "" || id == "doc" || seen[id] {
			continue
		}
		seen[id] = true

		block, found := FindBlockByID(markdown, id)
		if !found {
			continue
		}

		cp := GetContextProvider(block.Kind)
		if cp == nil {
			continue
		}

		ctx := cp.BuildContext(block, doc)
		if ctx != "" {
			parts = append(parts, ctx)
		}
	}
	return parts
}
```

Add `"strings"` to `markdown_parser.go` imports (it already exists — verify with `grep '"strings"' sieve/markdown_parser.go`).

- [ ] **Step 8: Run all block anchor tests**

```bash
go test -tags webkit2_41 ./sieve/... -run "TestBlockAnchor|TestFindBlockByID|TestGetContextProvider" -v
```

Expected: all pass.

- [ ] **Step 9: Build check**

```bash
go build -tags webkit2_41 ./...
```

- [ ] **Step 10: Commit**

```bash
git add sieve/markdown_parser.go sieve/block_anchor.go sieve/block_anchor_test.go
git commit -m "feat(context-provider): add FindBlockByID, ResolveChain, and BlockAnchorProvider"
```

---

## Task 3: Add `GetMarkdown` to `EditorService`

**Context:** `AIBlockProcessor.RunJob` needs the current merged document markdown to call `ResolveChain`. The `ShadowDocument` is internal to `EditorService`. We expose a single `GetMarkdown(uuid string) string` method.

**Files:**
- Modify: `sieve/editor_service.go`

- [ ] **Step 1: Add `GetMarkdown` to `EditorService`**

Find `EditorService` in `sieve/editor_service.go`. Add after the existing `Open` method or alongside other exported methods:

```go
// GetMarkdown returns the current merged markdown for an open document.
// Returns "" if the document is not open.
func (es *EditorService) GetMarkdown(uuid string) string {
	es.mu.Lock()
	shadow, ok := es.shadows[uuid]
	es.mu.Unlock()
	if !ok {
		return ""
	}
	shadow.mu.Lock()
	defer shadow.mu.Unlock()
	return shadow.contentForSave()
}
```

Note: `contentForSave()` already exists on `ShadowDocument` — it returns the merged markdown with all current block states injected. It acquires no additional lock internally (verify with `grep -n "contentForSave" sieve/editor_service.go`). The outer `shadow.mu.Lock()` here guards against concurrent mutation.

- [ ] **Step 2: Build check**

```bash
go build -tags webkit2_41 ./...
```

- [ ] **Step 3: Commit**

```bash
git add sieve/editor_service.go
git commit -m "feat(editor-service): add GetMarkdown(uuid) for processor use"
```

---

## Task 4: Implement `AIBlockProcessor`

**Context:** `AIBlockProcessor` is a standard `BlockProcessor`. Its `RunJob` assembles context by calling `ResolveChain` with the block's `ref` attribute, then calls `p.svc.AI.RunAsk` or `RunExplain`. On completion it sets `status = COMPLETE` and stores the `response`. On error it sets `status = ERROR`. The `ref` attribute holds the full comma-separated chain (e.g. `"blk-1234,ai-a1b2"`) as set by the frontend at creation time.

**Files:**
- Create: `sieve/ai_block_processor.go`
- Create: `sieve/ai_block_processor_test.go`

- [ ] **Step 1: Write failing tests**

```go
// sieve/ai_block_processor_test.go
package sieve

import (
	"context"
	"testing"
	"time"
)

func TestAIBlockInitAttrs(t *testing.T) {
	p := &AIBlockProcessor{}
	attrs := p.InitAttrs("ai-ab12", map[string]interface{}{
		"question": "What does this mean?",
		"ref":      "blk-1234",
		"type":     "ASK",
	})

	if attrs["id"] != "ai-ab12" {
		t.Errorf("expected id=ai-ab12, got %v", attrs["id"])
	}
	if attrs["status"] != BlockStatusPending {
		t.Errorf("expected status=PENDING, got %v", attrs["status"])
	}
	if attrs["question"] != "What does this mean?" {
		t.Errorf("expected question override, got %v", attrs["question"])
	}
	if attrs["ref"] != "blk-1234" {
		t.Errorf("expected ref=blk-1234, got %v", attrs["ref"])
	}
	if attrs["createdAt"] == "" || attrs["createdAt"] == nil {
		t.Error("expected createdAt to be set")
	}
}

func TestAIBlockInitAttrsDefaultRef(t *testing.T) {
	p := &AIBlockProcessor{}
	attrs := p.InitAttrs("ai-ab12", map[string]interface{}{
		"question": "Hello?",
	})
	if attrs["ref"] != "doc" {
		t.Errorf("expected default ref=doc, got %v", attrs["ref"])
	}
}

func TestAIBlockMode(t *testing.T) {
	p := &AIBlockProcessor{}
	if p.Mode() != BlockModeBlock {
		t.Errorf("expected BlockModeBlock, got %v", p.Mode())
	}
}

func TestAIBlockJobLabel(t *testing.T) {
	p := &AIBlockProcessor{}
	block := &SieveBlock{Attrs: map[string]interface{}{"type": "ASK"}}
	if p.JobLabel(block) == "" {
		t.Error("expected non-empty job label for ASK")
	}
	block.Attrs["type"] = "EXPLAIN"
	if p.JobLabel(block) == "" {
		t.Error("expected non-empty job label for EXPLAIN")
	}
}

func TestAIBlockBuildContext(t *testing.T) {
	p := &AIBlockProcessor{}
	block := SieveBlock{
		ID:   "ai-ab12",
		Kind: "ai-block",
		Attrs: map[string]interface{}{
			"question": "What is Go?",
			"response": "A compiled language.",
			"type":     "ASK",
		},
	}
	ctx := p.BuildContext(block, ShadowDocument{})
	if ctx == "" {
		t.Error("expected non-empty context")
	}
	if !containsString(ctx, "What is Go?") {
		t.Errorf("expected question in context, got %q", ctx)
	}
	if !containsString(ctx, "A compiled language.") {
		t.Errorf("expected response in context, got %q", ctx)
	}
}

func containsString(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && stringContains(s, sub))
}

func stringContains(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
```

- [ ] **Step 2: Run to confirm compile error**

```bash
go test -tags webkit2_41 ./sieve/... -run TestAIBlock -v
```

- [ ] **Step 3: Implement `sieve/ai_block_processor.go`**

```go
package sieve

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// AIBlockProcessor implements BlockProcessor for the "ai-block" kind.
// RunJob resolves the ref chain from Go, assembles context, and calls the AI service.
type AIBlockProcessor struct {
	svc BlockServices
}

func NewAIBlockProcessor(svc BlockServices) *AIBlockProcessor {
	return &AIBlockProcessor{svc: svc}
}

func (p *AIBlockProcessor) Mode() BlockMode { return BlockModeBlock }

func (p *AIBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":        id,
		"status":    BlockStatusPending,
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"ref":       "doc",
		"question":  "",
		"response":  "",
		"type":      "ASK",
		"model":     "",
		"error":     "",
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	return attrs
}

func (p *AIBlockProcessor) PasteMatch(entries []PasteEntry, uuid, blockID string) (bool, map[string]interface{}) {
	return false, nil
}

func (p *AIBlockProcessor) OnChange(block *SieveBlock) {}

func (p *AIBlockProcessor) JobLabel(block *SieveBlock) string {
	t, _ := block.Attrs["type"].(string)
	if t == "EXPLAIN" {
		return "Explaining…"
	}
	return "Asking AI…"
}

// BuildContext returns a human-readable Q&A summary for use in chain history.
func (p *AIBlockProcessor) BuildContext(block SieveBlock, _ ShadowDocument) string {
	q, _ := block.Attrs["question"].(string)
	r, _ := block.Attrs["response"].(string)
	var parts []string
	if q != "" {
		parts = append(parts, "**Q:** "+strings.TrimSpace(q))
	}
	if r != "" {
		parts = append(parts, "**A:** "+strings.TrimSpace(r))
	}
	return strings.Join(parts, "\n\n")
}

// RunJob resolves the ref chain, assembles context, and calls the AI service.
func (p *AIBlockProcessor) RunJob(ctx context.Context, uuid string, block *SieveBlock, notify func(string, map[string]interface{})) error {
	ref, _ := block.Attrs["ref"].(string)
	question, _ := block.Attrs["question"].(string)
	blockType, _ := block.Attrs["type"].(string)

	// imageBlockIds may be sent by the frontend as a []interface{}
	var imageBlockIds []string
	if raw, ok := block.Attrs["imageBlockIds"]; ok {
		if ids, ok := raw.([]interface{}); ok {
			for _, id := range ids {
				if s, ok := id.(string); ok {
					imageBlockIds = append(imageBlockIds, s)
				}
			}
		}
	}

	markdown := p.svc.Documents.GetMarkdown(uuid)
	shadow := ShadowDocument{Markdown: markdown}

	contextParts := ResolveChain(markdown, ref, shadow)
	assembledContext := strings.Join(contextParts, "\n\n---\n\n")

	settings := p.svc.Documents.LoadSettings()
	_ = settings // model selection handled inside AI service

	var response string
	var runErr error
	if blockType == "EXPLAIN" {
		response, runErr = p.svc.AI.RunExplain(assembledContext, "", uuid, imageBlockIds)
	} else {
		response, runErr = p.svc.AI.RunAsk(assembledContext, "", question, uuid, imageBlockIds)
	}

	if runErr != nil {
		errMsg := runErr.Error()
		if strings.Contains(errMsg, "timeout") {
			block.Attrs["status"] = "TIMEOUT"
		} else {
			block.Attrs["status"] = BlockStatusError
		}
		block.Attrs["error"] = errMsg
		return runErr
	}

	block.Attrs["status"] = BlockStatusComplete
	block.Attrs["response"] = response
	block.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
	return nil
}
```

**Note on `p.svc.Documents.GetMarkdown(uuid)`:** `BlockServices.Documents` is `*DocumentService`. Verify that `DocumentService` exposes `GetMarkdown` — if it wraps `EditorService`, add a delegation method. Also verify the `RunAsk`/`RunExplain` signatures against `sieve/ai_service.go` and adjust the call if the parameter order differs.

**Note on `LoadSettings()`:** Settings are loaded via `p.svc.Documents` or a state service. Check `BlockServices` fields and use the appropriate service — the model field may be set differently. Remove or adjust the settings call as needed.

- [ ] **Step 4: Run tests**

```bash
go test -tags webkit2_41 ./sieve/... -run TestAIBlock -v
```

Expected: all pass. Fix any compile errors from service field mismatches.

- [ ] **Step 5: Build check**

```bash
go build -tags webkit2_41 ./...
```

- [ ] **Step 6: Commit**

```bash
git add sieve/ai_block_processor.go sieve/ai_block_processor_test.go
git commit -m "feat(ai-block): implement AIBlockProcessor"
```

---

## Task 5: Register processors and wire service

**Files:**
- Modify: `sieve/service_provider.go`

- [ ] **Step 1: Register `AIBlockProcessor` and `BlockAnchorProvider`**

In `sieve/service_provider.go`, find the existing `RegisterProcessor` calls (e.g. `RegisterProcessor("code", ...)`) and add:

```go
RegisterProcessor("ai-block", NewAIBlockProcessor(sp.BlockServices()))
RegisterContextProvider("block-anchor", &BlockAnchorProvider{})
```

Add these alongside the existing registrations. `NewAIBlockProcessor` receives `BlockServices` so it has access to `AI`, `Documents`, `Assets`.

- [ ] **Step 2: Verify `BlockServices.Documents` exposes `GetMarkdown`**

Check whether `DocumentService` (the concrete type behind `BlockServices.Documents`) has `GetMarkdown`. If it's `*EditorService` directly:

```bash
grep -n "type DocumentService\|DocumentService struct" sieve/*.go
```

If `DocumentService` is a separate struct wrapping `EditorService`, add a `GetMarkdown(uuid string) string` delegation method to it.

- [ ] **Step 3: Build check**

```bash
go build -tags webkit2_41 ./...
```

- [ ] **Step 4: Run full test suite**

```bash
go test -tags webkit2_41 ./sieve/... -v 2>&1 | tail -30
```

- [ ] **Step 5: Commit**

```bash
git add sieve/service_provider.go
git commit -m "feat(ai-block): register AIBlockProcessor and BlockAnchorProvider"
```

---

## Task 6: Implement `ai-block-renderer.js`

**Context:** The new renderer follows the SieveBlock framework exactly as defined in `docs/how-to-sieve-block-framework.md`. The TipTap node type becomes `sieve-ai-block` (registered via `T.registerSieveRenderer('ai-block', ...)`). The existing `ai-block-extension.js` registers an `aiBlock` node type — after this task both will exist briefly; `ai-block-extension.js` is removed in Task 7. The renderer must handle `PENDING`, `DISPATCHED`, `COMPLETE`, `TIMEOUT`, and `ERROR` statuses. Chain highlight behaviour (`gatherChain`) is preserved via the DOM `data-ai-block-id` attribute.

**Files:**
- Create: `frontend/src/static/ai-block-renderer.js`

- [ ] **Step 1: Create the renderer**

```js
// ai-block-renderer.js — SieveBlock renderer for the ai-block kind.
import { renderMarkdown, applyHighlighting, isJobStale } from './fenced-block-base.js'

;(function () {
  'use strict'
  var T = window.TipTap
  var IC = window.SieveIcons || {}

  // ── gatherChain ─────────────────────────────────────────────────────────────
  // Walks the DOM to find all block IDs in this AI block's ref chain.
  // Used to highlight related blocks on hover/focus.
  function gatherChain(startId, refAttr) {
    var ids = new Set()
    function visit(id) {
      if (!id || id === 'doc' || ids.has(id)) return
      ids.add(id)
      var el = document.querySelector('.sieve-ai-block[data-ai-block-id="' + id + '"]')
      if (el) {
        var refs = el.getAttribute('data-ai-ref') || ''
        refs.split(',').forEach(function (r) { visit(r.trim()) })
      }
    }
    visit(startId)
    if (refAttr) refAttr.split(',').forEach(function (r) { visit(r.trim()) })
    return ids
  }

  var AiBlockRenderer = {

    nodeConfig: { atom: true, selectable: true, draggable: false },

    attrs: {
      ref:         { default: 'doc', parseHTML: function (el) { return el.getAttribute('data-ref') || 'doc' } },
      type:        { default: 'ASK', parseHTML: function (el) { return el.getAttribute('data-type') || 'ASK' } },
      model:       { default: null,  parseHTML: function (el) { return el.getAttribute('data-model') || null } },
      question:    { default: '',    parseHTML: function (el) { return el.getAttribute('data-question') || '' } },
      response:    { default: null,  parseHTML: function (el) { return el.getAttribute('data-response') || null } },
      error:       { default: null,  parseHTML: function (el) { return el.getAttribute('data-error') || null } },
    },

    parseAttrs: function (data) {
      return {
        ref:      data.ref      || 'doc',
        type:     data.type     || 'ASK',
        model:    data.model    || null,
        question: data.question || '',
        response: data.response || null,
        error:    data.error    || null,
      }
    },

    makeNodeView: function (node, editor, getPos) {
      var dom = document.createElement('div')
      dom.className = 'sieve-ai-block ai-block'
      dom.contentEditable = 'false'
      dom.setAttribute('data-ai-block-id', node.attrs.id || '')
      dom.setAttribute('data-ai-ref', node.attrs.ref || 'doc')

      var badge = document.createElement('span')
      badge.className = 'ai-block__badge'

      var contentEl = document.createElement('div')
      contentEl.className = 'ai-block__content'
      contentEl.style.userSelect = 'text'

      dom.appendChild(badge)
      dom.appendChild(contentEl)

      function applyChain(action) {
        var id = dom.getAttribute('data-ai-block-id') || ''
        var ref = dom.getAttribute('data-ai-ref') || ''
        var ids = gatherChain(id, ref)
        ids.forEach(function (cid) {
          if (cid === id) return
          var blockEl = document.querySelector('[data-block-id="' + cid + '"]')
          if (blockEl) blockEl.classList[action]('block-ref-active')
          var aiEl = document.querySelector('.sieve-ai-block[data-ai-block-id="' + cid + '"]')
          if (aiEl) aiEl.classList[action]('ai-block--chain-active')
          var wcEl = document.querySelector('.web-clip-block[data-wc-id="' + cid + '"]')
          if (wcEl) wcEl.classList[action]('web-clip-block--chain-active')
        })
      }

      dom.addEventListener('mousedown', function (e) { e.stopPropagation() })
      dom.addEventListener('dragstart', function (e) { e.preventDefault() })
      dom.addEventListener('mouseenter', function () { applyChain('add') })
      dom.addEventListener('mouseleave', function () { applyChain('remove') })

      dom.addEventListener('contextmenu', function (e) {
        e.preventDefault()
        e.stopPropagation()
        if (typeof getPos === 'function') editor.commands.setNodeSelection(getPos())
        document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
          detail: { x: e.clientX, y: e.clientY, context: { type: 'aiBlock', editor: editor, getPos: getPos, node: node } }
        }))
      })

      function render(n) {
        contentEl.innerHTML = ''
        dom.setAttribute('data-ai-block-id', n.attrs.id || '')
        dom.setAttribute('data-ai-ref', n.attrs.ref || 'doc')

        var status = n.attrs.status || 'PENDING'

        if (status === 'PENDING' || status === 'DISPATCHED') {
          if (isJobStale(n.attrs.createdAt, n.attrs.id)) {
            badge.className = 'ai-block__badge ai-block__badge--error'
            badge.textContent = 'AI'
            renderQuestion(n)
            var errEl = document.createElement('p')
            errEl.className = 'ai-block__timeout'
            errEl.textContent = 'Request timed out. (Right-click to Retry)'
            contentEl.appendChild(errEl)
          } else {
            badge.className = 'ai-block__badge ai-block__badge--thinking'
            badge.textContent = 'AI'
            renderQuestion(n)
            var thinking = document.createElement('p')
            var em = document.createElement('em')
            em.textContent = '(thinking…)'
            thinking.appendChild(em)
            contentEl.appendChild(thinking)
          }
        } else if (status === 'COMPLETE') {
          badge.className = 'ai-block__badge'
          badge.textContent = 'AI'
          renderQuestion(n)
          if (n.attrs.response) {
            var responseEl = document.createElement('div')
            responseEl.className = 'ai-block__response'
            responseEl.innerHTML = renderMarkdown(n.attrs.response, editor)
            applyHighlighting(responseEl)
            contentEl.appendChild(responseEl)
          }
        } else {
          badge.className = 'ai-block__badge ai-block__badge--error'
          badge.textContent = 'AI'
          renderQuestion(n)
          var errEl2 = document.createElement('p')
          errEl2.className = 'ai-block__timeout'
          var errMsg = n.attrs.error || 'Request failed. (Right-click to Retry)'
          errEl2.textContent = errMsg
          contentEl.appendChild(errEl2)
        }
      }

      function renderQuestion(n) {
        if (!n.attrs.question) return
        var qEl = document.createElement('div')
        qEl.className = 'ai-question'
        var qLabel = document.createElement('strong')
        qLabel.textContent = (n.attrs.type === 'EXPLAIN') ? 'Explain: ' : 'Ask: '
        qEl.appendChild(qLabel)
        qEl.appendChild(document.createTextNode(n.attrs.question))
        contentEl.appendChild(qEl)
      }

      render(node)

      return {
        dom: dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieve-ai-block') return false
          node = updatedNode
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

    buildContextMenuItems: function ({ node, editor, getPos }) {
      function del() {
        if (typeof getPos === 'function') {
          var pos = getPos()
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
        }
      }

      function retry() {
        document.dispatchEvent(new CustomEvent('sieve:block-retry', { detail: { id: node.attrs.id } }))
      }

      var status = node.attrs.status || 'PENDING'
      var isStale = status === 'PENDING' && isJobStale(node.attrs.createdAt, node.attrs.id)
      var isError = status === 'ERROR' || status === 'TIMEOUT' || isStale
      var isComplete = status === 'COMPLETE'

      var items = [
        { type: 'header', label: node.attrs.type === 'EXPLAIN' ? 'Explain' : 'Ask AI' },
      ]

      if (isError) {
        items.push({ icon: IC.refresh, label: 'Retry', action: retry })
      }

      if (isComplete && node.attrs.response) {
        items.push({ type: 'divider' })
        items.push({ icon: IC.sparkle, label: 'Ask AI...', action: function () {
          if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
          else editor.commands.focus()
          var ref = (node.attrs.ref && node.attrs.ref !== 'doc')
            ? node.attrs.ref + ',' + node.attrs.id
            : node.attrs.id
          var ctx = {
            content: (node.attrs.question ? '**Q:** ' + node.attrs.question + '\n\n' : '') +
                     (node.attrs.response ? '**A:** ' + node.attrs.response : ''),
            blockRef: ref,
            history: '',
            contextLabel: 'Follow-up',
            imageIds: [],
          }
          document.dispatchEvent(new CustomEvent('sieve:ai-ask', { detail: { precomputedCtx: ctx } }))
        }})
      }

      items.push({ type: 'divider' })
      items.push({ icon: IC.trash, label: 'Delete', action: del })

      return items
    },
  }

  T.registerSieveRenderer('ai-block', AiBlockRenderer)
})()
```

- [ ] **Step 2: No automated test possible here** — verify visually in Task 8.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/static/ai-block-renderer.js
git commit -m "feat(ai-block): add SieveBlock renderer (ai-block-renderer.js)"
```

---

## Task 7: Simplify `buildAiContext` in `extensions.js`

**Context:** Currently `buildAiContext` assembles `content` (full text of the selection) and `history` (chain of prior AI block Q&As) and sends them to the backend. After this task, the backend assembles context via `ResolveChain`. The frontend's job is reduced to: wrap the selection in a `[!block]` anchor (already happens) and return the `blockRef` ID. The `content` and `history` fields become empty strings — they are kept in the return shape for backwards compatibility until the HTTP handlers are fully removed, but the backend will use the `ref` chain instead.

**Files:**
- Modify: `frontend/src/static/extensions.js`

- [ ] **Step 1: Update the `buildAiContext` return for the AI-ask path**

In `extensions.js`, the function `buildAiContext` returns an object with `{ content, blockRef, history, contextLabel, imageIds }`. The `aiBlockId` detection branch (lines ~367–476) builds `historyTurns` and `currentBlockText` from the DOM. Replace the return value of that branch:

Find the block starting with `if (aiBlockId) {` and ending with `return { content: ..., blockRef: newRef, history: historyTurns, ... }`.

Change the final return of that branch from:
```js
return { content: currentBlockText || sourceContent, blockRef: newRef, history: historyTurns, contextLabel: 'Follow-up', imageIds: collectChainImageIds(doc, chainRefs, uuid) }
```

To:
```js
return { content: '', blockRef: newRef, history: '', contextLabel: 'Follow-up', imageIds: collectChainImageIds(doc, chainRefs, uuid) }
```

The `blockRef` (`newRef`) is still returned — it's used as the `ref` attr when creating the new AI block. The backend resolves context from `newRef` via `ResolveChain`.

For the non-AI-block path (selection or document context), the existing wrapping logic that produces a `blockRef` from the selection stays unchanged — the backend reads that anchor via `BlockAnchorProvider`.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/static/extensions.js
git commit -m "feat(ai-block): simplify buildAiContext — backend now assembles content from ref chain"
```

---

## Task 8: Update `editor.js` to use `create-block` WS

**Context:** Currently `editor.js` posts to `/api/ai/ask` and `/api/ai/explain` with `content`, `history`, `question`. After this task it sends a `create-block` WS message with `kind: 'ai-block'` and the relevant attrs. The `ai:block-resolved` SSE event handling is replaced by the standard `block-attrs-updated` WS message from the SieveBlock framework.

**Files:**
- Modify: `frontend/src/static/editor.js`

- [ ] **Step 1: Locate the ask/explain handlers in `editor.js`**

```bash
grep -n "api/ai/ask\|api/ai/explain\|handleAsk\|handleExplain\|onAsk\|onExplain" frontend/src/static/editor.js | head -20
```

- [ ] **Step 2: Replace the HTTP POST with a WS `create-block`**

For each place that calls `fetch('/api/ai/ask', ...)` or sends to `/api/ai/explain`:

```js
// Before (approximate shape):
var ctx = T.buildAiContext(editor, isMarkdownMode, rawMd, currentUuid)
fetch('/api/ai/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content: ctx.content,
    history: ctx.history,
    question: question,
    noteUUID: currentUuid,
    imageBlockIds: ctx.imageIds,
    ref: ctx.blockRef,
  })
})

// After:
var ctx = T.buildAiContext(editor, isMarkdownMode, rawMd, currentUuid)
wsSend({
  type: 'create-block',
  kind: 'ai-block',
  attrs: {
    question: question,
    ref: ctx.blockRef,
    type: 'ASK',
    imageBlockIds: ctx.imageIds,
  },
  uuid: currentUuid,
})
```

Apply the same pattern for the EXPLAIN path (`type: 'EXPLAIN'`, no `question`).

- [ ] **Step 3: Remove `ai:block-resolved` SSE handler**

Find and remove the handler for `ai:block-resolved` event in `editor.js` — the SieveBlock framework's `block-attrs-updated` WS message handles re-renders automatically.

- [ ] **Step 4: Build check + smoke test**

```bash
go build -tags webkit2_41 ./...
wails dev
```

Open a document, select text, press Cmd+Shift+A to ask a question. Verify:
- The AI block appears as `PENDING` immediately
- It transitions to `COMPLETE` with a response
- Chain highlighting works on hover

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(ai-block): switch editor.js from HTTP POST to create-block WS"
```

---

## Task 9: Swap `index.html` and remove old extension

**Files:**
- Modify: `frontend/src/index.html`

- [ ] **Step 1: Update script tags**

In `frontend/src/index.html`, find the line:
```html
<script type="module" src="/static/ai-block-extension.js"></script>
```

Replace with:
```html
<script type="module" src="/static/ai-block-renderer.js"></script>
```

The `ai-block-legacy-extension.js` script tag (if present) should also be reviewed — remove it if it only supported the legacy `[!ai]` format that is no longer in use.

- [ ] **Step 2: Verify no `aiBlock` TipTap node references remain in live code**

```bash
grep -rn "aiBlock\|AiBlock\|ai-block-extension" frontend/src/static/editor.js frontend/src/static/extensions.js frontend/src/static/context-menu.js
```

Remove any remaining references to the old `aiBlock` node type.

- [ ] **Step 3: Build and smoke test**

```bash
go build -tags webkit2_41 ./...
wails dev
```

Verify the editor loads without JS errors. Test ask/explain flow end-to-end.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.html
git commit -m "feat(ai-block): swap to ai-block-renderer.js, retire ai-block-extension.js"
```

---

## Task 10: Remove deprecated HTTP handlers

**Context:** `handleAiAsk` and `handleAiExplain` in `ai_handler.go` are now dead code. Remove them and their route registrations.

**Files:**
- Modify: `requesthandlers/ai_handler.go`

- [ ] **Step 1: Remove the handler functions**

In `requesthandlers/ai_handler.go`, delete:
- `handleAiAsk` function
- `handleAiExplain` function
- `insertPendingBlock` function
- `runAiBlock` function
- `resolveAiBlockStatus` function
- `aiBlockRequest` struct
- `aiBlockResponse` struct
- Route registrations: `r.Post("/api/ai/ask", h.handleAiAsk)` and `r.Post("/api/ai/explain", h.handleAiExplain)`
- The `aiblock` import if no longer referenced

Keep: `handleAiSmartFile`, `handleAiSmartMetadata`, `handleAiKeepAndFile`, `handleRefineLanguage`, active-jobs endpoint.

- [ ] **Step 2: Build check**

```bash
go build -tags webkit2_41 ./...
```

Fix any remaining references to the removed functions.

- [ ] **Step 3: Run full test suite**

```bash
go test -tags webkit2_41 ./... -v 2>&1 | tail -30
```

- [ ] **Step 4: Final smoke test**

```bash
wails dev
```

Test: ask AI, explain, follow-up chain, retry on error, delete block, chain highlighting.

- [ ] **Step 5: Final commit**

```bash
git add requesthandlers/ai_handler.go
git commit -m "feat(ai-block): remove deprecated HTTP ask/explain handlers"
```

---

## Self-Review Checklist

- **ContextProvider registry** — `GetContextProvider` falls back to `GetProcessor`; `RegisterContextProvider` stores overrides separately. Both use `sync.RWMutex`.
- **BlockAnchorProvider** — calls `GetContextProvider` recursively for child SieveBlocks; handles missing anchor gracefully (returns `""`).
- **ResolveChain** — deduplicates by ID; skips `"doc"` sentinel; skips unknown IDs silently.
- **AIBlockProcessor.InitAttrs** — always sets `id`, `status: PENDING`, `createdAt`; never overwrites `id` from overrides.
- **`ai-block-renderer.js`** — `update()` returns `false` for wrong type name (`sieve-ai-block`); `attrs` and `parseAttrs` have identical key sets; `applyHighlighting` called after every `innerHTML =`.
- **Chain highlighting** — `gatherChain` uses `data-ai-block-id` (new attribute name); verify no CSS still targets `data-ai-id` from the old renderer.
- **`buildAiContext` simplification** — `content: ''` and `history: ''` are intentional; `blockRef` is still returned and used as the `ref` attr.
- **HTTP handlers removed** — no frontend code still calls `/api/ai/ask` or `/api/ai/explain`.
