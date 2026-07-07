# AI Block Migration to SieveBlock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the AI Block from its bespoke HTTP-handler + fenced-YAML pattern into the SieveBlock framework, moving all context assembly into Go — eliminating the frontend's responsibility for building `content` and `history` strings.

**Architecture:**
1. **ContextProvider infrastructure** — a `ContextProvider` interface + registry + `BuildContextForID` primitive. Any block kind can provide context. The dispatch is purely mechanical: find block by ID → look up provider by kind → call `BuildContext`. A ref to `img-1234` routes to `SmartImageProcessor`. A ref to `blk-1234` routes to `BlockAnchorProvider`. Providers decide their own traversal and representation.
2. **`JobContext`** — `RunJob` receives everything it needs (ctx, uuid, shadow snapshot, block, notify) assembled by `EditorService` at dispatch time. No reach-back into services from processors.
3. **`AIBlockProcessor`** — iterates its `ref` chain, calls `BuildContextForID` for each ID, assembles context. After resolution it scans `seen` against the shadow's blocks to collect any `smart-image` IDs — `AIService.resolveAIImages` already converts those IDs to file paths. The frontend sends nothing about images.
4. **Frontend migration** — `ai-block-renderer.js` replaces `ai-block-extension.js`; `buildAiContext` is **deleted** and replaced by a minimal `resolveTargetRef` that only determines the target block ID; `editor.js` sends `create-block` with `type`, `ref`, and `question` only.

**Prerequisites:**
- `docs/design/archive/2026-06-04-block-anchors.md` — **DONE.**
- `docs/design/archive/2026-06-04-target-highlighting.md` — **DONE.** `ParseBlockAnchors` returns `[]*BlockAnchor`. Goldmark AST types (`blockAnchorNode`, `sieveBlockNode`, `targetHighlightNode`) are **unexported** in `markdown_parser.go`.

---

## Design Principles

| Principle | Consequence |
|-----------|-------------|
| Each `ContextProvider` decides entirely how to represent itself | No centralised chain-walking utility (`ResolveChain` does not exist) |
| Dispatch is by block kind, resolved at runtime | `BuildContextForID` finds block → looks up provider by kind → calls `BuildContext` |
| `seen map[string]bool` threads through recursion | Every `BuildContext` receives it; providers that recurse pass it on; cycle-safe |
| `DocumentService` is a pure storage layer | Never add markdown-reading concerns to it |
| `EditorService` assembles `JobContext` at dispatch | Processors never reach back into `EditorService` — no circular dependency |
| All ContextProviders receive `svc BlockServices` | Consistent injection; providers can call any service or registry they need |
| Go determines the image list from the context resolution | Frontend sends no `imageBlockIds`; `AIBlockProcessor` scans `seen` for `smart-image` blocks; `AIService.resolveAIImages` already converts IDs → paths |

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| CREATE | `sieve/context_provider.go` | `ContextProvider` interface, registry, `BuildContextForID` primitive |
| CREATE | `sieve/context_provider_test.go` | Registry + dispatch tests |
| MODIFY | `sieve/markdown_parser.go` | Add `FindBlockByID` |
| MODIFY | `sieve/block_anchor.go` | Add `BlockAnchorProvider` (with `svc BlockServices`) |
| MODIFY | `sieve/markdown_parser_test.go` | Tests for `FindBlockByID` + `BlockAnchorProvider` |
| MODIFY | `sieve/processor_registry.go` | Add `JobContext` struct; update `BlockProcessor.RunJob` and `BuildContext` interfaces |
| MODIFY | `sieve/editor_service.go` | Assemble `JobContext` at dispatch site |
| MODIFY | `sieve/code_processor.go` | Adopt `JobContext`; add `seen` to `BuildContext` |
| MODIFY | `sieve/web_clip_processor.go` | Adopt `JobContext`; add `seen` to `BuildContext` |
| MODIFY | `sieve/smart_link_processor.go` | Adopt `JobContext`; add `seen` to `BuildContext` |
| MODIFY | `sieve/smart_image_processor.go` | Adopt `JobContext`; add `seen` to `BuildContext` |
| CREATE | `sieve/ai_block_processor.go` | `AIBlockProcessor` — full `BlockProcessor` implementation |
| CREATE | `sieve/ai_block_processor_test.go` | Processor unit tests |
| MODIFY | `sieve/service_provider.go` | Register `AIBlockProcessor` + `BlockAnchorProvider` (with `svc`) |
| CREATE | `frontend/src/static/ai-block-renderer.js` | SieveBlock renderer |
| MODIFY | `frontend/src/index.html` | Swap script tag |
| MODIFY | `frontend/src/static/extensions.js` | Delete `buildAiContext`; add `resolveTargetRef` (determines target block ID only) |
| MODIFY | `frontend/src/static/editor.js` | Replace HTTP POST with `create-block` WS (`type`, `ref`, `question`, `uuid` only); remove `ai:block-resolved` SSE handler |
| MODIFY | `requesthandlers/ai_handler.go` | Remove `handleAiAsk`, `handleAiExplain` and helpers |

