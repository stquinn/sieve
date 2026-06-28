# Undo Smart Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un-fuse "Embed in Document" (faithful markdown) from the smart-paste escape hatch by adding a framework-detected, framework-actioned `ActionUndoSmartPaste` transformation.

**Architecture:** "Undo Smart Paste" is a first-class `block.Action` that flows through the existing recognition→action pipeline (`IsSupportedContent` → `DetectExtractions` → `CreateBlockFromEntries` → render-back). Detection lives in `ProseProcessor` (the kind that owns the result); the action reuses the existing `transformInPlace` replace-by-id mechanic and the existing `sourceAsPlainText` helper. The frontend stays dumb: it renders whatever offers come back and maps the action enum to a label.

**Tech Stack:** Go (chi, goldmark), vanilla JS (TipTap island), vitest, `go test`.

## Global Constraints

- **No loose/free functions.** Behaviour attaches to the owning type/service.
- **Backend ShadowDoc is the document source of truth.** Operations render as TRACKED incremental insert/replace; never `softReloadContent` for an operation.
- **TDD.** Failing test first, watch it fail, minimal code, watch it pass, commit.
- **Spec:** `docs/superpowers/specs/2026-06-28-undo-smart-paste-design.md`.
- Run Go tests with `go test ./<pkg>/ -run <Name> -v`; full suite `go test ./...`; frontend `cd frontend && npx vitest run`.

---

### Task 1: `ActionUndoSmartPaste` constant + `RawContenter` optional interface

**Files:**
- Modify: `sieve/block/processor_registry.go` (Action constants ~`:99-103`; add `RawContenter` interface near `SelfExtractable` ~`:438`)
- Modify: `sieve/block/processors/code_processor.go` (add `RawContent`)
- Modify: `sieve/block/processors/diagram_processor.go` (add `RawContent`)
- Modify: `sieve/block/processors/log_processor.go` (add `RawContent`)
- Test: `sieve/block/processors/code_processor_test.go`

**Interfaces:**
- Produces: `block.ActionUndoSmartPaste Action = "undo-smart-paste"`; `block.RawContenter` interface `{ RawContent() string }`; `CodeBlockProcessor.RawContent(block.SieveBlock) string`, same for diagram/log — each returns the block's `source` attr.

- [ ] **Step 1: Write the failing test**

In `sieve/block/processors/code_processor_test.go`:

```go
func TestCodeBlockProcessor_RawContent_returnsSource(t *testing.T) {
	var p CodeBlockProcessor
	blk := block.NewSieveBlock("code", "co-1", map[string]interface{}{"source": "x = 1\ny = 2"})
	if got := p.RawContent(blk); got != "x = 1\ny = 2" {
		t.Errorf("RawContent = %q, want the source verbatim", got)
	}
	empty := block.NewSieveBlock("code", "co-2", map[string]interface{}{})
	if got := p.RawContent(empty); got != "" {
		t.Errorf("RawContent of source-less block = %q, want empty", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/block/processors/ -run TestCodeBlockProcessor_RawContent_returnsSource -v`
Expected: FAIL — `p.RawContent undefined`.

- [ ] **Step 3: Add the Action constant and interface**

In `sieve/block/processor_registry.go`, add to the Action const block (after `ActionTransform`):

```go
	ActionUndoSmartPaste Action = "undo-smart-paste" // replace a smart-pasted block with its raw text as prose
```

Near `SelfExtractable` add (the method takes the block, since the raw text lives in its attrs):

```go
// RawContenter is the optional interface a processor implements to expose the raw
// source text its block was built from. Used by "Undo Smart Paste" to recover the
// pre-detection text, and lets prose embedding avoid hard-coding source-bearing kinds
// by name. A kind that has no raw text simply does not implement it.
type RawContenter interface {
	RawContent(blk SieveBlock) string
}
```

- [ ] **Step 4: Implement `RawContent` on the three processors**

In `code_processor.go`, `diagram_processor.go`, `log_processor.go` add (adjust receiver type per file: `*CodeBlockProcessor`, `*DiagramProcessor`, `*LogProcessor`):

