# Block Affordance Recognition Implementation Plan

> **STATUS — ✅ COMPLETE (closed out 2026-06-28).** This is the branch's headline feature (`feature/transform_operation_frameworkk`). Recognition returns affordances (`IsSupportedContent`/`SupportedActions`); `Transform(action)`; backend owns the mutation (PASTE/EXTRACT → new block, TRANSFORM → replace-by-id); frontend is a dumb renderer. `replaceSource`/`additiveKinds` heuristics deleted. Data-loss defect #1 (composite clobber) fixed (`188cc9c`); two-reviewer whole-branch review passed. Full detail in the **IMPLEMENTATION STATUS & BACKLOG** section below (updated 2026-06-25). **Deferred / parked:** **Task 8** (prose sub-range split `PRE/TARGET/POST`) — non-blocking; only needed to *move* a child out of a multi-child prose block (composites already covered by defect-#1's additive approach).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the extract-vs-transform decision out of the frontend into the backend processor contract, so recognition returns *affordances* (which operations apply) and the chosen operation round-trips end-to-end; the backend owns the mutation (PASTE/EXTRACT → new block, TRANSFORM → replace block) and the editor re-renders through the normal lifecycle.

**Architecture:** `BlockProcessor.IsBlock(entries) bool` becomes `IsSupportedContent(entries) SupportedActions` — a context-blind enumeration of the operations a kind offers for these entries. `Transform` gains an `action` param. Each *endpoint* filters the offer for the action it cares about (smart-paste → `ActionPaste`; extract menu → `ActionExtract`/`ActionTransform`). The frontend becomes a dumb renderer that posts `{entries, kind, operation}`; `EditorService` maps operation → mutation and broadcasts a render-back. All `replaceSource`/`additiveKinds` frontend heuristics are deleted.

**Tech Stack:** Go (package split `domain ← block ← {processors, services} ← ai ← root`), chi, vanilla JS, TipTap 2, WebSocket block-ops.

## Global Constraints

- **No shim.** `IsBlock` is *renamed* to `IsSupportedContent`, not kept alongside. The tree will not compile until every processor + mock + call site is converted; that is intended (Task 1 is one big-bang commit).
- **No loose/free functions (OOP cohesion).** Behaviour attaches to its owning type. `SupportedActions.Has` is a method; per-processor recognition is inline in each processor (no shared source-sniffing abstraction — explicit team decision).
- **Per-processor inline (Shape B).** Each old `IsBlock` body is rewritten *in place* to return `SupportedActions` (empty `Actions` = no match). No private `matchesContent` predicate is split out.
- **Action-inclusion rule (uniform across structured kinds):** at each match point, include `ActionPaste` always; add `ActionExtract` when the matched entry is a `sieve/<kind>` view (the source is a block that survives), or `ActionTransform` when the matched entry is native MIME (the source is replaced in place). Prose is the documented exception (see Task 4).
- **Frontend never mutates the source node.** No `sieveInsertPos` range-swap, no `replaceSource`. The backend mutates its authoritative tree; the editor re-renders via the render-back lifecycle.
- **`KindProse` scope:** this plan retires the `PromoteBlock` usage (`editor_service.go:770`) only. The `HandleBlockOp` create-render-back usage (`editor_service.go:226`) is a separate (create-provenance) thread, left untouched.
- **Sub-range TRANSFORM (the split case — Task 8):** when a TRANSFORM targets a *strict sub-range* of a prose block (the block holds more content than the thing being transformed — i.e. you embedded a complex Sieve object into prose, then want to pull a sub-element back out, so PRE/TARGET/POST share one PM `contentDOM` and one block id), the frontend must split the prose block into three top-level blocks (`PRE → TARGET → POST`) so TARGET becomes its own addressable block, then transform TARGET. Rare but real. Mind the **`splitBlock` attr-copy dup-id trap** (`project_node_granular_prose`): cleared ids on the new fragments, let the passive minter assign fresh ones.
- **Out of scope:** an *inline* image (image inside a paragraph) is not addressed. Top-level code/image and the prose sub-range split (Task 8) are the supported TRANSFORM sources.

---

### Task 1: Recognition contract — `Action`, `SupportedActions`, `IsSupportedContent`, `Transform(action)`

**Files:**
- Modify: `sieve/block/processor_registry.go` (add types; change `BlockProcessor` interface ~line 175-223)
- Modify: all 9 processors in `sieve/block/processors/` (`code`, `diagram`, `log`, `smart_image`, `smart_link`, `smart_card`, `web_clip`, `ai_block`, `prose`)
- Modify: `sieve/services/editor_service.go:510,529` (the two `Transform` call sites)
- Modify: test mocks — `sieve/block/fake_processor_test.go:24`, `sieve/block/context_provider_test.go:24`, `sieve/block/processor_registry_test.go:27`, `sieve/services/editor_service_promote_test.go:21`
- Test: `sieve/block/processors/affordance_test.go` (new)

**Interfaces:**
- Produces: `block.Action` (string enum: `ActionPaste`, `ActionExtract`, `ActionTransform`); `block.SupportedActions{Kind string; Actions []Action}` with method `Has(Action) bool`; `BlockProcessor.IsSupportedContent(entries []ContentEntry) SupportedActions`; `BlockProcessor.Transform(entries []ContentEntry, uuid, blockID string, action Action) map[string]interface{}`.
- Consumes: existing `ContentEntry.SieveAttrs()`, `ContentEntry.IsSieveType(p)`.

- [ ] **Step 1: Write the failing test**

Create `sieve/block/processors/affordance_test.go`:

```go
package processors

import (
	"testing"

	"sieve/sieve/block"
)

func hasAction(s block.SupportedActions, a block.Action) bool { return s.Has(a) }

func TestCodeProcessor_IsSupportedContent_nativeFence_offersPasteAndTransform(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "```go\nx := 1\n```"}})
	if !hasAction(got, block.ActionPaste) || !hasAction(got, block.ActionTransform) {
		t.Fatalf("native fence should offer paste+transform, got %v", got.Actions)
	}
	if hasAction(got, block.ActionExtract) {
		t.Fatalf("native fence must not offer extract, got %v", got.Actions)
	}
}

func TestCodeProcessor_IsSupportedContent_sieveDiagram_offersPasteAndExtract(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	got := p.IsSupportedContent([]block.ContentEntry{{
		MIMEType: "sieve/diagram",
		Content:  `{"diagramType":"mermaid","source":"graph TD;A-->B"}`,
	}})
	if !hasAction(got, block.ActionExtract) {
		t.Fatalf("sieve source should offer extract, got %v", got.Actions)
	}
}

func TestCodeProcessor_IsSupportedContent_noMatch_emptyActions(t *testing.T) {
	p := NewCodeBlockProcessor(block.BlockServices{})
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "just prose"}})
	if len(got.Actions) != 0 {
		t.Fatalf("prose text must not match code, got %v", got.Actions)
	}
	if got.Kind != "code" {
		t.Fatalf("Kind should always be set, got %q", got.Kind)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/block/processors/ -run TestCodeProcessor_IsSupportedContent`
Expected: FAIL — `IsSupportedContent` / `SupportedActions` / `Action` undefined.

- [ ] **Step 3: Add the types to `sieve/block/processor_registry.go`**

After the `BlockMode` constants (around line 90), add:

```go
// Action is an operation a processor can perform on a set of ContentEntry views.
// Recognition (IsSupportedContent) enumerates the actions an entry set supports,
// context-blind; each endpoint filters for the action it cares about (smart-paste →
// ActionPaste; extract menu → ActionExtract/ActionTransform).
type Action string

const (
	ActionPaste     Action = "paste"     // clipboard/source content -> new block
	ActionExtract   Action = "extract"   // additive: new block alongside (source survives)
	ActionTransform Action = "transform" // replace the source block in place
)

// SupportedActions is one processor's offer for a set of entries: its Kind plus the
// operations it supports. Empty Actions == "this kind cannot be built from these
// entries" (the old IsBlock==false). The registry composes a []SupportedActions.
type SupportedActions struct {
	Kind    string   `json:"kind"`
	Actions []Action `json:"actions"`
}

// Has reports whether this offer includes action a.
func (s SupportedActions) Has(a Action) bool {
	for _, x := range s.Actions {
		if x == a {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Change the `BlockProcessor` interface**

In `sieve/block/processor_registry.go`, replace the `IsBlock` and `Transform` interface lines (≈181-188):

```go
	// IsSupportedContent enumerates the operations a block of this kind supports for
	// these content views, context-blind. Empty Actions == no match. Side-effect free,
	// order-independent. Drives paste-match and the extract menu. See the interface doc.
	IsSupportedContent(entries []ContentEntry) SupportedActions
	// Transform distils the matched entries into attr overrides for the new block,
	// doing any synchronous id-keyed side effects. blockID is the pre-allocated id.
	// action is the operation chosen by the caller (ActionPaste/Extract/Transform);
	// a processor reads it only if its overrides differ by operation (e.g. prose embed).
	// Returns nil to decline.
	Transform(entries []ContentEntry, uuid string, blockID string, action Action) map[string]interface{}