---

## Task 1: `ContextProvider` interface, registry, and `BuildContextForID`

**Context:** `ContextProvider` is a subset of `BlockProcessor` — just `BuildContext`. Every `BlockProcessor` satisfies it at zero cost. The registry allows non-processor implementors (like `BlockAnchorProvider`) to be registered for a kind. `BuildContextForID` is the single recursive primitive: find a block by ID, look up its provider by kind, call `BuildContext` with the `seen` set. No callers need to know what kind of block they're referencing.

**Files:** Create `sieve/context_provider.go`, `sieve/context_provider_test.go`

- [ ] **Step 1: Write failing tests**

```go
// sieve/context_provider_test.go
package sieve

import "testing"

type mockContextProcessor struct{ returnVal string }

func (m *mockContextProcessor) BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string {
	return m.returnVal
}
func (m *mockContextProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{"id": id}
}
func (m *mockContextProcessor) PasteMatch(entries []PasteEntry, uuid, blockID string) (bool, map[string]interface{}) {
	return false, nil
}
func (m *mockContextProcessor) RunJob(jctx JobContext) error { return nil }
func (m *mockContextProcessor) JobLabel(_ *SieveBlock) string { return "" }
func (m *mockContextProcessor) OnChange(_ *SieveBlock)        {}
func (m *mockContextProcessor) Mode() BlockMode               { return BlockModeBlock }

func TestGetContextProviderFallsBackToProcessor(t *testing.T) {
	RegisterProcessor("test-cp-kind", &mockContextProcessor{returnVal: "from-processor"})
	cp := GetContextProvider("test-cp-kind")
	if cp == nil {
		t.Fatal("expected ContextProvider, got nil")
	}
	result := cp.BuildContext(SieveBlock{ID: "x", Kind: "test-cp-kind"}, ShadowDocument{}, map[string]bool{})
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
	result := cp.BuildContext(SieveBlock{ID: "y", Kind: "test-override-kind"}, ShadowDocument{}, map[string]bool{})
	if result != "from-override" {
		t.Errorf("expected 'from-override', got %q", result)
	}
}

func TestGetContextProviderReturnsNilForUnknownKind(t *testing.T) {
	if cp := GetContextProvider("definitely-not-registered-xyz"); cp != nil {
		t.Error("expected nil for unregistered kind")
	}
}

func TestBuildContextForIDDispatchesByKind(t *testing.T) {
	RegisterContextProvider("test-dispatch-kind", &mockContextProcessor{returnVal: "dispatched"})
	// Simulate a doc with a block of this kind by using ParseBlockAnchors indirectly —
	// for this test, directly register and test the dispatch logic
	cp := GetContextProvider("test-dispatch-kind")
	if cp == nil {
		t.Fatal("expected provider")
	}
	// BuildContextForID itself is tested via integration in Task 2 tests
}
```

Note: `mockContextProcessor.RunJob` and `BuildContext` already use the `JobContext` and `seen` signatures defined in Tasks 1 and 3. Write them now; the full compile will require Tasks 1 and 3 to be complete together as one atomic step.

- [ ] **Step 2: Implement `sieve/context_provider.go`**

```go
package sieve

import "sync"

// ContextProvider extracts plain-text AI context from a block.
// BlockProcessor already satisfies this interface.
// seen is threaded through recursion to prevent cycles — pass it on
// whenever calling BuildContextForID from within BuildContext.
type ContextProvider interface {
	BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string
}

var (
	contextProviderMu       sync.RWMutex
	contextProviderRegistry = map[string]ContextProvider{}
)

// RegisterContextProvider registers a ContextProvider override for kind.
// Use this for non-processor implementors (e.g. BlockAnchorProvider).
func RegisterContextProvider(kind string, provider ContextProvider) {
	contextProviderMu.Lock()
	defer contextProviderMu.Unlock()
	contextProviderRegistry[kind] = provider
}

// GetContextProvider returns the ContextProvider for kind.
// Checks the override registry first; falls back to GetProcessor.
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

// BuildContextForID is the single recursive primitive for context assembly.
// It finds the block with id, looks up its provider by kind, and calls BuildContext.
// The dispatch is entirely by block kind — a ref to "img-1234" routes to
// SmartImageProcessor, "blk-1234" routes to BlockAnchorProvider, etc.
// seen prevents cycles; always pass the same map through a recursion chain.
// Returns "" if id is already seen, block not found, or no provider registered.
func BuildContextForID(id string, doc ShadowDocument, seen map[string]bool) string {
	if id == "" || id == "doc" || seen[id] {
		return ""
	}
	seen[id] = true
	block, found := FindBlockByID(doc.Markdown, id)
	if !found {
		return ""
	}
	cp := GetContextProvider(block.Kind)
	if cp == nil {
		return ""
	}
	return cp.BuildContext(block, doc, seen)
}
```