```go
// RawContent returns the source text this block was built from (block.RawContenter).
func (p *CodeBlockProcessor) RawContent(blk block.SieveBlock) string {
	src, _ := blk.Attrs["source"].(string)
	return src
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./sieve/block/processors/ -run TestCodeBlockProcessor_RawContent_returnsSource -v` → PASS
Run: `go build ./...` → no errors.

- [ ] **Step 6: Commit**

```bash
git add sieve/block/processor_registry.go sieve/block/processors/code_processor.go sieve/block/processors/diagram_processor.go sieve/block/processors/log_processor.go sieve/block/processors/code_processor_test.go
git commit -m "block: ActionUndoSmartPaste + RawContenter interface (code/diagram/log expose source)"
```

---

### Task 2: Stamp `smartPaste` on pass-2 (detection) pastes only

**Files:**
- Modify: `sieve/block/processor_registry.go` (`FirstPasteMatch` ~`:500`)
- Modify: `sieve/services/editor_service.go` (`HandlePaste` ~`:517`)
- Test: `sieve/services/editor_service_action_test.go`

**Interfaces:**
- Consumes: `block.FirstPasteMatch`.
- Produces: `FirstPasteMatch(entries) (kind string, processor BlockProcessor, fromDetection bool, ok bool)` — `fromDetection` is true only for the pass-2 general-detection match (false for a pass-1 self-kind round-trip). `HandlePaste` stamps `overrides["smartPaste"] = true` when `fromDetection`.

- [ ] **Step 1: Write the failing test**

In `sieve/services/editor_service_action_test.go`:

```go
func TestHandlePaste_stampsSmartPaste_onDetectionOnly(t *testing.T) {
	es, uuid := newEditorServiceWithDoc(t)

	// Pass-2 detection: raw text that looks like code (no sieve view) → tagged.
	_, id, _, ok := es.HandlePaste(uuid, []block.ContentEntry{
		{MIMEType: "text/plain", Content: "function f() {\n  return 1;\n}"},
	}, -1)
	if !ok {
		t.Fatal("expected detection paste to match")
	}
	blk, _ := es.SnapshotBlockForTest(uuid, id)
	if blk.Attrs["smartPaste"] != true {
		t.Errorf("detected paste must be tagged smartPaste; attrs=%v", blk.Attrs)
	}

	// Pass-1 round-trip: a copied code block's own sieve view → NOT tagged.
	_, id2, _, ok2 := es.HandlePaste(uuid, []block.ContentEntry{
		{MIMEType: "sieve/code", Content: `{"source":"x = 1\ny = 2","language":"python"}`},
	}, -1)
	if !ok2 {
		t.Fatal("expected round-trip paste to match")
	}
	blk2, _ := es.SnapshotBlockForTest(uuid, id2)
	if blk2.Attrs["smartPaste"] == true {
		t.Errorf("round-trip paste must NOT be tagged smartPaste; attrs=%v", blk2.Attrs)
	}
}
```