```

Also update the doc comment block above the interface (≈135, 149-166) to name `IsSupportedContent` instead of `IsBlock` and note the `action` param — replace the two bullet references mechanically.

- [ ] **Step 5: Rewrite the 8 structured processors**

Apply the action-inclusion rule. For each, rename `IsBlock`→`IsSupportedContent`, change the return type, replace every `return true` with the offer for that match point, replace `return false` with `return block.SupportedActions{Kind: p.Kind()}`, and add `action block.Action` to `Transform`'s signature.

`sieve/block/processors/code_processor.go`:

```go
func (p *CodeBlockProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		m := codeFenceRe.FindStringSubmatch(e.Content)
		if m != nil {
			if m[1] == "mermaid" {
				continue
			}
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "diagram" {
			if dt, _ := attrs["diagramType"].(string); dt == "mermaid" {
				if src, _ := attrs["source"].(string); strings.TrimSpace(src) != "" {
					return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
				}
			}
		}
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		if _, ok := unfencedCodeContent(e); ok {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

func (p *CodeBlockProcessor) Transform(entries []block.ContentEntry, uuid string, blockID string, action block.Action) map[string]interface{} {
	// ... unchanged body ...
}
```

`sieve/block/processors/diagram_processor.go` — `mermaidFenceRe` match and the `sieve/code` mermaid match are sources for paste/transform vs extract per rule; `IsSieveType` is a sieve source (extract):

```go
func (p *DiagramProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if mermaidFenceRe.MatchString(e.Content) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "code" {
			if lang, _ := attrs["language"].(string); lang == "mermaid" {
				if src, _ := attrs["source"].(string); strings.TrimSpace(src) != "" {
					return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
				}
			}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}
```
(add `action block.Action` to `Transform`.)

`sieve/block/processors/log_processor.go` — `IsSieveType` and `sieve/code` matches are sieve sources (extract); raw `text/plain` log is native (transform):

```go
func (p *LogProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	custom := p.customParsers()
	for _, e := range entries {
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "code" {
			source, _ := attrs["source"].(string)
			if lang, _ := attrs["language"].(string); lang == "log" && strings.TrimSpace(source) != "" {
				return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
			}
			if looksLikeLog(source, custom) {
				return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
			}
		}
		if e.MIMEType == "text/plain" {
			if looksLikeLog(e.Content, custom) {
				return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
			}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}
```
(add `action block.Action` to `Transform`.)

`sieve/block/processors/smart_image_processor.go` — data-URI/SVG/image-URL/mermaid/html are native sources (transform/paste); `sieve/image` and `sieve/diagram` views are sieve sources (extract):

```go
func (p *SmartImageProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	native := []block.Action{block.ActionPaste, block.ActionTransform}
	sieve := []block.Action{block.ActionPaste, block.ActionExtract}
	for _, e := range entries {
		if strings.HasPrefix(e.MIMEType, "image/") && strings.HasPrefix(e.Content, "data:image/") {
			return block.SupportedActions{Kind: p.Kind(), Actions: native}
		}
		if e.MIMEType == "image/svg+xml" {
			return block.SupportedActions{Kind: p.Kind(), Actions: native}
		}
		if e.MIMEType == "sieve/image" {
			return block.SupportedActions{Kind: p.Kind(), Actions: sieve}
		}
		if isImageURL(strings.TrimSpace(e.Content)) {
			return block.SupportedActions{Kind: p.Kind(), Actions: native}
		}
		if block.MermaidFenceRe.MatchString(e.Content) {
			return block.SupportedActions{Kind: p.Kind(), Actions: native}
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "diagram" {
			if dt, _ := attrs["diagramType"].(string); dt == "mermaid" {
				if src, _ := attrs["source"].(string); strings.TrimSpace(src) != "" {
					return block.SupportedActions{Kind: p.Kind(), Actions: sieve}
				}
			}
		}
		if e.MIMEType == "text/html" {
			if src := extractHTMLImageSrc(e.Content); src != "" && isImageURL(src) {
				return block.SupportedActions{Kind: p.Kind(), Actions: native}
			}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}
```
(add `action block.Action` to `Transform`.)

`sieve/block/processors/smart_link_processor.go` — URL text is native (transform/paste):

```go
func (p *SmartLinkProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		trimmed := strings.TrimSpace(e.Content)
		if trimmed == "" || strings.ContainsAny(trimmed, " \t\n\r") {
			continue
		}
		if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
			continue
		}
		if isImageURL(trimmed) {
			continue
		}
		return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
	}
	return block.SupportedActions{Kind: p.Kind()}
}
```
(add `action block.Action` to `Transform`.)

`sieve/block/processors/smart_card_processor.go` — `IsSieveType` view is a sieve source (extract); bare URL text is native (transform):

```go
func (p *SmartCardProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		trimmed := strings.TrimSpace(e.Content)
		if trimmed == "" || strings.ContainsAny(trimmed, " \t\n\r") {
			continue
		}
		if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
			continue
		}
		if isImageURL(trimmed) {
			continue
		}
		return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
	}
	return block.SupportedActions{Kind: p.Kind()}
}
```
(add `action block.Action` to `Transform`.)

`sieve/block/processors/web_clip_processor.go` — `IsSieveType` is sieve (extract); URL text is native (transform). Keep `AllowSelfExtraction`:

```go
func (p *WebClipBlockProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		trimmed := strings.TrimSpace(e.Content)
		if strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://") {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}
```
(add `action block.Action` to `Transform`.)

`sieve/block/processors/ai_block_processor.go` — only matches its own sieve view (extract):

```go
func (p *AIBlockProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}
```
(add `action block.Action` to `Transform`.)

- [ ] **Step 6: Rewrite the prose processor (placeholder body — full broadening in Task 4)**

`sieve/block/processors/prose_processor.go` — for now keep the *existing* claim (only `sieve/prose`), returning `ActionPaste`. Broadening to any source comes in Task 4 to keep this task's diff reviewable:

```go
func (p *ProseProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

func (p *ProseProcessor) Transform(entries []block.ContentEntry, uuid string, blockID string, action block.Action) map[string]interface{} {
	// ... unchanged body ...
}
```

- [ ] **Step 7: Update the four test mocks**

Each mock's `IsBlock(...) bool` becomes `IsSupportedContent(...) block.SupportedActions` and `Transform` gains `action`. Example for `sieve/block/fake_processor_test.go:24`:

```go
func (fakeProc) IsSupportedContent([]ContentEntry) SupportedActions { return SupportedActions{} }
func (fakeProc) Transform([]ContentEntry, string, string, Action) map[string]interface{} { return nil }
```

`sieve/block/context_provider_test.go:24`, `sieve/block/processor_registry_test.go:27`, `sieve/services/editor_service_promote_test.go:21` — same mechanical change. For `processor_registry_test.go` the mock has an `isBlockFn` field (line 10); rename to `actionsFn func([]ContentEntry) SupportedActions` and update callers in that file.

- [ ] **Step 8: Update the two `Transform` call sites in `editor_service.go`**

Lines 510 and 529 — add the action argument. These are temporary literals; Task 3 threads the real action through:

```go
// editor_service.go:510 (HandlePaste)
overrides := processor.Transform(entries, uuid, blockID, block.ActionPaste)
// editor_service.go:529 (CreateBlockFromEntries) — replaced wholesale in Task 3
overrides := processor.Transform(entries, uuid, blockID, block.ActionExtract)
```

- [ ] **Step 9: Run the full build + the new test**

Run: `go build ./... && go test ./sieve/block/... -run TestCodeProcessor_IsSupportedContent`
Expected: build PASSES (whole tree compiles again); the 3 new tests PASS.

- [ ] **Step 10: Run the existing processor suites to catch regressions**

Run: `go test ./sieve/block/...`
Expected: PASS. (Existing `IsBlock` tests were renamed/updated as part of mocks; any remaining references to `.IsBlock(` in `*_test.go` must be changed to `.IsSupportedContent(...).Has(...)` — grep `grep -rn '\.IsBlock(' sieve/` should return nothing.)

- [ ] **Step 11: Commit**

```bash
git add sieve/block sieve/services/editor_service.go
git commit -m "block: recognition returns SupportedActions, not bool (IsSupportedContent)"
```

---

### Task 2: Registry composition — `DetectExtractions` and `FirstPasteMatch`

**Files:**
- Modify: `sieve/block/processor_registry.go:405-490` (`ExtractionCandidate`, `FirstPasteMatch`, `DetectExtractions`)
- Test: `sieve/block/processor_registry_test.go`

**Interfaces:**
- Consumes: `IsSupportedContent`, `SupportedActions.Has`, `Action`.
- Produces: `DetectExtractions(sourceKind string, entries []ContentEntry) []SupportedActions`; `FirstPasteMatch` unchanged signature but matches on `Has(ActionPaste)`.

- [ ] **Step 1: Write the failing test**

Add to `sieve/block/processor_registry_test.go`:

```go
func TestDetectExtractions_returnsActionsPerKind(t *testing.T) {
	// Uses the real registry; rely on a registered mock kind that offers extract.
	// (Construct via the existing test registration helper in this file.)
	entries := []ContentEntry{{MIMEType: "sieve/diagram", Content: `{"diagramType":"mermaid","source":"graph TD;A-->B"}`}}
	offers := DetectExtractions("diagram", entries)
	for _, o := range offers {
		if len(o.Actions) == 0 {
			t.Fatalf("offer for kind %q has no actions", o.Kind)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/block/ -run TestDetectExtractions_returnsActionsPerKind`
Expected: FAIL — `DetectExtractions` still returns `[]ExtractionCandidate`.

- [ ] **Step 3: Rewrite `DetectExtractions`**

Replace `sieve/block/processor_registry.go:467-490` and delete the `ExtractionCandidate` type (405-407):

```go
// DetectExtractions composes the affordance offer: for each registered kind that can
// build from these entries, its SupportedActions. The frontend renders the menu from
// this (per kind, the operations it offers). Self-kind is skipped unless the processor
// opts in via AllowSelfExtraction.
func DetectExtractions(sourceKind string, entries []ContentEntry) []SupportedActions {
	registryMu.RLock()
	defer registryMu.RUnlock()

	var offers []SupportedActions
	for _, pm := range pasteMatchers {
		if pm.Kind == sourceKind {
			allowSelf := false
			if se, ok := pm.Processor.(SelfExtractable); ok {
				allowSelf = se.AllowSelfExtraction()
			}
			if !allowSelf {
				continue
			}
		}
		if got := pm.Processor.IsSupportedContent(entries); len(got.Actions) > 0 {
			offers = append(offers, got)
		}
	}
	return offers
}
```

- [ ] **Step 4: Update `FirstPasteMatch` to match on `ActionPaste`**

In `sieve/block/processor_registry.go:433-465`, replace the two `IsBlock(entries)` checks. Pass 1 (self-kind, ≈444) and pass 2 (general, ≈457, 461):

```go
		if pasteMatchers[i].Kind == k && pasteMatchers[i].Processor.IsSupportedContent(entries).Has(ActionPaste) {
```
```go
		if pasteMatchers[i].Processor.IsSupportedContent(entries).Has(ActionPaste) {
```
```go
	if proseIdx >= 0 && pasteMatchers[proseIdx].Processor.IsSupportedContent(entries).Has(ActionPaste) {
```

- [ ] **Step 5: Build + test**

Run: `go build ./... && go test ./sieve/block/`
Expected: PASS. (Any test still referencing `ExtractionCandidate` must be updated to `SupportedActions`.)

- [ ] **Step 6: Commit**

```bash
git add sieve/block/processor_registry.go sieve/block/processor_registry_test.go
git commit -m "block: registry composes []SupportedActions; paste-match filters ActionPaste"
```

---

### Task 3: `EditorService` operation→mutation map + generic replace render-back

**Files:**
- Modify: `sieve/services/editor_service.go` (`CreateBlockFromEntries` 521-535; `HandlePaste` 504-516; add `applyAction`; add `notifyBlockReplaced`)
- Modify: the `EditorListener` interface (the type defining `OnBlockCreated`/`OnBlockPromoted` — find via `grep -rn "OnBlockPromoted" sieve/`)
- Modify: the listener implementation in `requesthandlers/` (the WS listener that emits render-back messages)
- Test: `sieve/services/editor_service_action_test.go` (new)

**Interfaces:**
- Consumes: `block.Action`, `block.ShadowDocument.ReplaceBlock(id, SieveBlock) bool`, `GetProcessor`, `InitAttrs`, `Transform(...,action)`.
- Produces: `EditorService.CreateBlockFromEntries(uuid, kind string, entries []block.ContentEntry, index int, action block.Action) (id, rawYaml string, err error)`; `EditorListener.OnBlockReplaced(uuid, oldID, newKind, newID string, attrs map[string]interface{}, markdown string)`.

- [ ] **Step 1: Write the failing test**

Create `sieve/services/editor_service_action_test.go`:

```go
package services

import (
	"testing"

	"sieve/sieve/block"
)

func TestCreateBlockFromEntries_transform_replacesInPlace(t *testing.T) {
	es, uuid := newTestEditorServiceWithProseBlock(t) // helper: opens a doc with a prose block "pr-1" holding a native code fence
	// TRANSFORM the prose block "pr-1" into a code block.
	entries := []block.ContentEntry{{MIMEType: "text/plain", Content: "```go\nx := 1\n```"}}
	id, _, err := es.CreateBlockFromEntries(uuid, "code", entries, 0, block.ActionTransform, "pr-1")
	if err != nil {
		t.Fatalf("transform failed: %v", err)
	}
	blk, found := es.shadows[uuid].SnapshotBlock(id)
	if !found || blk.Kind != "code" {
		t.Fatalf("expected code block in place, found=%v blk=%+v", found, blk)
	}
	if _, stillThere := es.shadows[uuid].SnapshotBlock("pr-1"); stillThere && id != "pr-1" {
		t.Fatalf("source pr-1 should have been replaced, not survive alongside")
	}
}

func TestCreateBlockFromEntries_extract_isAdditive(t *testing.T) {
	es, uuid := newTestEditorServiceWithProseBlock(t)
	before := len(es.shadows[uuid].SnapshotBlocks())
	entries := []block.ContentEntry{{MIMEType: "text/plain", Content: "```go\nx := 1\n```"}}
	_, _, err := es.CreateBlockFromEntries(uuid, "code", entries, -1, block.ActionExtract, "")
	if err != nil {
		t.Fatalf("extract failed: %v", err)
	}
	if got := len(es.shadows[uuid].SnapshotBlocks()); got != before+1 {
		t.Fatalf("extract should add one block: before=%d after=%d", before, got)
	}
}
```

(Write `newTestEditorServiceWithProseBlock` alongside, modelled on the existing setup in `editor_service_promote_test.go`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/services/ -run TestCreateBlockFromEntries`
Expected: FAIL — `CreateBlockFromEntries` has the old 4-arg signature.

- [ ] **Step 3: Add `OnBlockReplaced` to the listener interface + implementation**

In the `EditorListener` interface, add:

```go
	// OnBlockReplaced renders an in-place TRANSFORM: swap the block identified by
	// oldID with a new block (newKind/newID + attrs). markdown is the serialized fence
	// for the breakglass markdown editor. Generalises OnBlockPromoted (prose-only).
	OnBlockReplaced(uuid, oldID, newKind, newID string, attrs map[string]interface{}, markdown string)
```

In the WS listener implementation, emit a render-back message the editor already understands or add a `replace-block` case. Model it on the existing `OnBlockPromoted` emitter; send:

```go
func (l *wsEditorListener) OnBlockReplaced(uuid, oldID, newKind, newID string, attrs map[string]interface{}, markdown string) {
	l.broadcastToDoc(uuid, map[string]interface{}{
		"type":    "replace-block",
		"oldId":   oldID,
		"newId":   newID,
		"newKind": newKind,
		"attrs":   attrs,
		"newYaml": markdown,
	})
}
```

- [ ] **Step 4: Add `notifyBlockReplaced` + rewrite `CreateBlockFromEntries`**

In `editor_service.go`, after `notifyBlockPromoted` (≈86):

```go
func (es *EditorService) notifyBlockReplaced(uuid, oldID string, blk block.SieveBlock) {
	es.mu.RLock()
	l := es.listener
	es.mu.RUnlock()
	if l != nil {
		markdown := ""
		if processor := block.GetProcessor(blk.Kind); processor != nil {
			markdown, _ = processor.Serialize(blk)
		}
		l.OnBlockReplaced(uuid, oldID, blk.Kind, blk.ID, blk.Attrs, markdown)
	}
}
```

Replace `CreateBlockFromEntries` (521-535):

```go
// CreateBlockFromEntries applies a recognised action. PASTE/EXTRACT create a new block;
// TRANSFORM replaces sourceID in place (preserving its document position). The frontend
// posted the operation — the backend does not re-derive it. For TRANSFORM, sourceID is
// the id of the top-level block being replaced (native nodes are prose blocks with ids).
func (es *EditorService) CreateBlockFromEntries(uuid, kind string, entries []block.ContentEntry, index int, action block.Action, sourceID string) (id, rawYaml string, err error) {
	processor := block.GetProcessor(kind)
	if processor == nil {
		return "", "", fmt.Errorf("no processor registered for kind %q", kind)
	}

	if action == block.ActionTransform {
		return es.transformInPlace(uuid, kind, processor, entries, sourceID)
	}

	blockID := block.GenerateBlockIDFor(kind)
	overrides := processor.Transform(entries, uuid, blockID, action)
	if overrides == nil {
		return "", "", fmt.Errorf("%s: processor %q could not transform entries into a block", action, kind)
	}
	return es.createBlockWithID(uuid, kind, blockID, overrides, index)
}

// transformInPlace replaces sourceID with a new block of kind, preserving the source's
// id and document position (the OpTransform definition). Mirrors PromoteBlock's mechanic
// but for any target kind.
func (es *EditorService) transformInPlace(uuid, kind string, processor block.BlockProcessor, entries []block.ContentEntry, sourceID string) (id, rawYaml string, err error) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return "", "", fmt.Errorf("transform: no open document for uuid %q", uuid)
	}
	if sourceID == "" {
		return "", "", fmt.Errorf("transform: no source block id")
	}
	overrides := processor.Transform(entries, uuid, sourceID, block.ActionTransform)
	if overrides == nil {
		return "", "", fmt.Errorf("transform: processor %q could not transform entries", kind)
	}
	attrs := processor.InitAttrs(sourceID, overrides)
	newBlock := block.SieveBlock{ID: sourceID, Kind: kind, Attrs: attrs}
	if !shadow.ReplaceBlock(sourceID, newBlock) {
		return "", "", fmt.Errorf("transform: source block %q not found", sourceID)
	}
	rawYaml, err = fencedblock.SerializeYaml[map[string]interface{}](attrs)
	if err != nil {
		return "", "", err
	}
	es.notifyBlockReplaced(uuid, sourceID, newBlock)
	es.DispatchJobIfNeeded(uuid, sourceID)
	return sourceID, rawYaml, nil
}
```

- [ ] **Step 5: Fix `HandlePaste`'s `Transform` call to pass the real action**

`editor_service.go:510` — already `block.ActionPaste` from Task 1 step 8; leave as is.

- [ ] **Step 6: Run the tests**

Run: `go test ./sieve/services/ -run TestCreateBlockFromEntries`
Expected: PASS.

- [ ] **Step 7: Build all**

Run: `go build ./...`
Expected: FAIL at `ws_handler.go` (the `handleExtract` call to `CreateBlockFromEntries` now needs `action`+`sourceID`) — fixed in Task 5. If you are doing strict TDD per-task, temporarily update the `handleExtract` call site to `block.ActionExtract, p.BlockID` to keep the build green, then refine in Task 5. Note this in the commit.

- [ ] **Step 8: Commit**

```bash
git add sieve/services requesthandlers
git commit -m "editor: operation->mutation map (TRANSFORM replaces in place) + replace render-back"
```

---

### Task 4: Prose broadening + `PromoteBlock` dissolution

**Files:**
- Modify: `sieve/block/processors/prose_processor.go` (`IsSupportedContent`, `Transform`)
- Modify: `sieve/services/editor_service.go` (`PromoteBlock` 742-782 → delegate to the transform path; retire the `KindProse` at 770)
- Modify: `requesthandlers/ws_handler.go:292` (promote-block message → route through the action path) — optional if `PromoteBlock` is kept as a thin wrapper
- Test: `sieve/block/processors/prose_affordance_test.go` (new), `sieve/services/editor_service_promote_test.go` (existing — should still pass)

**Interfaces:**
- Consumes: `GetProcessor(sourceKind).MarkdownRepresentation(srcBlock)`, `block.ActionTransform`.
- Produces: prose `IsSupportedContent` offering `ActionTransform` for ANY sieve source; `prose.Transform` building content from a Sieve-block source's `MarkdownRepresentation`.

- [ ] **Step 1: Write the failing test**

Create `sieve/block/processors/prose_affordance_test.go`:

```go
package processors

import (
	"testing"

	"sieve/sieve/block"
)

func TestProse_IsSupportedContent_anySieveSource_offersTransform(t *testing.T) {
	p := NewProseProcessor(block.BlockServices{})
	// A code block source (not sieve/prose) — prose must offer TRANSFORM (embed).
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "sieve/code", Content: `{"source":"x := 1","language":"go"}`}})
	if !got.Has(block.ActionTransform) {
		t.Fatalf("prose should offer transform for any sieve source, got %v", got.Actions)
	}
}

func TestProse_IsSupportedContent_plainText_noMatch(t *testing.T) {
	p := NewProseProcessor(block.BlockServices{})
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "hello"}})
	if len(got.Actions) != 0 {
		t.Fatalf("prose must never claim a non-sieve mime, got %v", got.Actions)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/block/processors/ -run TestProse_IsSupportedContent`
Expected: FAIL — the Task 1 placeholder prose only claims `sieve/prose`.

- [ ] **Step 3: Broaden prose `IsSupportedContent`**

`sieve/block/processors/prose_processor.go` — claim any `sieve/<kind>` view; offer `ActionPaste` for its own `sieve/prose` (round-trip) and `ActionTransform` for any sieve source (the universal sink). Never a non-sieve mime:

```go
func (p *ProseProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) {
			// A copied prose block round-trips on paste; embedding prose-in-prose is also a transform.
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
		if _, _, ok := e.SieveAttrs(); ok {
			// Any other block source → embed it as prose (the universal sink). Not paste:
			// structured kinds claim their own sieve view first (registration order).
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionTransform}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}
```

- [ ] **Step 4: Make `prose.Transform` resolve a Sieve-block source via the registry**

`sieve/block/processors/prose_processor.go` — when the source is a foreign sieve view, build content from its `MarkdownRepresentation` (prose owns this lookup — see the spec's "prose owns it" decision):

```go
func (p *ProseProcessor) Transform(entries []block.ContentEntry, _ string, _ string, _ block.Action) map[string]interface{} {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
		// A foreign sieve source: rebuild it and take its markdown representation.
		if kind, attrs, ok := e.SieveAttrs(); ok {
			if proc := block.GetProcessor(kind); proc != nil {
				src := block.NewSieveBlock(kind, "", attrs)
				if md := proc.MarkdownRepresentation(src); strings.TrimSpace(md) != "" {
					return map[string]interface{}{"content": md}
				}
			}
		}
	}
	var parts []string
	for _, e := range entries {
		if s := strings.TrimSpace(e.Content); s != "" {
			parts = append(parts, s)
		}
	}
	return map[string]interface{}{"content": strings.Join(parts, "\n\n")}
}
```

- [ ] **Step 5: Dissolve `PromoteBlock` into the transform path**

`sieve/services/editor_service.go` — `PromoteBlock` becomes a thin adapter that builds the source's `sieve/<kind>` entry and calls the generic transform, retiring the direct `KindProse` naming at line 770. Replace the body (742-782):

```go
// PromoteBlock embeds a block's content as prose, in place. It is now a thin adapter
// over the generic TRANSFORM-to-prose path: build the source's sieve view entry and ask
// prose to transform it. Prose owns the MarkdownRepresentation resolve (prose_processor).
func (es *EditorService) PromoteBlock(uuid, blockID string) error {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return fmt.Errorf("no open document")
	}
	src, found := shadow.SnapshotBlock(blockID)
	if !found {
		return fmt.Errorf("block not found")
	}
	attrsJSON, err := json.Marshal(src.Attrs)
	if err != nil {
		return err
	}
	entries := []block.ContentEntry{{MIMEType: "sieve/" + src.Kind, Content: string(attrsJSON)}}
	_, _, err = es.CreateBlockFromEntries(uuid, block.GetProcessor("prose").Kind(), entries, 0, block.ActionTransform, blockID)
	return err
}
```

(Note: `block.GetProcessor("prose").Kind()` avoids naming the `KindProse` constant here — prose's identity is the processor's own. If the registry exposes prose by a helper, prefer that. The `KindProse` constant remains only at `editor_service.go:226`, the create-provenance thread, untouched.)

- [ ] **Step 6: Run the prose + promote tests**

Run: `go test ./sieve/block/processors/ -run TestProse && go test ./sieve/services/ -run Promote`
Expected: PASS. The existing `TestEditorService_PromoteBlock_transformsToProse` (`editor_service_promote_test.go:38`) must still pass — it asserts the block becomes `KindProse`; that remains true via the generic path.

- [ ] **Step 7: Build all + full service/block suites**

Run: `go build ./... && go test ./sieve/...`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add sieve/block/processors/prose_processor.go sieve/services/editor_service.go sieve/block/processors/prose_affordance_test.go
git commit -m "prose: claim any source for TRANSFORM; PromoteBlock dissolves into generic transform (retire KindProse :770)"
```

---

### Task 5: WS `handleExtract` carries `operation` + `sourceId`

**Files:**
- Modify: `requesthandlers/ws_handler.go:297-329` (`handleExtract`)
- Test: none new (covered by Task 3 service tests); manual WS verification

**Interfaces:**
- Consumes: `EditorService.CreateBlockFromEntries(uuid, kind, entries, index, action, sourceID)`.
- Produces: the WS `extract` payload accepts `operation` + `blockId` (sourceID).

- [ ] **Step 1: Extend the payload + map operation → action**

Replace the payload struct and the create call in `handleExtract` (298-318):

```go
	var p struct {
		BlockID    string               `json:"blockId"`
		TargetKind string               `json:"targetKind"`
		Operation  string               `json:"operation"`
		Entries    []block.ContentEntry `json:"entries"`
		Index      int                  `json:"index"`
	}
	p.Index = -1
	if err := json.Unmarshal(raw, &p); err != nil {
		logger.Warn("ws: bad extract payload", "err", err)
		return
	}

	action := block.Action(p.Operation)
	if action == "" {
		action = block.ActionExtract // back-compat default: additive
	}

	newID, rawYaml, err := h.ServiceProvider.Editor.CreateBlockFromEntries(
		uuid, p.TargetKind, p.Entries, p.Index, action, p.BlockID)
```

(The success `writeMsg` "block-extracted" stays for the additive case; the TRANSFORM render-back goes out via `OnBlockReplaced` from Task 3. The caller no longer removes the source node, so a stale "block-extracted" replace hint is gone.)

- [ ] **Step 2: Build**

Run: `go build ./...`
Expected: PASS (the Task 3 temporary call-site fix is now the real one).

- [ ] **Step 3: Commit**

```bash
git add requesthandlers/ws_handler.go
git commit -m "ws: extract payload carries operation + sourceId; backend applies the named op"
```

---

### Task 6: HTTP `detect-extractions` response + frontend recognition render

**Files:**
- Modify: `requesthandlers/editor_handler.go:209-224` (`handleDetectExtractions`)
- Modify: `frontend/src/static/sieve-block-extension.js:749-812` (`detectAndAppendExtractions`)
- Modify: `frontend/src/static/context-menu.js:247-264` (native-convert call drops `replaceSource`)
- Test: manual (vanilla JS — no harness); optional vitest for a pure render helper

**Interfaces:**
- Consumes: `/api/detect-extractions` returns `[{kind, actions}]`.
- Produces: menu items that dispatch `sieve:extract` with `{blockId, targetKind, operation, entries}`.

- [ ] **Step 1: Return `[]SupportedActions` from the HTTP handler**

`requesthandlers/editor_handler.go:218-223`:

```go
	offers := block.DetectExtractions(req.SourceKind, req.Entries)
	if offers == nil {
		offers = []block.SupportedActions{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(offers)
```

- [ ] **Step 2: Rewrite `detectAndAppendExtractions` to render from offers**

`frontend/src/static/sieve-block-extension.js:749-812` — remove `replaceSource`/`additiveKinds`; build one menu item per (kind, action). The verb comes from the action, not a frontend flag. `sieve:extract` carries `operation`:

```js
  // The backend returns [{kind, actions}]. The frontend is a dumb renderer: it shows
  // each offered (kind, action) and plays back {operation} — no replaceSource heuristic.
  function detectAndAppendExtractions({ sourceNode, sourceKind, entries, blockId, sourcePos, extractSourceLabel }) {
    fetch('/api/detect-extractions', {
      method: 'POST',
      body: JSON.stringify({ sourceKind: sourceKind, entries: entries }),
      headers: { 'Content-Type': 'application/json' }
    }).then(function (res) { return res.json() }).then(function (offers) {
      if (!offers || offers.length === 0) return
      if (!window.SieveContextMenu || !window.SieveContextMenu.appendItems) return

      var IC = window.SieveIcons || {}
      var VERB = { extract: 'Extract as ', transform: 'Convert to ' }
      var headerLabel = 'FROM ' + (extractSourceLabel || sourceKind).toUpperCase().replace('-', ' ')
      var extraItems = [{ type: 'divider' }, { type: 'header', label: headerLabel }]

      offers.forEach(function (offer) {
        var icon = IC[offer.kind] || IC.code
        var r = renderers[offer.kind]
        var prettyKind = (r && typeof r.getFriendlyName === 'function')
          ? r.getFriendlyName()
          : offer.kind.split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1) }).join(' ')

        // Menu offers the source-mutating ops (extract/transform); paste is never shown here.
        ;(offer.actions || []).forEach(function (action) {
          if (action !== 'extract' && action !== 'transform') return

          var dispatch = function (context) {
            document.dispatchEvent(new CustomEvent('sieve:extract', {
              detail: {
                blockId: blockId || (sourceNode && sourceNode.attrs ? sourceNode.attrs.id : null),
                targetKind: offer.kind,
                operation: action,
                sourceNode: sourceNode,
                sourcePos: sourcePos,
                entries: entries,
                context: context || {}
              }
            }))
          }

          if (r && typeof r.getExtractionMenuItems === 'function') {
            var items = r.getExtractionMenuItems(sourceNode, entries, dispatch, { operation: action })
            if (items && items.length) { items.forEach(function (it) { extraItems.push(it) }); return }
          }
          extraItems.push({ icon: icon, label: VERB[action] + prettyKind, action: function () { dispatch({}) } })
        })
      })
      window.SieveContextMenu.appendItems(extraItems)
    }).catch(function () {})
  }
```

(Note: `getExtractionMenuItems` renderers now receive `{ operation }` instead of `{ replace }`. Update each renderer that reads `opts.replace` to read `opts.operation === 'transform'` — grep `grep -rn "getExtractionMenuItems\|\.replace" frontend/src/static/*.js`.)

- [ ] **Step 3: Drop `replaceSource:true` from the native-convert call**

`frontend/src/static/context-menu.js:254-261`:

```js
          window.TipTap.detectAndAppendExtractions({
            sourceNode: targetNode,
            sourceKind: targetNode.type.name,
            entries: res.entries,
            blockId: targetNode.attrs ? targetNode.attrs.id : null,
            sourcePos: targetPos,
            extractSourceLabel: res.extractSourceLabel
          })
```

(`blockId` now flows for native sources — the top-level node's `id` — so the backend can `ReplaceBlock` it on TRANSFORM.)

- [ ] **Step 4: Manual verification**

Per `project_test_perf_in_wails_app` / `project_wails_dev_rebuild_gotcha`: run `wails dev`, touch a `.go` file so the embed reloads. Right-click a native code block → "Convert to Diagram"; confirm the menu shows verbs from actions and the convert replaces the block via render-back (no double-insert, one Undo restores). Right-click a Web Clip → "Extract as …"; confirm additive.

- [ ] **Step 5: Commit**

```bash
git add requesthandlers/editor_handler.go frontend/src/static/sieve-block-extension.js frontend/src/static/context-menu.js
git commit -m "frontend: render extract menu from affordance offers; drop replaceSource/additiveKinds"
```

---

### Task 7: Frontend posts `operation`, stops swapping the source node

**Files:**
- Modify: `frontend/src/static/editor.js:2014-2076` (`sieve:extract` handler)
- Test: manual (vanilla JS)

**Interfaces:**
- Consumes: `sieve:extract` detail `{blockId, targetKind, operation, entries}`; the WS `replace-block`/`insert-block` render-back.
- Produces: WS `extract` message `{type, blockId, targetKind, operation, entries, index}`; NO `sieveInsertPos` range mutation.

- [ ] **Step 1: Remove the in-editor source-node swap; post `operation`**

`frontend/src/static/editor.js:2014-2076` — delete the `replaceSource`-driven `sieveInsertPos` range computation (2040-2048). The backend owns the mutation; the editor renders the result via the render-back. Insert position is only needed for additive ops, where the render-back's `insert-block` carries the index. Rewrite the handler:

```js
  // ── Extract / Transform (sieve:extract) ─────────────────────────────────────
  // Dumb playback: post {operation, targetKind, entries, blockId}. The backend mutates
  // (PASTE/EXTRACT -> new block, TRANSFORM -> replace block) and the render-back
  // (insert-block / replace-block) updates the editor. The frontend never swaps nodes.
  document.addEventListener('sieve:extract', function (e) {
    if (!currentUuid || !currentEditor) return
    var blockId = e.detail.blockId
    var targetKind = e.detail.targetKind
    var operation = e.detail.operation || 'extract'
    var entries = e.detail.entries || []
    var sourceNode = e.detail.sourceNode
    var context = e.detail.context || {}

    if (entries.length > 0 && Object.keys(context).length > 0) {
      entries[0].context = context
    }

    // Additive ops insert after the source's top-level position; TRANSFORM replaces by id
    // (no index needed — the backend keeps the source's position).
    var index = -1
    if (operation !== 'transform' && blockId) {
      currentEditor.state.doc.descendants(function (node, pos) {
        if (node.attrs.id === blockId) {
          index = blockIndexForInsert(pos + node.nodeSize)
          return false
        }
      })
    }

    function send(resolved) {
      wsSend({ type: 'extract', blockId: blockId, targetKind: targetKind, operation: operation, entries: resolved, index: index })
    }

    if (window.TipTap && window.TipTap.resolveEntriesForKind) {
      var res = window.TipTap.resolveEntriesForKind(targetKind, sourceNode, entries)
      if (res && typeof res.then === 'function') {
        res.then(send).catch(function (err) { console.error('[sieve:extract] failed', err) })
        return
      }
      entries = res
    }
    send(entries)
  })
```

- [ ] **Step 2: Confirm the render-back handles `replace-block`**

Grep the editor's WS message switch (`grep -n "insert-block\|block-promoted\|case '" frontend/src/static/editor.js`). Ensure a `replace-block` handler exists that swaps node[`oldId`] for the new block render (model on the existing `block-promoted`/`insert-block` handlers). If absent, add it: locate node by `oldId`, replace its range with the rendered new block (sieve node or prose), in one transaction.

- [ ] **Step 3: Manual verification (the full matrix)**

`wails dev` (+ `.go` touch). Verify:
- Paste raw mermaid → diagram block (PASTE, new).
- Web Clip block → "Extract as Code" → additive, source survives (EXTRACT).
- Native code block → "Convert to Diagram" → replaced in place, one Undo restores native (TRANSFORM via render-back).
- Promote a structured block → embeds as prose in place (TRANSFORM-to-prose, via PromoteBlock path).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "frontend: post operation, render via replace-block render-back; stop swapping source nodes"
```

---

### Task 8: Frontend split — sub-range TRANSFORM isolates the target into its own block

**Files:**
- Modify: `frontend/src/static/editor.js` (`sieve:extract` handler from Task 7; add a `splitProseAround` helper near the native split infrastructure)
- Test: manual (vanilla JS); optional vitest for the pure "is this a strict sub-range of one prose block?" predicate

**Interfaces:**
- Consumes: the editor's native PM split, the passive id-minter (observe-time), `flushSave()` / `docSyncFlush` (immediate block-op sync).
- Produces: when the transform target is a partial prose selection, three top-level blocks (`PRE`/`TARGET`/`POST`), each with a fresh id; the transform then runs on `TARGET`'s id.

**Why this is needed:** TRANSFORM replaces a block *by id*. If the target is a sub-range of a prose block (an embedded complex object being partially extracted), `ReplaceBlock(proseId)` would clobber PRE and POST. Splitting first makes TARGET an addressable top-level block, after which the normal Task 3 `ReplaceBlock(targetId)` is correct — no new backend code.

- [ ] **Step 1: Add the sub-range detection + split helper**

In `frontend/src/static/editor.js`, add near the sync/split infrastructure (≈ after `collectTopBlocks`, ~285):

```js
    // When a TRANSFORM targets a strict sub-range of ONE prose block, split that block
    // into PRE / TARGET / POST so TARGET is its own top-level block (TRANSFORM replaces
    // by id; it must not clobber PRE/POST). Returns the TARGET block's id, or null when
    // the selection already spans a whole top-level block (no split needed).
    //
    // Dup-id trap (project_node_granular_prose): splitBlock copies the `id` attr to both
    // halves. We clear `id` on every resulting fragment so the passive observer mints
    // fresh ids; we never hand-assign here.
    function splitProseAround(ed, from, to) {
      var $from = ed.state.doc.resolve(from)
      var node = $from.node($from.depth)            // the enclosing top-level prose node
      var nodeStart = $from.start($from.depth)
      var nodeEnd = nodeStart + node.content.size
      var name = node.type.name
      // Only prose (native) nodes split; a structured sieve node is already its own block.
      if (name.indexOf('sieve-') === 0) return node.attrs.id || null
      // Whole-block selection → already addressable, no split.
      if (from <= nodeStart && to >= nodeEnd) return node.attrs.id || null

      // Split at the END first (so the FROM offsets stay valid), then at the START.
      ed.chain()
        .setTextSelection(to).splitBlock()
        .setTextSelection(from).splitBlock()
        .command(function (props) {
          // Clear id on all three fragments around the original node range so the
          // observer re-mints; never reuse the parent id (dup-id trap).
          var tr = props.tr
          props.state.doc.descendants(function (n, pos) {
            if (n.isTextblock && n.attrs && n.attrs.id && pos >= nodeStart - 2 && pos <= to + 2) {
              tr.setNodeMarkup(pos, undefined, Object.assign({}, n.attrs, { id: null }))
            }
            return true
          })
          return true
        })
        .run()

      // After the two splits the TARGET is the textblock containing `from`. Resolve it.
      var $t = ed.state.doc.resolve(Math.min(from + 1, ed.state.doc.content.size))
      var target = $t.node($t.depth)
      return target && target.attrs ? (target.attrs.id || null) : null
    }
```

(Boundary arithmetic and the descendant range are the delicate part — TDD the predicate and verify the split visually. If a shared split helper already exists when implementing, prefer it over re-deriving the transaction.)

- [ ] **Step 2: Gate the `sieve:extract` handler on the split case**

In the Task 7 `sieve:extract` handler, before computing `index`/sending, branch for a partial-prose TRANSFORM. Insert after `var context = ...`:

```js
    // Sub-range TRANSFORM: if the target is a partial selection inside a prose block,
    // split it out first, sync the split to Go, then transform the isolated block.
    if (operation === 'transform' && !e.detail.wholeBlock) {
      var sel = currentEditor.state.selection
      var targetId = splitProseAround(currentEditor, sel.from, sel.to)
      if (targetId && targetId !== blockId) {
        blockId = targetId
        // The split produced new blocks (PRE/TARGET/POST). Flush the block-op sync so Go
        // has TARGET as its own block before the transform's ReplaceBlock arrives.
        if (typeof flushSave === 'function') {
          flushSave().then(function () { postExtract() }).catch(function (err) {
            console.error('[sieve:extract] split flush failed', err)
          })
          return
        }
      }
    }
    postExtract()
```

Wrap the existing index-compute + resolve + `send(...)` tail of the handler in a `function postExtract() { ... }` so both the split path and the normal path call it. (`e.detail.wholeBlock` is set true by the native code/image convert path in Task 6, where the whole top-level node IS the target — no split needed; default/undefined means "derive from selection.")

- [ ] **Step 3: Mark whole-block converts in Task 6's dispatch**

In `frontend/src/static/sieve-block-extension.js` `detectAndAppendExtractions`, the native-node convert dispatches with the whole node as target — add `wholeBlock: true` to that `sieve:extract` detail so Step 2 skips the split for code/image converts:

```js
            detail: {
              blockId: blockId || (sourceNode && sourceNode.attrs ? sourceNode.attrs.id : null),
              targetKind: offer.kind,
              operation: action,
              wholeBlock: true,
              sourceNode: sourceNode,
              sourcePos: sourcePos,
              entries: entries,
              context: context || {}
            }
```

- [ ] **Step 4: Manual verification**

`wails dev` (+ `.go` touch). Build the rare case: embed a complex Sieve object into a prose paragraph that also has text before and after it (Promote / embed), so PRE/OBJECT/POST share one block. Select just the embedded sub-element's text and "Convert to <kind>". Confirm: the paragraph splits into three blocks, PRE and POST survive as prose with their own ids, the middle becomes the new Sieve block, and one Undo is sane. Re-run the Task 7 matrix to confirm no regression for whole-block converts (which set `wholeBlock:true` and never split).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/editor.js frontend/src/static/sieve-block-extension.js
git commit -m "frontend: split prose into PRE/TARGET/POST for sub-range TRANSFORM (dup-id-safe)"
```

---

## Self-Review

**Spec coverage** (against `2026-06-24-block-affordance-recognition-design.md`):
- §1 recognition returns affordances → Task 1 (`IsSupportedContent`/`SupportedActions`).
- §2 operation IS the additive/replace decision → Task 3 (`EditorService` operation→mutation map).
- §3 round-trip carries `{operation, targetKind}` → Tasks 5–7; sub-range TRANSFORM split → Task 8.
- §4 `Context` contract → entries still carry `Context` (web-clip `mode` path untouched); `sourceType` stamping is **not** required because the team chose per-processor inline source-sniffing off the entries themselves. Documented divergence from the spec's "stamp `sourceType`" quick-win — the source identity is read directly from the `sieve/<kind>` view, so no stamping is needed. (Web-clip `mode` continues to ride `Context`.)
- "What this subsumes: prose, promote, KindProse" → Task 4 (prose broadening, `PromoteBlock` dissolution, `KindProse` :770 retired; :226 explicitly left to the separate create-provenance thread per the user's decision).
- Build order → Tasks 1–7 follow the spec's 1–5 ordering, split for reviewability.

**Divergences from the spec (intentional, team decisions in this session):**
- Method named `IsSupportedContent` (not `Offers`/`SupportedActions`); returns `SupportedActions{Kind, Actions}`.
- No `Source` abstraction — per-processor inline (Shape B). The action-inclusion logic is duplicated by design.
- `Transform` gains an `action` param (spec didn't call this out).
- Frontend does **zero** node mutation — backend owns create+replace, render-back updates the editor (stronger than the spec's "frontend posts operation"; the spec still had the frontend doing the node swap).

**Placeholder scan:** none — every step has concrete code or a concrete command. Two call sites (`ws_handler` in Task 3 step 7, renderer `getExtractionMenuItems` in Task 6 step 2) are flagged with the exact grep to find them.

**Type consistency:** `Action`, `SupportedActions{Kind, Actions []Action}`, `SupportedActions.Has`, `IsSupportedContent(entries) SupportedActions`, `Transform(entries, uuid, blockID, action)`, `CreateBlockFromEntries(uuid, kind, entries, index, action, sourceID)`, `OnBlockReplaced(uuid, oldID, newKind, newID, attrs, markdown)` — used consistently across tasks.

---

# IMPLEMENTATION STATUS & BACKLOG (updated 2026-06-25)

**Branch:** `feature/transform_operation_frameworkk`. Base of this work: `78bf9f8`. The feature is **implemented and stabilized** (~24 commits). All Go suites + `go build`/`vet`/`-race` green; vitest **123** green. App-verified by the user through many in-app rounds; **not yet merged or formally code-reviewed beyond the per-task + whole-branch reviews captured below.** The blow-by-blow lives in `.superpowers/sdd/progress.md` (gitignored ledger).

## What shipped
- **Backend (Tasks 1–5):** recognition contract `IsBlock→IsSupportedContent(entries) SupportedActions{Kind,Actions}`; action-inclusion rule (native→Transform, sieve-view→Extract, paste always); registry composes `[]SupportedActions`; `EditorService` operation→mutation map (PASTE/EXTRACT create; TRANSFORM = `ReplaceBlock` in place preserving id+position) + `OnBlockReplaced` render-back; WS `handleExtract` round-trips `{operation, blockId}`; prose is the universal sink (claims any source for TRANSFORM); `PromoteBlock` + the bespoke promote/`OnBlockPromoted` chain fully retired.
- **Frontend (Tasks 6, 7 — and a major reshape):** extract menu renders from affordance offers; **operations render as TRACKED incremental insert/replace (`insert-block` at server `msg.index`; `editor:replace-block` by id) — preserving undo.** Caret/scroll: generic refocus-after-insert (caret after the new block; code/diagram self-focus; AI excluded). Toolbar image sends the pre-dialog captured index.
- **`block-position.js`** — extracted, pure, **tested** (`blockIndexForInsert`/`docPosForBlockIndex`/`blockIndexAfter` (top-level-only)/`enclosingBlockId`). This is the regression gate the frontend lacked.

## KEY DECISIONS / ARCHITECTURE (read these first next session)
- **Backend ShadowDoc is the document source of truth.** Frontend places the server's node at the server's index as a **tracked** PM transaction; **NEVER `softReloadContent` for an operation** (`renderBlocksIntoEditor`'s `replaceWith + addToHistory:false` WIPES undo — that was the deal-breaker). `softReload` only for genuine doc *loads*. (In CLAUDE.md + memory `feedback_backend_is_doc_source_of_truth`.)
- **A dual-use ES module (`export` + `window.TipTap` assign) MUST be `<script type="module">`** in index.html — a plain `<script>` throws on `export` and nukes ALL the globals (this regression broke every create/insert path once; fixed in `e91fd80`).
- **`wails dev` embed gotcha:** `/static/*.js` is live from disk, but **`index.html` changes need a `.go` touch / restart** to re-embed. Several fixes here touched index.html.
- **Multi-child prose** = ONE `proseGroup` container node carrying the id (`prose-group.js`); handled as a single addressable top-level block by all positioning/replace paths.

## KNOWN DEFECTS / REGRESSIONS (prioritized)
1. **✅ FIXED 2026-06-28 (`188cc9c`) — [DATA LOSS] Transforming a sub-element inside a composite clobbered the parent.** Click a code block rendered *inside* an AI block / web-clip → the menu dispatched `sieve:extract` with `blockId = <parent composite id>`; if `TRANSFORM` was chosen, `ReplaceBlock(parentId)` replaced the WHOLE AI block → response lost. **Fix (TDD, framework-layer structural-safety filter):** frontend stamps `ContentEntry.Context["parentId"]` in `sieve-block-extension.js`'s else-branch when sub-content inside a `sieve-*` block is the source; `ContentEntry.NestedParentID()` reads it; `SupportedActions.asAdditive()` demotes any `Transform → Extract`; `DetectExtractions` applies it to every offer when any entry is nested. `EXTRACT` positions off `blockId=parentId` → copy lands after the surviving parent. Go test `TestDetectExtractions_nestedSourceNeverOffersTransform`. Kept at framework layer (not per-processor) because the invariant — a nested source has no id of its own, so in-place replace is structurally unsafe — is universal across kinds; per-processor would be N duplicated checks (a new processor would reintroduce the bug). Escape hatch if a kind ever needs nested in-place transform: an opt-out interface mirroring `SelfExtractable` (YAGNI now). **Divergence from the original note:** label reads "Extract as X" (the natural result of the demoted offer), NOT the planned "Convert to X" — when the parent survives, "Extract as X" is the honest wording; deferred the label-override to defect #2's `affordanceLabel` hook rather than special-case it. This also **dodges Task 8's split** for composites.
2. **Card → Link (block → INLINE transform) loses the node.** `smart-link` is `BlockModeInline`; `replace-block` can't stand an inline node at top level → node disappears. **Deferred** (inline kinds are "undefined territory" per the user). Next step: stop *offering* inline kinds as `TRANSFORM` targets at all, and add a per-kind `affordanceLabel(kind, action)` hook (also fixes the prose "Embed in Document" special-case generically).
3. **Native top-level node transform → empty `blockId`** (`context-menu.js`): if a native code/image is ever a *direct* doc child (not wrapped in prose), `enclosingBlockId` returns `''` → backend "no source block id". Confirm whether native nodes can be top-level in this model; if so, guard/mint.
4. **Empty code block on load** (`co-9df2`): `blockToNodes` produced an empty `<div data-kind=code>` during `mountWysiwyg`. Separate from the affordance work; chase with a `block-render` unit test if it recurs.
5. **✅ FIXED 2026-06-28 (`5a59c45`) — `prose.Transform` embed mangled code source.** Embedding a code/diagram/log block into prose ("Embed in Document" — the escape hatch when smart-detection over-grabbed text as code) stored the raw `attrs["source"]` as prose markdown. Code source is markdown-significant: 4-space indents → indented code block (stray fence), bare newlines → soft-join → the user's "split header and tail lines." Fix: `ProseProcessor.sourceAsPlainText` de-indents each line + joins with markdown hard breaks, dropping blank lines. Renders as one clean text paragraph, never a fence; indentation intentionally dropped (it's text now). Go test renders via goldmark and asserts no `<pre>`, hard breaks present, source preserved. **Confirmed intent with user:** the goal is plain TEXT, not preserving code — fenced/indented embedding was explicitly rejected. **SUPERSEDED 2026-06-28 by the `2026-06-28-undo-smart-paste` plan:** the `5a59c45` interim fix conflated two intents into one verb. They are now split — "Embed in Document" (`ActionTransform`) reverts to faithful `MarkdownRepresentation` (a fence), and the de-indent-to-text behaviour moves to a separate framework-detected `ActionUndoSmartPaste` (gated on the `smartPaste` tag stamped on pass-2 detection pastes). `sourceAsPlainText` is retained, now reached only via the undo path.

## WORK-ONS / BACKLOG (not blocking, from the whole-branch review)
- **`prose.Transform` hard-codes `code/diagram/log` by kind name** — a new source kind using `attrs["source"]` won't be found. Generalize via a `RawContent()` optional interface (type-assertion), or always try `MarkdownRepresentation` first and fall back.
- **web-clip duplicate menu items** if a single source ever offers both `extract` and `transform` (`getExtractionMenuItems` runs per-action) — latent; add a guard.
- **`DetectExtractions` offer ordering** is unspecified (no prose-last like `FirstPasteMatch`) — sort or document.
- **Task 8 (prose sub-range split, `PRE/TARGET/POST`)** — still parked; needed only for *moving* a child out of a multi-child prose block (composites are covered by defect #1's additive approach). Mind the `splitBlock` dup-id trap; when built, `replace-block` must switch to a top-level-only scan.
- **Minor cleanup:** dead `sieveInsertPos = null` in smart-paste no-match/catch branches; comment typos in `prose_processor.go`; `found2` shadowing in `editor_service_promote_test.go`.
- **Test-coverage gaps (the hand-patched seams):** `editor:replace-block` handler; refocus-after-insert branch; the toolbar `__sieveCapturedInsertIndex` cross-file bridge; `transformInPlace` not-found + Transform-decline paths; `DetectExtractions` self-exclusion/ordering. These are exactly where the in-app bugs lived — a few integration-ish tests would pay off before merge.

## WHOLE-BRANCH REVIEW (2026-06-25) — verdict: ship-with-fixes
Two independent reviewers (frontend/opus, backend/sonnet) confirmed the invariants hold (no softReload-for-ops; positioning round-trips through tested helpers; module loading correct; prose skip-if-present intact; PromoteBlock retired). **Real fix applied (`be9a41d`):** prose embed guards nil/empty `source` (was a silent blank block) + `docPosForBlockIndex` guards negative idx; both with tests. Two flagged "Criticals" adjudicated as NOT bugs (transform preserves id → no spurious delete-block; negative-index already defended by backend clamp + refocus guard). Everything else is the backlog above.