- [ ] **Step 3: Commit** (after Tasks 1 and 3 together — see note in Step 1)

---

## Task 2: Add `FindBlockByID` and `BlockAnchorProvider`

**Context:** `FindBlockByID` uses the unexported Goldmark types directly (same package). `BlockAnchorProvider` receives `svc BlockServices` for consistency with all other providers — it calls `BuildContextForID` for any SieveBlock children inside an anchor, which dispatches to whatever provider owns that block kind. `BuildContext` walks the anchor's children, emits `targetHighlightNode.Content` as plain text, and appends a "Specifically regarding: ..." suffix when targets are present.

**Files:** Modify `sieve/markdown_parser.go`, `sieve/block_anchor.go`, `sieve/markdown_parser_test.go`

- [ ] **Step 1: Write failing tests**

Add to `sieve/markdown_parser_test.go`:

```go
func TestFindBlockByIDAnchor(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nSome content\n\n[!block-end]\n"
	block, found := FindBlockByID(md, "blk-1234")
	if !found {
		t.Fatal("expected to find blk-1234")
	}
	if block.ID != "blk-1234" || block.Kind != "block-anchor" {
		t.Errorf("got ID=%q Kind=%q", block.ID, block.Kind)
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
	_, found := FindBlockByID("Just some plain markdown.\n", "blk-9999")
	if found {
		t.Error("expected not found")
	}
}

func TestBlockAnchorProviderReturnsTextContent(t *testing.T) {
	RegisterContextProvider("block-anchor", &BlockAnchorProvider{})
	md := "[!block] id=\"blk-1234\"\n\nHello world.\n\n[!block-end]\n"
	cp := GetContextProvider("block-anchor")
	if cp == nil {
		t.Fatal("expected BlockAnchorProvider to be registered")
	}
	result := cp.BuildContext(
		SieveBlock{ID: "blk-1234", Kind: "block-anchor"},
		ShadowDocument{Markdown: md},
		map[string]bool{"blk-1234": true},
	)
	if !strings.Contains(result, "Hello world") {
		t.Errorf("expected 'Hello world' in context, got %q", result)
	}
}

func TestBlockAnchorProviderIncludesTargets(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nThe patient showed ==acute== symptoms.\n\n[!block-end]\n"
	cp := GetContextProvider("block-anchor")
	result := cp.BuildContext(
		SieveBlock{ID: "blk-1234", Kind: "block-anchor"},
		ShadowDocument{Markdown: md},
		map[string]bool{"blk-1234": true},
	)
	if !strings.Contains(result, "acute") {
		t.Errorf("expected target word in context, got %q", result)
	}
	if !strings.Contains(result, "Specifically regarding") {
		t.Errorf("expected targets suffix, got %q", result)
	}
}

func TestBlockAnchorProviderReturnsEmptyForUnknownID(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nHello world.\n\n[!block-end]\n"
	cp := GetContextProvider("block-anchor")
	result := cp.BuildContext(
		SieveBlock{ID: "blk-9999", Kind: "block-anchor"},
		ShadowDocument{Markdown: md},
		map[string]bool{"blk-9999": true},
	)
	if result != "" {
		t.Errorf("expected empty string for unknown ID, got %q", result)
	}
}

func TestBuildContextForIDDispatchesByKind(t *testing.T) {
	// "img-1234" would route to SmartImageProcessor; "blk-1234" routes to BlockAnchorProvider.
	// This tests that the kind-based dispatch works end-to-end.
	md := "[!block] id=\"blk-abc\"\n\nSome prose.\n\n[!block-end]\n"
	doc := ShadowDocument{Markdown: md}
	result := BuildContextForID("blk-abc", doc, map[string]bool{})
	if !strings.Contains(result, "Some prose") {
		t.Errorf("expected anchor content, got %q", result)
	}
}

func TestBuildContextForIDPreventsCycles(t *testing.T) {
	// seen map already contains the ID — must return "" without panicking
	md := "[!block] id=\"blk-abc\"\n\nContent.\n\n[!block-end]\n"
	seen := map[string]bool{"blk-abc": true}
	result := BuildContextForID("blk-abc", ShadowDocument{Markdown: md}, seen)
	if result != "" {
		t.Errorf("expected empty for already-seen ID, got %q", result)
	}
}
```

- [ ] **Step 2: Add `FindBlockByID` to `sieve/markdown_parser.go`**

Append after `ParseBlockAnchors`:

```go
// FindBlockByID parses markdown and returns the SieveBlock for the given ID.
// For block anchors returns SieveBlock{Kind: "block-anchor"}.
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
		if ba, ok := n.(*blockAnchorNode); ok && ba.AnchorID == id {
			result = SieveBlock{ID: id, Kind: "block-anchor", Attrs: map[string]interface{}{"id": id}}
			found = true
			return ast.WalkStop, nil
		}
		if sn, ok := n.(*sieveBlockNode); ok && sn.SieveBlock.ID == id {
			result = sn.SieveBlock
			found = true
			return ast.WalkStop, nil
		}
		return ast.WalkContinue, nil
	})
	return result, found
}
```