If `newEditorServiceWithDoc` / `SnapshotBlockForTest` helpers don't exist in this test file, model them on the existing setup in `editor_service_action_test.go` (it already constructs an `EditorService` with an open doc for `TestCreateBlockFromEntries_*`); reuse whatever it uses to snapshot a block by id (`shadow.SnapshotBlock`).

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/services/ -run TestHandlePaste_stampsSmartPaste_onDetectionOnly -v`
Expected: FAIL — either a compile error on the 4-return `FirstPasteMatch` (not yet) or `smartPaste` not set.

- [ ] **Step 3: Make `FirstPasteMatch` report the matching pass**

In `processor_registry.go`, change the signature to add `fromDetection bool` and set it per pass:

```go
func FirstPasteMatch(entries []ContentEntry) (kind string, processor BlockProcessor, fromDetection bool, ok bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()

	// Pass 1 — self-kind round-trip (NOT detection).
	for _, e := range entries {
		k, _, sieveOK := e.SieveAttrs()
		if !sieveOK {
			continue
		}
		for i := range pasteMatchers {
			if pasteMatchers[i].Kind == k && pasteMatchers[i].Processor.IsSupportedContent(entries).Has(ActionPaste) {
				return pasteMatchers[i].Kind, pasteMatchers[i].Processor, false, true
			}
		}
	}

	// Pass 2 — general detection (smart paste being clever).
	proseIdx := -1
	for i := range pasteMatchers {
		if pasteMatchers[i].Processor.Mode() == BlockModeProse {
			proseIdx = i
			continue
		}
		if pasteMatchers[i].Processor.IsSupportedContent(entries).Has(ActionPaste) {
			return pasteMatchers[i].Kind, pasteMatchers[i].Processor, true, true
		}
	}
	if proseIdx >= 0 && pasteMatchers[proseIdx].Processor.IsSupportedContent(entries).Has(ActionPaste) {
		return pasteMatchers[proseIdx].Kind, pasteMatchers[proseIdx].Processor, true, true
	}
	return "", nil, false, false
}
```

(Prose is `BlockModeProse`; a prose match in pass 2 is still "detected" — pasting raw text that nothing else claimed. That is fine: an undo of a prose paste finds no `RawContent` to offer, so it is never surfaced.)

- [ ] **Step 4: Stamp in `HandlePaste`**

In `editor_service.go` `HandlePaste`, update the call and stamp:

```go
func (es *EditorService) HandlePaste(uuid string, entries []block.ContentEntry, index int) (kind, id, rawYaml string, matched bool) {
	matchKind, processor, fromDetection, ok := block.FirstPasteMatch(entries)
	if !ok {
		return "", "", "", false
	}
	blockID := block.GenerateBlockIDFor(matchKind)
	overrides := processor.Transform(entries, uuid, blockID, block.ActionPaste)
	if fromDetection {
		if overrides == nil {
			overrides = map[string]interface{}{}
		}
		overrides["smartPaste"] = true
	}
	id, raw, err := es.createBlockWithID(uuid, matchKind, blockID, overrides, nil, index)
	if err != nil {
		return "", "", "", false
	}
	return matchKind, id, raw, true
}
```

- [ ] **Step 5: Run tests**

Run: `go test ./sieve/services/ -run TestHandlePaste_stampsSmartPaste_onDetectionOnly -v` → PASS
Run: `go build ./...` → no errors (the only other `FirstPasteMatch` caller is `HandlePaste`).

- [ ] **Step 6: Commit**

```bash
git add sieve/block/processor_registry.go sieve/services/editor_service.go sieve/services/editor_service_action_test.go
git commit -m "paste: stamp smartPaste on pass-2 detection only (FirstPasteMatch reports the pass)"
```

---

### Task 3: Detection — `ProseProcessor.IsSupportedContent` offers `undo-smart-paste`

**Files:**
- Modify: `sieve/block/processors/prose_processor.go` (`IsSupportedContent` ~`:99-117`)
- Test: `sieve/block/processors/prose_processor_test.go`

**Interfaces:**
- Consumes: `block.ActionUndoSmartPaste`, `block.RawContenter`, `block.GetProcessor`.
- Produces: prose's offer for an entry whose sieve view has `smartPaste==true` and whose source kind's `RawContent` is non-empty includes `ActionUndoSmartPaste` (alongside the existing `ActionTransform`).

- [ ] **Step 1: Write the failing test**

In `prose_processor_test.go`:

```go
func TestProseProcessor_IsSupportedContent_offersUndoForTaggedSource(t *testing.T) {
	block.ResetRegistry()
	block.RegisterProcessor(&CodeBlockProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "code"}})
	defer block.UnregisterProcessor("code")
	var p ProseProcessor

	tagged := []block.ContentEntry{{MIMEType: "sieve/code", Content: `{"source":"x = 1\ny = 2","smartPaste":true}`}}
	if !p.IsSupportedContent(tagged).Has(block.ActionUndoSmartPaste) {
		t.Error("tagged smart-pasted source must offer undo-smart-paste")
	}

	plain := []block.ContentEntry{{MIMEType: "sieve/code", Content: `{"source":"x = 1\ny = 2"}`}}
	if p.IsSupportedContent(plain).Has(block.ActionUndoSmartPaste) {
		t.Error("a hand-made (untagged) source must NOT offer undo-smart-paste")
	}
	if !p.IsSupportedContent(plain).Has(block.ActionTransform) {
		t.Error("prose must still offer transform (embed) for any sieve source")
	}
}
```

(`CodeBlockProcessor`'s struct/registration: copy the exact zero-value construction the existing `code_processor_test.go` uses to register a processor.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/block/processors/ -run TestProseProcessor_IsSupportedContent_offersUndoForTaggedSource -v`
Expected: FAIL — `undo-smart-paste` not offered.