- [ ] **Step 3: Add `BlockAnchorProvider` to `sieve/block_anchor.go`**

```go
package sieve

import (
	"strings"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// BlockAnchorProvider implements ContextProvider for the "block-anchor" kind.
// svc is injected for consistency and future extensibility (e.g. asset lookup).
// For SieveBlock children inside an anchor, it delegates to their own provider
// via BuildContextForID — dispatched by block kind, not hardcoded.
type BlockAnchorProvider struct {
	svc BlockServices
}

func (p *BlockAnchorProvider) BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string {
	source := []byte(doc.Markdown)
	parsed := mdParser().Parser().Parse(text.NewReader(source))

	var anchor *blockAnchorNode
	_ = ast.Walk(parsed, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*blockAnchorNode); ok && ba.AnchorID == block.ID {
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
		if sn, ok := child.(*sieveBlockNode); ok {
			// Dispatch to the block's own provider by kind — img-1234 → SmartImageProcessor,
			// co-abcd → CodeBlockProcessor, etc. The caller decides representation.
			if ctx := BuildContextForID(sn.SieveBlock.ID, doc, seen); ctx != "" {
				sb.WriteString(ctx)
				sb.WriteString("\n\n")
			}
			continue
		}
		// Plain markdown child: walk text + target highlight nodes.
		// targetHighlightNode stores the == word as plain text — emit it naturally.
		_ = ast.Walk(child, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
			if entering {
				if t, ok := n.(*ast.Text); ok {
					sb.Write(t.Segment.Value(source))
					if t.SoftLineBreak() {
						sb.WriteByte('\n')
					}
				}
				if ht, ok := n.(*targetHighlightNode); ok {
					sb.WriteString(ht.Content)
				}
			}
			return ast.WalkContinue, nil
		})
		sb.WriteString("\n\n")
	}

	result := strings.TrimSpace(sb.String())

	// Append precision targets as prompt hints when present.
	// Produces: "Specifically regarding: "acute", "rapid onset""
	if len(anchor.Targets) > 0 {
		quoted := make([]string, len(anchor.Targets))
		for i, t := range anchor.Targets {
			quoted[i] = `"` + t + `"`
		}
		result += "\n\nSpecifically regarding: " + strings.Join(quoted, ", ")
	}
	return result
}
```

- [ ] **Step 4: Run tests**

```bash
go test ./sieve/... -run "TestFindBlockByID|TestBlockAnchorProvider|TestBuildContextForID|TestGetContextProvider" -v
```

- [ ] **Step 5: Full suite + build**

```bash
go test ./sieve/... && go build ./...
```

- [ ] **Step 6: Commit**

```bash
git add sieve/context_provider.go sieve/context_provider_test.go \
        sieve/markdown_parser.go sieve/block_anchor.go sieve/markdown_parser_test.go
git commit -m "feat(context-provider): add ContextProvider registry, BuildContextForID, FindBlockByID, BlockAnchorProvider"
```

---

## Task 3: Introduce `JobContext` and migrate all processors

**Context:** `EditorService.RunJob` already holds the shadow, block copy, and notify closure. It assembles these into a `JobContext` and passes one struct. The `BlockProcessor` interface gains `JobContext` on `RunJob` and `seen map[string]bool` on `BuildContext`. All four existing processors get mechanical signature updates only — no logic changes.

**Files:** Modify `sieve/processor_registry.go`, `sieve/editor_service.go`, all four processor files

- [ ] **Step 1: Update `sieve/processor_registry.go`**

Add `JobContext` after the `BlockMode` constants:

```go
// JobContext is the complete input to a processor's RunJob.
// EditorService assembles it at dispatch time — processors never reach back into services.
type JobContext struct {
	Ctx    context.Context
	UUID   string
	Shadow ShadowDocument
	Block  *SieveBlock
	Notify func(blockID string, attrs map[string]interface{})
}
```

Add `"context"` to the import block.

Update `BlockProcessor` interface — two method signatures change:

```go
type BlockProcessor interface {
	InitAttrs(id string, overrides map[string]interface{}) map[string]interface{}
	PasteMatch(entries []PasteEntry, uuid string, blockID string) (matched bool, overrides map[string]interface{})
	RunJob(jctx JobContext) error
	JobLabel(block *SieveBlock) string
	OnChange(block *SieveBlock)
	Mode() BlockMode
	BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string
}
```

- [ ] **Step 2: Update `EditorService.RunJob` dispatch**

In `sieve/editor_service.go`, inside the existing `shadow.mu.Lock()` block (lines ~580–597), add two lines to snapshot the markdown and mode alongside the block copy:

```go
shadow.mu.Lock()
blk, ok := shadow.Blocks[blockID]
if !ok {
    shadow.mu.Unlock()
    return
}
kind := blk.Kind
blkCopy := &SieveBlock{ ... }   // unchanged
attrsBefore := ...               // unchanged
markdown := shadow.Markdown      // ← add
mode := shadow.Mode              // ← add
shadow.mu.Unlock()
```

Then replace the `processor.RunJob(...)` call with:

```go
jctx := JobContext{
    Ctx:    ctx,
    UUID:   uuid,
    Shadow: ShadowDocument{UUID: uuid, Markdown: markdown, Mode: mode},
    Block:  blkCopy,
    Notify: notify,
}
if err := processor.RunJob(jctx); err != nil {
```

- [ ] **Step 3: Update all four existing processors**

Each processor changes only its `RunJob` and `BuildContext` signatures. No logic changes.

Pattern for each file:

```go
// RunJob: before
func (p *XxxProcessor) RunJob(ctx context.Context, uuid string, block *SieveBlock, notify func(string, map[string]interface{})) error {

// RunJob: after
func (p *XxxProcessor) RunJob(jctx JobContext) error {
    ctx, uuid, block, notify := jctx.Ctx, jctx.UUID, jctx.Block, jctx.Notify
    // body unchanged

// BuildContext: before
func (p *XxxProcessor) BuildContext(block SieveBlock, doc ShadowDocument) string {

// BuildContext: after
func (p *XxxProcessor) BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string {
    // body unchanged (existing processors don't recurse into refs)
```

Apply to: `code_processor.go`, `web_clip_processor.go`, `smart_link_processor.go`, `smart_image_processor.go`.

- [ ] **Step 4: Build check**

```bash
go build ./... && go test ./sieve/... 2>&1 | tail -20
```

Expected: all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add sieve/processor_registry.go sieve/editor_service.go \
        sieve/code_processor.go sieve/web_clip_processor.go \
        sieve/smart_link_processor.go sieve/smart_image_processor.go
git commit -m "refactor(processor): introduce JobContext and seen-map BuildContext signature"
```

---

## Task 4: Implement `AIBlockProcessor`

**Context:** `RunJob` iterates the comma-separated `ref` chain and calls `BuildContextForID` for each ID. The dispatch is entirely by block kind — a ref to `img-1234` routes to `SmartImageProcessor.BuildContext`, `blk-1234` routes to `BlockAnchorProvider.BuildContext`, a previous AI block routes back to `AIBlockProcessor.BuildContext`. The `seen` map (seeded with the current block's own ID) prevents any cycles. `BuildContext` returns a Q&A summary for when this block appears in another block's chain.

**Files:** Create `sieve/ai_block_processor.go`, `sieve/ai_block_processor_test.go`

- [ ] **Step 1: Write failing tests**

```go
// sieve/ai_block_processor_test.go
package sieve

import (
	"strings"
	"testing"
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
	if attrs["ref"] != "blk-1234" {
		t.Errorf("expected ref=blk-1234, got %v", attrs["ref"])
	}
	if attrs["createdAt"] == "" || attrs["createdAt"] == nil {
		t.Error("expected createdAt to be set")
	}
}

func TestAIBlockInitAttrsDefaultRef(t *testing.T) {
	p := &AIBlockProcessor{}
	attrs := p.InitAttrs("ai-ab12", map[string]interface{}{"question": "Hello?"})
	if attrs["ref"] != "doc" {
		t.Errorf("expected default ref=doc, got %v", attrs["ref"])
	}
}

func TestAIBlockMode(t *testing.T) {
	if (&AIBlockProcessor{}).Mode() != BlockModeBlock {
		t.Error("expected BlockModeBlock")
	}
}

func TestAIBlockJobLabel(t *testing.T) {
	p := &AIBlockProcessor{}
	if p.JobLabel(&SieveBlock{Attrs: map[string]interface{}{"type": "ASK"}}) == "" {
		t.Error("expected non-empty label for ASK")
	}
	if p.JobLabel(&SieveBlock{Attrs: map[string]interface{}{"type": "EXPLAIN"}}) == "" {
		t.Error("expected non-empty label for EXPLAIN")
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
		},
	}
	ctx := p.BuildContext(block, ShadowDocument{}, map[string]bool{})
	if !strings.Contains(ctx, "What is Go?") || !strings.Contains(ctx, "A compiled language.") {
		t.Errorf("unexpected context: %q", ctx)
	}
}
```

- [ ] **Step 2: Implement `sieve/ai_block_processor.go`**

```go
package sieve

import (
	"strings"
	"time"
)

// AIBlockProcessor implements BlockProcessor for the "ai-block" kind.
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
	if t, _ := block.Attrs["type"].(string); t == "EXPLAIN" {
		return "Explaining…"
	}
	return "Asking AI…"
}

// BuildContext returns a Q&A summary for when this block appears in another block's ref chain.
func (p *AIBlockProcessor) BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string {
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

// RunJob resolves each ID in the ref chain via BuildContextForID.
// Dispatch is by block kind: img-1234 → SmartImageProcessor,
// blk-1234 → BlockAnchorProvider, a prior AI block → AIBlockProcessor.BuildContext.
// Image block IDs are derived from the seen map after context resolution —
// the frontend sends nothing about images.
func (p *AIBlockProcessor) RunJob(jctx JobContext) error {
	block := jctx.Block
	ref, _ := block.Attrs["ref"].(string)
	question, _ := block.Attrs["question"].(string)
	blockType, _ := block.Attrs["type"].(string)

	// Seed seen with this block's own ID to prevent self-reference.
	seen := map[string]bool{block.ID: true}
	var contextParts []string
	for _, id := range strings.Split(ref, ",") {
		id = strings.TrimSpace(id)
		if ctx := BuildContextForID(id, jctx.Shadow, seen); ctx != "" {
			contextParts = append(contextParts, ctx)
		}
	}
	assembled := strings.Join(contextParts, "\n\n---\n\n")

	// Collect smart-image block IDs from every block visited during context resolution.
	// AIService.resolveAIImages converts these IDs to file paths.
	var imageBlockIds []string
	for id := range seen {
		if blk, ok := jctx.Shadow.Blocks[id]; ok && blk.Kind == "smart-image" {
			imageBlockIds = append(imageBlockIds, id)
		}
	}

	var response string
	var runErr error
	if blockType == "EXPLAIN" {
		response, runErr = p.svc.AI.RunExplain(assembled, "", jctx.UUID, imageBlockIds)
	} else {
		response, runErr = p.svc.AI.RunAsk(assembled, "", question, jctx.UUID, imageBlockIds)
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

- [ ] **Step 3: Run tests + build**

```bash
go test ./sieve/... -run TestAIBlock -v && go build ./...
```

- [ ] **Step 4: Commit**

```bash
git add sieve/ai_block_processor.go sieve/ai_block_processor_test.go
git commit -m "feat(ai-block): implement AIBlockProcessor with kind-dispatched context assembly"
```

---

## Task 5: Register processors

**Files:** Modify `sieve/service_provider.go`

- [ ] **Step 1: Register in `Init` after the existing four registrations**

```go
RegisterProcessor("ai-block", NewAIBlockProcessor(svc))
RegisterContextProvider("block-anchor", &BlockAnchorProvider{svc: svc})
```

`BlockAnchorProvider` receives `svc` for consistency with all other providers. `BlockServices` needs no new fields.

- [ ] **Step 2: Build + full suite**

```bash
go build ./... && go test ./sieve/... 2>&1 | tail -20
```

- [ ] **Step 3: Commit**

```bash
git add sieve/service_provider.go
git commit -m "feat(ai-block): register AIBlockProcessor and BlockAnchorProvider"
```

---

## Task 6: Implement `ai-block-renderer.js`

**Context:** `T.registerSieveRenderer('ai-block', AiBlockRenderer)` creates a TipTap node named `sieve-ai-block`. The framework adds the `contextmenu` listener — `makeNodeView` must not. `makeNodeView` takes `(node, editor)` only; `getPos` is available in `buildContextMenuItems({ node, editor, getPos })`.

**Files:** Create `frontend/src/static/ai-block-renderer.js`

- [ ] **Step 1: Create the renderer**

```js
// ai-block-renderer.js — SieveBlock renderer for the ai-block kind.
import { renderMarkdown, applyHighlighting, isJobStale } from './fenced-block-base.js'

;(function () {
  'use strict'
  var T = window.TipTap
  var IC = window.SieveIcons || {}

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
      ref:      { default: 'doc', parseHTML: function (el) { return el.getAttribute('data-ref') || 'doc' } },
      type:     { default: 'ASK', parseHTML: function (el) { return el.getAttribute('data-type') || 'ASK' } },
      model:    { default: null,  parseHTML: function (el) { return el.getAttribute('data-model') || null } },
      question: { default: '',    parseHTML: function (el) { return el.getAttribute('data-question') || '' } },
      response: { default: null,  parseHTML: function (el) { return el.getAttribute('data-response') || null } },
      error:    { default: null,  parseHTML: function (el) { return el.getAttribute('data-error') || null } },
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

    makeNodeView: function (node, editor) {
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
        gatherChain(id, ref).forEach(function (cid) {
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
          errEl2.textContent = n.attrs.error || 'Request failed. (Right-click to Retry)'
          contentEl.appendChild(errEl2)
        }
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

    buildContextMenuItems: function (ctx) {
      var node = ctx.node, editor = ctx.editor, getPos = ctx.getPos

      function del() {
        if (typeof getPos === 'function') {
          var pos = getPos()
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
        }
      }

      var status = node.attrs.status || 'PENDING'
      var isStale = status === 'PENDING' && isJobStale(node.attrs.createdAt, node.attrs.id)
      var isError = status === 'ERROR' || status === 'TIMEOUT' || isStale
      var isComplete = status === 'COMPLETE'

      var items = [{ type: 'header', label: node.attrs.type === 'EXPLAIN' ? 'Explain' : 'Ask AI' }]

      if (isError) {
        items.push({ icon: IC.refresh, label: 'Retry', action: function () {
          document.dispatchEvent(new CustomEvent('sieve:block-retry', { detail: { id: node.attrs.id } }))
        }})
      }

      if (isComplete && node.attrs.response) {
        items.push({ type: 'divider' })
        items.push({ icon: IC.sparkle, label: 'Ask AI...', action: function () {
          if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
          else editor.commands.focus()
          var ref = (node.attrs.ref && node.attrs.ref !== 'doc')
            ? node.attrs.ref + ',' + node.attrs.id
            : node.attrs.id
          document.dispatchEvent(new CustomEvent('sieve:ai-ask', {
            detail: { precomputedCtx: { content: '', blockRef: ref, history: '', contextLabel: 'Follow-up', imageIds: [] } }
          }))
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

- [ ] **Step 2: Commit**

```bash
git add frontend/src/static/ai-block-renderer.js
git commit -m "feat(ai-block): add SieveBlock renderer (ai-block-renderer.js)"
```

---

## Task 7: Strip `buildAiContext` down to target identification only

**Context:** `buildAiContext` is called at popup-open time specifically to capture the target while the editor selection is still intact — `ctx.contextLabel` drives the dialog header ("Ask About Code Block", "Ask Follow-up", etc.) and `ctx.blockRef` is the target ID captured before `showModal()` steals focus. That mechanism is correct and stays. What goes away is everything `buildAiContext` assembles beyond the target: `content`, `history`, and `imageIds` — all of that is now Go's responsibility.

The function stays, the call sites stay, the `contextLabel` for the dialog header stays. The return shape shrinks to `{ blockRef, contextLabel }`. The dispatch uses only `blockRef`.

**Files:** Modify `frontend/src/static/extensions.js`

- [ ] **Step 1: Identify what to remove inside `buildAiContext`**

The function has two major paths. In both, keep only the `blockRef` and `contextLabel` logic:

**In the `if (aiBlockId)` follow-up path** (~line 416–477):
- Keep: `newRef` computation (the chain ref for follow-up), `contextLabel: 'Follow-up'`
- Remove: `sourceContent` assembly, `intermediateHistory` / `historyTurns` loop, `currentBlockText` extraction
- Return becomes: `{ blockRef: newRef, contextLabel: 'Follow-up' }`

**In the non-AI-block path** (~line 479–598):
- Keep: `blockRef` computation (existing block ID lookup + BlockAnchor wrapping), `contextLabel` from `labelFor(node)`
- Remove: `selectedText` / `textFor(node)` serialization, `finalImageIds` collection
- Return becomes: `{ blockRef: blockRef, contextLabel: contextLabel }`

- [ ] **Step 2: Remove helpers that only served content assembly**

After stripping `buildAiContext`, check whether these helpers are still referenced:
- `function collectChainImageIds(...)` — remove if only called from `buildAiContext`
- `function serializeTableNode(...)` — remove if only called from `buildAiContext`
- `function textFor(node)` — remove if only called from `buildAiContext`

```bash
grep -n "collectChainImageIds\|serializeTableNode\|textFor(" \
  frontend/src/static/extensions.js
```

- [ ] **Step 3: Verify syntax and that dialog label still works**

```bash
node --check frontend/src/static/extensions.js 2>/dev/null || echo "no node in PATH"
```

Run `wails dev` — open a note, select text, right-click → Ask AI. The dialog should still show "Ask About Selection" (or the appropriate label). That confirms `contextLabel` is intact.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/extensions.js
git commit -m "feat(ai-block): strip buildAiContext to blockRef + contextLabel only — content assembly moved to Go"
```

---

## Task 8: Update `editor.js` to use `create-block` WS

**Context:** All ask/explain calls collapse to a single `wsSend`. The frontend sends only `type`, `ref`, and `question` — no content, no history, no imageBlockIds. Go derives everything else.

**Files:** Modify `frontend/src/static/editor.js`

- [ ] **Step 1: Locate all ask/explain paths**

```bash
grep -n "api/ai/ask\|api/ai/explain\|buildAiContext\|pendingAskCtx" frontend/src/static/editor.js
```

- [ ] **Step 2: Replace every ask/explain dispatch with `create-block` WS**

`pendingAskCtx` is already set at popup-open time (from `buildAiContext`, now stripped to just `{ blockRef, contextLabel }`). Use `pendingAskCtx.blockRef` directly.

```js
// Before (approximate):
fetch('/api/ai/ask', { method: 'POST', body: JSON.stringify({
  content: ctx.content, history: ctx.history,
  question: question, noteUUID: currentUuid,
  imageBlockIds: ctx.imageIds, ref: ctx.blockRef,
}) })

// After:
wsSend({
  type: 'create-block',
  kind: 'ai-block',
  attrs: {
    type:     isExplain ? 'EXPLAIN' : 'ASK',
    ref:      pendingAskCtx ? pendingAskCtx.blockRef : 'doc',
    question: question,   // empty string for EXPLAIN
  },
  uuid: currentUuid,
})
```

No `content`, no `history`, no `imageBlockIds`. Go derives everything else.

- [ ] **Step 3: Remove stale SSE handler and bespoke `aiBlock` insertion**

```bash
grep -n "ai:block-resolved\|type.*aiBlock\|insertContent.*aiBlock\|pendingAskCtx" \
  frontend/src/static/editor.js
```

Remove: the `sse:ai:block-resolved` event listener; any block that inserts `type: 'aiBlock'` content; the `pendingAskCtx` variable if only used by the old flow.

- [ ] **Step 4: Build + smoke test**

```bash
go build ./...
```

`wails dev` — select text, trigger Ask AI, verify PENDING → COMPLETE. Verify hover chain highlighting works. Verify smart images in scope are included in the AI response.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(ai-block): replace HTTP ask/explain with create-block WS; frontend sends ref + question only"
```

---

## Task 9: Swap `index.html`

```bash
# In frontend/src/index.html, change:
# <script type="module" src="/static/ai-block-extension.js"></script>
# to:
# <script type="module" src="/static/ai-block-renderer.js"></script>

grep -rn "aiBlock\|AiBlock\|ai-block-extension" \
  frontend/src/static/editor.js frontend/src/static/extensions.js frontend/src/static/context-menu.js
```

Update any remaining `aiBlock` node-type references to `sieve-ai-block`. Commit:

```bash
git add frontend/src/index.html
git commit -m "feat(ai-block): swap to ai-block-renderer.js, retire ai-block-extension.js"
```

---

## Task 10: Remove deprecated HTTP handlers

Delete from `requesthandlers/ai_handler.go`: `handleAiAsk`, `handleAiExplain`, `insertPendingBlock`, `runAiBlock`, `resolveAiBlockStatus`, `aiBlockRequest`, `aiBlockResponse`, the two `r.Post` route registrations, and the `aiblock` import if unused. Do **not** delete the `aiblock` package.

```bash
go build ./... && go test ./... 2>&1 | tail -20
git add requesthandlers/ai_handler.go
git commit -m "feat(ai-block): remove deprecated HTTP ask/explain handlers"
```

---

## Self-Review Checklist

- **`BuildContextForID`** — single recursive primitive; marks `id` in `seen` before calling `BuildContext`; returns `""` for `"doc"`, empty, already-seen, not-found, or no-provider cases.
- **Dispatch by kind** — `FindBlockByID` returns `Kind`; `GetContextProvider(kind)` routes to the right provider; no caller needs to know the block type. `img-1234` → `SmartImageProcessor`, `blk-1234` → `BlockAnchorProvider`, prior AI block → `AIBlockProcessor`.
- **`seen` threads through recursion** — seeded in `AIBlockProcessor.RunJob` with the block's own ID; passed to every `BuildContextForID` call; providers that recurse pass it on.
- **`BlockAnchorProvider`** — receives `svc BlockServices` (consistent injection); delegates child SieveBlock context to `BuildContextForID` (kind-dispatched, not hardcoded); emits `targetHighlightNode.Content` as plain text; appends "Specifically regarding: ..." when `anchor.Targets` non-empty.
- **`JobContext`** — assembled under `shadow.mu.Lock()` to snapshot markdown safely; `Block` is a pre-made copy; `Notify` is the existing closure; no `EditorService` in `BlockServices`.
- **`AIBlockProcessor.RunJob`** — seeds `seen` with own ID; calls `BuildContextForID` for each ref; after resolution scans `seen` ∩ `shadow.Blocks` for `kind == "smart-image"` to build `imageBlockIds`; no `LoadSettings`; matches exact `RunAsk`/`RunExplain` signatures.
- **Image collection** — entirely Go-side; frontend sends no `imageBlockIds`; `AIService.resolveAIImages` converts block IDs → file paths (already implemented).
- **`BlockServices`** — no `Editor` field added; no `GetMarkdown` on `EditorService` for this use case.
- **`buildAiContext` stripped** — keeps `blockRef` + `contextLabel` (dialog header); all content/history/image assembly removed; call sites at popup-open unchanged.
- **WS message** — `{ type, ref, question }` only — Go derives everything else.
- **`ai-block-renderer.js`** — `makeNodeView(node, editor)` 2 args only; no contextmenu listener; `buildContextMenuItems` receives `getPos` via framework; `update()` guards on `sieve-ai-block`.
- **HTTP handlers removed** — `aiblock` package not deleted.