- [ ] **Step 3: Implement the detection branch**

In `prose_processor.go` `IsSupportedContent`, replace the foreign-sieve branch:

```go
		if _, attrs, ok := e.SieveAttrs(); ok {
			// Any other block source → embed it as prose (the universal sink).
			actions := []block.Action{block.ActionTransform}
			// Smart-pasted source with recoverable raw text → also offer "Undo Smart
			// Paste" (revert detection to the raw text). Detection-and-action are both
			// framework-side; the frontend never decides whether to offer it.
			if sp, _ := attrs["smartPaste"].(bool); sp && p.taggedSourceHasRawText(e) {
				actions = append(actions, block.ActionUndoSmartPaste)
			}
			return block.SupportedActions{Kind: p.Kind(), Actions: actions}
		}
```

Add the helper method (owning type = ProseProcessor; no free funcs):

```go
// taggedSourceHasRawText reports whether the entry's sieve source kind can recover raw
// text (block.RawContenter with a non-empty result). Undo with nothing to revert to is
// not offered.
func (p *ProseProcessor) taggedSourceHasRawText(e block.ContentEntry) bool {
	kind, attrs, ok := e.SieveAttrs()
	if !ok {
		return false
	}
	proc := block.GetProcessor(kind)
	rc, isRaw := proc.(block.RawContenter)
	if proc == nil || !isRaw {
		return false
	}
	return strings.TrimSpace(rc.RawContent(block.NewSieveBlock(kind, "", attrs))) != ""
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./sieve/block/processors/ -run TestProseProcessor_IsSupportedContent_offersUndoForTaggedSource -v` → PASS
Run: `go test ./sieve/block/ -run TestDetectExtractions -v` → PASS (composition unaffected).

- [ ] **Step 5: Commit**

```bash
git add sieve/block/processors/prose_processor.go sieve/block/processors/prose_processor_test.go
git commit -m "prose: offer undo-smart-paste for tagged sources with recoverable raw text"
```

---

### Task 4: Action — `prose.Transform` branches on action; `CreateBlockFromEntries` routes undo

**Files:**
- Modify: `sieve/block/processors/prose_processor.go` (`Transform` ~`:123`)
- Modify: `sieve/services/editor_service.go` (`CreateBlockFromEntries` ~`:535-551`)
- Test: `sieve/block/processors/prose_processor_test.go` (rewrite the existing embed test + add the transform-fence test)

**Interfaces:**
- Consumes: `block.ActionTransform`, `block.ActionUndoSmartPaste`, `RawContenter`, `MarkdownRepresentation`, `p.sourceAsPlainText`.
- Produces: `prose.Transform` with `ActionTransform` for a code/diagram/log source returns its fenced `MarkdownRepresentation`; with `ActionUndoSmartPaste` returns de-indented hard-broken plain text. `CreateBlockFromEntries` routes `ActionUndoSmartPaste` to `transformInPlace`.

- [ ] **Step 1: Rewrite the existing test + add the transform-fence test**

Replace `TestProseProcessor_Transform_codeSourceEmbedsAsSafePlainText` in `prose_processor_test.go` with two tests:

```go
// Embed in Document (ActionTransform) is faithful markdown: a code source becomes a fence.
func TestProseProcessor_Transform_embedReturnsFence(t *testing.T) {
	block.ResetRegistry()
	block.RegisterProcessor(&CodeBlockProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "code"}})
	defer block.UnregisterProcessor("code")
	var p ProseProcessor
	entries := []block.ContentEntry{{MIMEType: "sieve/code", Content: `{"language":"java","source":"class A {}"}`}}

	content, _ := p.Transform(entries, "", "", block.ActionTransform)["content"].(string)
	if !strings.Contains(content, "```") || !strings.Contains(content, "class A {}") {
		t.Errorf("ActionTransform must embed as a fence, got:\n%s", content)
	}
}

// Undo Smart Paste (ActionUndoSmartPaste) is the escape hatch: raw text, no stray fence.
func TestProseProcessor_Transform_undoReturnsSafePlainText(t *testing.T) {
	block.ResetRegistry()
	block.RegisterProcessor(&CodeBlockProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "code"}})
	defer block.UnregisterProcessor("code")
	var p ProseProcessor
	src := "public class Greeter {\n    private final String name;\n\n    public Greeter(String name) {\n        this.name = name;\n    }\n}"
	entries := []block.ContentEntry{{MIMEType: "sieve/code", Content: `{"language":"java","source":` + strconv.Quote(src) + `}`}}

	content, _ := p.Transform(entries, "", "", block.ActionUndoSmartPaste)["content"].(string)
	if strings.TrimSpace(content) == "" {
		t.Fatal("expected content, got empty")
	}
	var buf bytes.Buffer
	if err := goldmark.New().Convert([]byte(content), &buf); err != nil {
		t.Fatal(err)
	}
	html := buf.String()
	if strings.Contains(html, "<pre") {
		t.Errorf("undo rendered as a code block (stray fence):\n%s", html)
	}
	if !strings.Contains(html, "<br") {
		t.Errorf("undo lines soft-joined (no hard break):\n%s", html)
	}
	for _, want := range []string{"public class Greeter {", "private final String name;", "this.name = name;"} {
		if !strings.Contains(html, want) {
			t.Errorf("expected source line %q preserved, got:\n%s", want, html)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./sieve/block/processors/ -run 'TestProseProcessor_Transform_(embedReturnsFence|undoReturnsSafePlainText)' -v`
Expected: FAIL — `embedReturnsFence` fails (current code returns de-indented text, not a fence).

- [ ] **Step 3: Branch `prose.Transform` on the action**

In `prose_processor.go` `Transform`, replace the foreign-sieve branch (the `if kind == "code" || ...` block plus the MarkdownRepresentation fallback) with:

```go
		// A foreign sieve source. Two prose-targeted transforms share this entry:
		//   ActionUndoSmartPaste → the source's raw text as plain prose (escape hatch).
		//   ActionTransform      → faithful markdown ("Embed in Document").
		if kind, attrs, ok := e.SieveAttrs(); ok {
			proc := block.GetProcessor(kind)
			if action == block.ActionUndoSmartPaste {
				if rc, isRaw := proc.(block.RawContenter); isRaw {
					if raw := rc.RawContent(block.NewSieveBlock(kind, "", attrs)); strings.TrimSpace(raw) != "" {
						return map[string]interface{}{"content": p.sourceAsPlainText(raw)}
					}
				}
			}
			if proc != nil {
				src := block.NewSieveBlock(kind, "", attrs)
				if md := proc.MarkdownRepresentation(src); strings.TrimSpace(md) != "" {
					return map[string]interface{}{"content": md}
				}
			}
		}
```

Note the `Transform` signature already binds the action — change `_ block.Action` to `action block.Action` in the method signature.

- [ ] **Step 4: Route `ActionUndoSmartPaste` to replace-in-place**

In `editor_service.go` `CreateBlockFromEntries`, broaden the transform guard:

```go
	if action == block.ActionTransform || action == block.ActionUndoSmartPaste {
		return es.transformInPlace(uuid, kind, processor, entries, sourceID)
	}
```

`transformInPlace` already passes `block.ActionTransform` to `processor.Transform`; change it to pass the caller's action through so prose picks the right derivation:

```go
func (es *EditorService) transformInPlace(uuid, kind string, processor block.BlockProcessor, entries []block.ContentEntry, sourceID string, action block.Action) (id, rawYaml string, err error) {
	...
	overrides := processor.Transform(entries, uuid, sourceID, action)
	...
}
```

Update its two call sites in `CreateBlockFromEntries` to pass `action`.

- [ ] **Step 5: Run tests**

Run: `go test ./sieve/block/processors/ -run 'TestProseProcessor_Transform' -v` → PASS
Run: `go test ./sieve/services/ -run TestCreateBlockFromEntries -v` → PASS (existing transform tests still green)
Run: `go build ./...` → no errors.

- [ ] **Step 6: Commit**

```bash
git add sieve/block/processors/prose_processor.go sieve/services/editor_service.go sieve/block/processors/prose_processor_test.go
git commit -m "prose+editor: Embed=MarkdownRepresentation, UndoSmartPaste=raw text; route undo to replace-in-place"
```

---

### Task 5: Frontend — declare `smartPaste` attr + render the "Undo Smart Paste" menu item

**Files:**
- Modify: `frontend/src/static/sieve-block-extension.js` (`BASE_ATTRS` ~`:150`; `buildSieveBlockHTML` ~`:682-687`; menu in `detectAndAppendExtractions` ~`:747-790`)
- Modify: `frontend/src/static/editor.js` (`sieve:extract` index guard ~`:2088`)
- Test: `frontend/test/undo-smart-paste-menu.test.js` (new)

**Interfaces:**
- Consumes: the backend offer `{kind:"prose", actions:[..., "undo-smart-paste"]}`; node attr `smartPaste`.
- Produces: a menu item labelled "Undo Smart Paste" for `action === 'undo-smart-paste'`; `smartPaste` round-trips YAML→node→framework view; the extract dispatch treats `undo-smart-paste` as replace-in-place (no insert index).

- [ ] **Step 1: Write the failing vitest**

Create `frontend/test/undo-smart-paste-menu.test.js`. Mirror the structure of an existing menu/label test (check `frontend/test/` for one exercising `detectAndAppendExtractions` or the VERB map; if none isolate the label mapping). The pure assertion to lock:

```js
import { describe, it, expect } from 'vitest'
// labelForAction is the small pure map extracted from detectAndAppendExtractions.
import { labelForAction } from '../src/static/affordance-label.js'

describe('affordance menu labels', () => {
  it('labels undo-smart-paste as "Undo Smart Paste"', () => {
    expect(labelForAction('undo-smart-paste', 'Code')).toBe('Undo Smart Paste')
  })
  it('labels prose transform as "Embed in Document"', () => {
    expect(labelForAction('transform', 'Text', { kind: 'prose' })).toBe('Embed in Document')
  })
  it('labels extract as "Extract as <kind>"', () => {
    expect(labelForAction('extract', 'Code')).toBe('Extract as Code')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run undo-smart-paste-menu`
Expected: FAIL — `affordance-label.js` missing.

- [ ] **Step 3: Extract the label map to a tested pure module**

Create `frontend/src/static/affordance-label.js`:

```js
// labelForAction maps an affordance action (+ optional offer context) to its menu
// label. Pure and tested so the verb wording has a regression gate.
export function labelForAction(action, prettyKind, offer) {
  offer = offer || {}
  if (action === 'undo-smart-paste') return 'Undo Smart Paste'
  // Prose's transform is "flatten into the document" — not "convert to a kind".
  if (offer.kind === 'prose' && action === 'transform') return 'Embed in Document'
  var VERB = { extract: 'Extract as ', transform: 'Convert to ' }
  return (VERB[action] || '') + prettyKind
}

if (typeof window !== 'undefined') {
  window.TipTap = window.TipTap || {}
  window.TipTap.labelForAction = labelForAction
}
```

Load it as a module in `frontend/src/index.html` alongside the other `<script type="module">` block extensions (a dual-use `export` + `window` module MUST be `type="module"`).

- [ ] **Step 4: Use it in the menu + allow the action through**

In `sieve-block-extension.js` `detectAndAppendExtractions`, update the action filter and label:

```js
        ;(offer.actions || []).forEach(function (action) {
          if (action !== 'extract' && action !== 'transform' && action !== 'undo-smart-paste') return
          ...
          var isEmbed = offer.kind === 'prose' && action === 'transform'
          extraItems.push({
            icon: isEmbed ? (IC.promote || icon) : icon,
            label: (window.TipTap.labelForAction || function (a, k) { return a + ' ' + k })(action, prettyKind, offer),
            action: function () { dispatch({}) }
          })
```

- [ ] **Step 5: Declare the `smartPaste` node attr + emit `data-smart-paste`**

In `sieve-block-extension.js` `BASE_ATTRS` add (model on `supportsEmbedding`):

```js
    smartPaste: { default: false, parseHTML: function (el) { return el.getAttribute('data-smart-paste') === 'true' } },
```

In `buildSieveBlockHTML`, after the `supportsEmbedding` block:

```js
    if (data.smartPaste) {
      htmlAttrs.push('data-smart-paste="true"')
    }
```

- [ ] **Step 6: Treat `undo-smart-paste` as replace-in-place in the dispatch**

In `editor.js` (~`:2088`), change the index guard so an undo doesn't compute an insert index:

```js
    var index = -1
    if (operation !== 'transform' && operation !== 'undo-smart-paste' && blockId) {
```

- [ ] **Step 7: Run tests**

Run: `cd frontend && npx vitest run` → all green (123 + new).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/static/affordance-label.js frontend/src/static/sieve-block-extension.js frontend/src/static/editor.js frontend/src/index.html frontend/test/undo-smart-paste-menu.test.js
git commit -m "frontend: render Undo Smart Paste from offers; smartPaste node attr round-trip"
```

---

### Task 6: Full-suite verification + manual in-app check

**Files:** none (verification only).

- [ ] **Step 1: Run everything**

Run: `go build ./... && go vet ./... && go test ./...` → all PASS
Run: `cd frontend && npx vitest run` → all PASS

- [ ] **Step 2: Manual verification** (`wails dev`; touch a `.go` file so the embed reloads — index.html changed in Task 5)

- Paste raw bracketed text that mis-detects as **code** → block carries the tag. Right-click → menu shows **both** "Embed in Document" and "Undo Smart Paste".
- "Undo Smart Paste" → the block is replaced in place by clean de-indented prose, **no stray fence**, one Undo restores the code block.
- "Embed in Document" on a code block → a native ` ```lang ` fence (faithful markdown), not flattened text.
- Copy an existing code block, paste it back (round-trip) → **no** "Undo Smart Paste" offered.
- Reload the doc → the tag persists; "Undo Smart Paste" still offered on the smart-pasted block.

- [ ] **Step 3: Update the affordance plan ledger**

In `docs/superpowers/plans/2026-06-24-block-affordance-recognition.md`, note that the prose-embed behaviour is now split (Embed=markdown, Undo=text) per the `2026-06-28-undo-smart-paste` plan, superseding the `5a59c45` interim fix.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-06-24-block-affordance-recognition.md
git commit -m "docs: record Embed/Undo split shipped (supersedes 5a59c45 interim prose-embed fix)"
```

---

## Self-Review

**Spec coverage:**
- §1 `ActionUndoSmartPaste` first-class Action → Task 1.
- §2 Detection in `ProseProcessor.IsSupportedContent` (tagged + RawContent) → Task 3.
- §3 Action: `prose.Transform` branches; `CreateBlockFromEntries` routes undo → Task 4.
- §4 Tagging: pass-2 stamp, persist, `RawContent()` interface → Tasks 1 (interface) + 2 (stamp); persistence falls out of attrs→YAML (existing FencedSerializer) and attrs→node (Task 5).
- §5 Frontend dumb: attr round-trip + label → Task 5.
- §6 Reverts `0d1b789`/`5a59c45` prose branch → Task 4 Step 3 (the de-indent branch is replaced by action branching).

**Placeholder scan:** none — every code step shows the code. Two seams cite "model on the existing X" with the exact existing symbol to copy (test setup in `editor_service_action_test.go`; a vitest in `frontend/test/`); these are real, locatable references, not TBDs.

**Type consistency:** `ActionUndoSmartPaste`, `RawContenter.RawContent(SieveBlock) string`, `FirstPasteMatch(...) (kind, processor, fromDetection, ok)`, `transformInPlace(..., action block.Action)`, `labelForAction(action, prettyKind, offer)` — used consistently across tasks. The `RawContenter` signature is settled (takes `SieveBlock`) in Task 1 Step 4 and consumed with that shape in Tasks 3 and 4.

**Scope:** single subsystem (the affordance pipeline), one plan.
