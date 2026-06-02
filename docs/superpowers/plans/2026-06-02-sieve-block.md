# SieveBlock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Go processor registry and JS renderer infrastructure with `code` as the first SieveBlock, proving user-editable source and AI language detection end-to-end; include a `diagram` stub to prove extensibility.

**Architecture:** One `BlockProcessor` interface in the `sieve` package drives all block kinds. `EditorService.HandlePaste` runs ordered paste matchers; `EditorService.RunJob` dispatches background jobs. A `SieveCode` TipTap node intercepts `code` fences, renders a contenteditable NodeView, sends `block-update` via WebSocket on source edit, and updates `rawYaml` when Go notifies `block-attrs-updated` on job completion.

**Tech Stack:** Go 1.25, `sieve/sieve/fencedblock`, yaml.v3, vanilla JS ES module, TipTap 2, jsyaml.

**Prerequisites:** Plan 1 (Go-heavy frontend) must be complete — `EditorService`, `WsHandler`, and `editorWs` in `editor.js` must all be in place.

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `sieve/sieve/processor_registry.go` | `BlockProcessor` interface, `Services`, registry, `GenerateBlockID` |
| Create | `sieve/sieve/processor_registry_test.go` | Registry and paste-ordering tests |
| Create | `sieve/sieve/code_processor.go` | `CodeBlockProcessor`: PasteMatch + RunJob |
| Create | `sieve/sieve/code_processor_test.go` | PasteMatch unit tests |
| Create | `sieve/sieve/diagram_processor.go` | `DiagramBlockProcessor` stub |
| Create | `sieve/sieve/diagram_processor_test.go` | PasteMatch unit tests |
| Modify | `sieve/sieve/ai_service.go` | Add `DetectCodeLanguage` |
| Modify | `sieve/sieve/editor_service.go` | Add `services` field, `SetServices`, `HandlePaste`, `RunJob` |
| Modify | `sieve/sieve/editor_service_test.go` | `HandlePaste` tests |
| Modify | `sieve/sieve/service_provider.go` | Wire `Services`, register processors |
| Modify | `requesthandlers/ws_handler.go` | Write mutex, paste handler, `block-attrs-updated` notification |
| Create | `frontend/src/static/sieve-block-extension.js` | `SieveCode` TipTap node, CODE NodeView |
| Modify | `frontend/src/static/editor.js` | WS event dispatch, `sieve:block-update` relay, code-fence paste |
| Modify | `frontend/src/index.html` | Load `sieve-block-extension.js`, add `T.SieveCode` |
| Modify | `frontend/src/static/extensions.js` | Remove `CodeBlockWithAttrs` |

---

## Task 1: BlockProcessor Interface and Registry

**Files:**
- Create: `sieve/sieve/processor_registry.go`
- Create: `sieve/sieve/processor_registry_test.go`

- [ ] **Step 1.1: Write failing tests**

Create `sieve/sieve/processor_registry_test.go`:

```go
package sieve

import (
	"context"
	"testing"
)

type mockProcessor struct {
	matchFn func(string) (bool, map[string]interface{})
}

func (p *mockProcessor) PasteMatch(c string) (bool, map[string]interface{}) { return p.matchFn(c) }
func (p *mockProcessor) BuildContext(_ SieveBlock, _ ShadowDocument) string  { return "" }
func (p *mockProcessor) RunJob(_ context.Context, _ *SieveBlock, _ Services) error { return nil }

func resetRegistry() {
	processorRegistry = map[string]BlockProcessor{}
	pasteMatchers = nil
}

func TestRegisterProcessor_storesInRegistry(t *testing.T) {
	resetRegistry()
	mock := &mockProcessor{matchFn: func(_ string) (bool, map[string]interface{}) { return false, nil }}
	RegisterProcessor("test-kind", mock)
	if GetProcessor("test-kind") == nil {
		t.Fatal("expected processor to be registered, got nil")
	}
}

func TestRegisterProcessor_unknownKindReturnsNil(t *testing.T) {
	resetRegistry()
	if GetProcessor("no-such-kind") != nil {
		t.Fatal("expected nil for unregistered kind")
	}
}

func TestPasteMatchers_firstMatchWins(t *testing.T) {
	resetRegistry()
	specific := &mockProcessor{matchFn: func(c string) (bool, map[string]interface{}) {
		if c == "target" { return true, map[string]interface{}{"winner": "specific"} }
		return false, nil
	}}
	general := &mockProcessor{matchFn: func(c string) (bool, map[string]interface{}) {
		return true, map[string]interface{}{"winner": "general"}
	}}
	RegisterProcessor("specific", specific)
	RegisterProcessor("general", general)

	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		ok, attrs := pm.Processor.PasteMatch("target")
		if ok {
			if attrs["winner"] != "specific" {
				t.Errorf("expected specific to win, got %v", attrs["winner"])
			}
			break
		}
	}
}

func TestGenerateBlockID_formatAndUniqueness(t *testing.T) {
	id1 := GenerateBlockID("code")
	id2 := GenerateBlockID("code")
	if len(id1) < 5 {
		t.Errorf("expected ID length >= 5, got %q", id1)
	}
	if id1 == id2 {
		t.Errorf("expected unique IDs, got %q twice", id1)
	}
	if id1[:2] != "co" {
		t.Errorf("expected prefix 'co', got %q", id1[:2])
	}
}
```

- [ ] **Step 1.2: Run — expect compile failure**

```bash
go test ./sieve/... -run "TestRegisterProcessor|TestPasteMatchers|TestGenerateBlockID" -v
```
Expected: compile error — `BlockProcessor`, `Services`, `RegisterProcessor`, `GetProcessor`, `GenerateBlockID` not defined.

- [ ] **Step 1.3: Implement processor_registry.go**

Create `sieve/sieve/processor_registry.go`:

```go
package sieve

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
)

// BlockProcessor is implemented by every SieveBlock Kind.
// PasteMatch detects block pastes; RunJob executes the server-side work.
type BlockProcessor interface {
	// PasteMatch returns matched=true and initial attrs if pasted content should
	// become this block kind. The block ID is NOT set here — HandlePaste adds it.
	PasteMatch(content string) (matched bool, attrs map[string]interface{})
	// BuildContext assembles the AI prompt from the block's attrs and shadow doc.
	BuildContext(block SieveBlock, doc ShadowDocument) string
	// RunJob executes the background job and writes results into block.Attrs.
	// The caller handles flush and JS notification.
	RunJob(ctx context.Context, block *SieveBlock, svc Services) error
}

// Services is the dependency bag passed to BlockProcessor.RunJob.
type Services struct {
	AI        *AIService
	Documents *DocumentService
	Assets    *AssetService
}

var (
	registryMu        sync.RWMutex
	processorRegistry = map[string]BlockProcessor{}
	pasteMatchers     []struct {
		Kind      string
		Processor BlockProcessor
	}
)

// RegisterProcessor registers kind → processor. Call order sets paste-match
// priority — register more-specific kinds before general ones.
func RegisterProcessor(kind string, processor BlockProcessor) {
	registryMu.Lock()
	defer registryMu.Unlock()
	processorRegistry[kind] = processor
	pasteMatchers = append(pasteMatchers, struct {
		Kind      string
		Processor BlockProcessor
	}{Kind: kind, Processor: processor})
}

// GetProcessor returns the registered processor for kind, or nil.
func GetProcessor(kind string) BlockProcessor {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return processorRegistry[kind]
}

// GenerateBlockID produces "XX-YYYY" where XX = first two chars of kindPrefix
// and YYYY = 4 random hex chars. Example: GenerateBlockID("code") → "co-a3f9".
func GenerateBlockID(kindPrefix string) string {
	b := make([]byte, 2)
	_, _ = rand.Read(b)
	prefix := kindPrefix
	if len(prefix) > 2 {
		prefix = prefix[:2]
	}
	return prefix + "-" + hex.EncodeToString(b)
}
```

- [ ] **Step 1.4: Run — expect pass**

```bash
go test ./sieve/... -run "TestRegisterProcessor|TestPasteMatchers|TestGenerateBlockID" -v
```
Expected: 4 tests PASS.

- [ ] **Step 1.5: Commit**

```bash
git add sieve/sieve/processor_registry.go sieve/sieve/processor_registry_test.go
git commit -m "feat(sieve): BlockProcessor interface, processor registry, GenerateBlockID"
```

---

## Task 2: DetectCodeLanguage on AIService

**Files:**
- Modify: `sieve/sieve/ai_service.go`

- [ ] **Step 2.1: Add DetectCodeLanguage**

Append to `sieve/sieve/ai_service.go` (after `RefineLanguage`):

```go
// DetectCodeLanguage returns the programming language for source code.
// Known renderable languages (mermaid, plantuml) are returned directly without
// an AI call. Otherwise RefineLanguage is used. Returns "unknown" on failure.
func (s *AIService) DetectCodeLanguage(source, hint string) (string, error) {
	knownRenderable := map[string]bool{"mermaid": true, "plantuml": true}
	h := strings.ToLower(strings.TrimSpace(hint))
	if knownRenderable[h] {
		return h, nil
	}
	lang, err := s.RefineLanguage(source)
	if err != nil {
		return "unknown", err
	}
	if lang == "" {
		return "unknown", nil
	}
	return lang, nil
}
```

- [ ] **Step 2.2: Build check**

```bash
go build ./...
```
Expected: no errors.

- [ ] **Step 2.3: Commit**

```bash
git add sieve/sieve/ai_service.go
git commit -m "feat(ai): DetectCodeLanguage — shortcuts known renderable langs, wraps RefineLanguage"
```

---

## Task 3: CodeBlockProcessor

**Files:**
- Create: `sieve/sieve/code_processor.go`
- Create: `sieve/sieve/code_processor_test.go`

- [ ] **Step 3.1: Write failing tests**

Create `sieve/sieve/code_processor_test.go`:

```go
package sieve

import (
	"testing"
)

func TestCodeBlockProcessor_PasteMatch_withLanguage(t *testing.T) {
	p := &CodeBlockProcessor{}
	content := "```python\nprint('hello')\nprint('world')\n```"
	matched, attrs := p.PasteMatch(content)
	if !matched {
		t.Fatal("expected match for bare code fence")
	}
	if attrs["source"] != "print('hello')\nprint('world')" {
		t.Errorf("unexpected source: %v", attrs["source"])
	}
	if attrs["hint"] != "python" {
		t.Errorf("expected hint=python, got %v", attrs["hint"])
	}
	if attrs["status"] != "PENDING" {
		t.Errorf("expected status=PENDING, got %v", attrs["status"])
	}
}

func TestCodeBlockProcessor_PasteMatch_noLanguage(t *testing.T) {
	p := &CodeBlockProcessor{}
	matched, attrs := p.PasteMatch("```\nsome code\n```")
	if !matched {
		t.Fatal("expected match for fence without language")
	}
	if attrs["source"] != "some code" {
		t.Errorf("unexpected source: %v", attrs["source"])
	}
	if _, ok := attrs["hint"]; ok {
		t.Errorf("expected no hint when fence has no language")
	}
}

func TestCodeBlockProcessor_PasteMatch_noMatch(t *testing.T) {
	p := &CodeBlockProcessor{}
	if matched, _ := p.PasteMatch("just plain text"); matched {
		t.Fatal("expected no match for plain text")
	}
	if matched, _ := p.PasteMatch("`inline code`"); matched {
		t.Fatal("expected no match for inline code")
	}
}

func TestCodeBlockProcessor_PasteMatch_multiline(t *testing.T) {
	p := &CodeBlockProcessor{}
	content := "```go\npackage main\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n```"
	matched, attrs := p.PasteMatch(content)
	if !matched {
		t.Fatal("expected match for multiline fence")
	}
	if src, _ := attrs["source"].(string); src == "" {
		t.Error("expected non-empty source")
	}
}
```

- [ ] **Step 3.2: Run — expect compile failure**

```bash
go test ./sieve/... -run "TestCodeBlockProcessor" -v
```
Expected: compile error — `CodeBlockProcessor` not defined.

- [ ] **Step 3.3: Implement CodeBlockProcessor**

Create `sieve/sieve/code_processor.go`:

```go
package sieve

import (
	"context"
	"regexp"
	"strings"
)

// codeFenceRe matches a bare fenced code block. Captures: [1] language hint,
// [2] source. The (?s) flag makes . match newlines.
var codeFenceRe = regexp.MustCompile("(?s)^```(\\w*)\\n(.+)\\n```$")

// CodeBlockProcessor handles fenced code pastes and AI language detection.
type CodeBlockProcessor struct{}

// PasteMatch returns true when content is a bare fenced code block.
// Attrs contain "source" and optionally "hint" (the fence info string language).
func (p *CodeBlockProcessor) PasteMatch(content string) (bool, map[string]interface{}) {
	m := codeFenceRe.FindStringSubmatch(strings.TrimSpace(content))
	if m == nil {
		return false, nil
	}
	attrs := map[string]interface{}{
		"status": "PENDING",
		"source": m[2],
	}
	if m[1] != "" {
		attrs["hint"] = m[1]
	}
	return true, attrs
}

// BuildContext returns the raw source for the language-detection prompt.
func (p *CodeBlockProcessor) BuildContext(block SieveBlock, _ ShadowDocument) string {
	src, _ := block.Attrs["source"].(string)
	return src
}

// RunJob calls DetectCodeLanguage and writes "language" and "status" into block.Attrs.
// On error, status is set to "ERROR" and "unknown" is written for language.
func (p *CodeBlockProcessor) RunJob(ctx context.Context, block *SieveBlock, svc Services) error {
	source, _ := block.Attrs["source"].(string)
	hint, _ := block.Attrs["hint"].(string)

	lang, err := svc.AI.DetectCodeLanguage(source, hint)
	if err != nil {
		block.Attrs["language"] = "unknown"
		block.Attrs["status"] = "ERROR"
		return err
	}
	block.Attrs["language"] = lang
	block.Attrs["status"] = "COMPLETE"
	delete(block.Attrs, "hint") // transient — not persisted to disk
	return nil
}
```

- [ ] **Step 3.4: Run — expect pass**

```bash
go test ./sieve/... -run "TestCodeBlockProcessor" -v
```
Expected: 4 tests PASS.

- [ ] **Step 3.5: Commit**

```bash
git add sieve/sieve/code_processor.go sieve/sieve/code_processor_test.go
git commit -m "feat(sieve): CodeBlockProcessor — PasteMatch for fenced code, RunJob for language detection"
```

---

## Task 4: DiagramBlockProcessor

**Files:**
- Create: `sieve/sieve/diagram_processor.go`
- Create: `sieve/sieve/diagram_processor_test.go`

- [ ] **Step 4.1: Write failing tests**

Create `sieve/sieve/diagram_processor_test.go`:

```go
package sieve

import (
	"testing"
)

func TestDiagramBlockProcessor_PasteMatch_mermaid(t *testing.T) {
	p := &DiagramBlockProcessor{}
	content := "```mermaid\ngraph TD\n    A-->B\n```"
	matched, attrs := p.PasteMatch(content)
	if !matched {
		t.Fatal("expected mermaid fence to match")
	}
	if attrs["language"] != "mermaid" {
		t.Errorf("expected language=mermaid, got %v", attrs["language"])
	}
	if attrs["status"] != "COMPLETE" {
		t.Errorf("expected status=COMPLETE (no detection needed), got %v", attrs["status"])
	}
}

func TestDiagramBlockProcessor_PasteMatch_plantuml(t *testing.T) {
	p := &DiagramBlockProcessor{}
	matched, attrs := p.PasteMatch("```plantuml\n@startuml\nAlice -> Bob\n@enduml\n```")
	if !matched {
		t.Fatal("expected plantuml fence to match")
	}
	if attrs["language"] != "plantuml" {
		t.Errorf("expected language=plantuml, got %v", attrs["language"])
	}
}

func TestDiagramBlockProcessor_PasteMatch_noMatchForPython(t *testing.T) {
	p := &DiagramBlockProcessor{}
	matched, _ := p.PasteMatch("```python\nprint('hello')\n```")
	if matched {
		t.Fatal("expected python fence NOT to match DiagramBlockProcessor")
	}
}
```

- [ ] **Step 4.2: Run — expect compile failure**

```bash
go test ./sieve/... -run "TestDiagramBlockProcessor" -v
```
Expected: compile error — `DiagramBlockProcessor` not defined.

- [ ] **Step 4.3: Implement DiagramBlockProcessor**

Create `sieve/sieve/diagram_processor.go`:

```go
package sieve

import (
	"context"
	"regexp"
	"strings"
)

// diagramFenceRe matches fenced mermaid or plantuml blocks.
// Captures: [1] sub-language, [2] diagram source.
var diagramFenceRe = regexp.MustCompile("(?s)^```(mermaid|plantuml)\\n(.+)\\n```$")

// DiagramBlockProcessor handles visual markup blocks (mermaid, plantuml).
// Must be registered BEFORE CodeBlockProcessor — it is more specific.
type DiagramBlockProcessor struct{}

func (p *DiagramBlockProcessor) PasteMatch(content string) (bool, map[string]interface{}) {
	m := diagramFenceRe.FindStringSubmatch(strings.TrimSpace(content))
	if m == nil {
		return false, nil
	}
	return true, map[string]interface{}{
		"status":   "COMPLETE",
		"language": strings.ToLower(m[1]),
		"source":   m[2],
		"mode":     "CODE",
	}
}

func (p *DiagramBlockProcessor) BuildContext(_ SieveBlock, _ ShadowDocument) string {
	return "" // language is known from paste — no AI call needed
}

func (p *DiagramBlockProcessor) RunJob(_ context.Context, _ *SieveBlock, _ Services) error {
	return nil // no-op
}
```

- [ ] **Step 4.4: Run — expect pass**

```bash
go test ./sieve/... -run "TestDiagramBlockProcessor" -v
```
Expected: 3 tests PASS.

- [ ] **Step 4.5: Commit**

```bash
git add sieve/sieve/diagram_processor.go sieve/sieve/diagram_processor_test.go
git commit -m "feat(sieve): DiagramBlockProcessor — mermaid/plantuml paste creates COMPLETE block"
```

---

## Task 5: EditorService — services, HandlePaste, RunJob

**Files:**
- Modify: `sieve/sieve/editor_service.go`
- Modify: `sieve/sieve/editor_service_test.go`

- [ ] **Step 5.1: Write failing HandlePaste tests**

Append to `sieve/sieve/editor_service_test.go`:

```go
func TestEditorService_HandlePaste_codeBlock(t *testing.T) {
	resetRegistry()
	RegisterProcessor("code", &CodeBlockProcessor{})

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds)

	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello\n\nSome content."))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	_ = es.Open(uuid)

	kind, id, rawYaml, matched := es.HandlePaste(uuid, "```python\nprint('hello')\n```")

	if !matched {
		t.Fatal("expected match for code fence")
	}
	if kind != "code" {
		t.Errorf("expected kind=code, got %q", kind)
	}
	if len(id) < 5 {
		t.Errorf("expected valid ID, got %q", id)
	}
	if !strings.Contains(rawYaml, "print") {
		t.Errorf("expected source in rawYaml, got:\n%s", rawYaml)
	}

	// Block must be in shadow
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	shadow.mu.Lock()
	blk, ok := shadow.Blocks[id]
	shadow.mu.Unlock()
	if !ok {
		t.Fatal("expected block to be registered in shadow after HandlePaste")
	}
	if blk.Kind != "code" {
		t.Errorf("expected Kind=code in shadow, got %q", blk.Kind)
	}
}

func TestEditorService_HandlePaste_noMatch(t *testing.T) {
	resetRegistry()
	RegisterProcessor("code", &CodeBlockProcessor{})

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds)

	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello"))
	doc, _ = ds.Save(doc)
	_ = es.Open(doc.UUID())

	_, _, _, matched := es.HandlePaste(doc.UUID(), "just plain text")
	if matched {
		t.Fatal("expected no match for plain text")
	}
}

func TestEditorService_HandlePaste_diagramBeforeCode(t *testing.T) {
	resetRegistry()
	RegisterProcessor("diagram", &DiagramBlockProcessor{})
	RegisterProcessor("code", &CodeBlockProcessor{})

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds)
	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello"))
	doc, _ = ds.Save(doc)
	_ = es.Open(doc.UUID())

	kind, _, _, matched := es.HandlePaste(doc.UUID(), "```mermaid\ngraph TD\n    A-->B\n```")
	if !matched {
		t.Fatal("expected mermaid fence to match")
	}
	if kind != "diagram" {
		t.Errorf("expected kind=diagram, got %q", kind)
	}
}
```

- [ ] **Step 5.2: Run — expect compile failure**

```bash
go test ./sieve/... -run "TestEditorService_HandlePaste" -v
```
Expected: compile error — `HandlePaste` not defined.

- [ ] **Step 5.3: Add services field to EditorService struct**

In `sieve/sieve/editor_service.go`, update the `EditorService` struct (defined in Task 2 of Plan 1):

```go
type EditorService struct {
	documents *DocumentService
	services  Services       // dependency bag for BlockProcessor.RunJob
	mu        sync.RWMutex
	shadows   map[string]*ShadowDocument
}
```

Add `"context"` to the import block.

- [ ] **Step 5.4: Add SetServices, HandlePaste, and RunJob**

Append to `sieve/sieve/editor_service.go`:

```go
// SetServices provides the dependencies that BlockProcessor.RunJob needs.
// Called from ServiceProvider.Init() after all services are constructed.
func (es *EditorService) SetServices(svc Services) {
	es.services = svc
}

// HandlePaste runs content through all registered paste matchers in order.
// If matched, creates the block in the shadow and returns kind, id, and
// the serialised YAML body (without fence backtick lines).
func (es *EditorService) HandlePaste(uuid, content string) (kind, id, rawYaml string, matched bool) {
	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		ok, attrs := pm.Processor.PasteMatch(content)
		if !ok {
			continue
		}
		kind = pm.Kind
		id = GenerateBlockID(kind)
		attrs["id"] = id

		es.UpdateBlock(uuid, kind, id, attrs)

		raw, err := fencedblock.Serialize[map[string]interface{}](attrs)
		if err != nil {
			return "", "", "", false
		}
		return kind, id, raw, true
	}
	return "", "", "", false
}

// RunJob dispatches the background job for blockID in document uuid.
// It makes a defensive copy of block attrs so RunJob does not race with
// concurrent shadow reads. Results are merged back via setBlock, the shadow
// is flushed to disk, and notify is called with the updated rawYaml.
func (es *EditorService) RunJob(ctx context.Context, uuid, blockID string, notify func(id, rawYaml string)) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return
	}

	shadow.mu.Lock()
	blk, ok := shadow.Blocks[blockID]
	if !ok {
		shadow.mu.Unlock()
		return
	}
	kind := blk.Kind
	blkCopy := &SieveBlock{
		ID:    blk.ID,
		Kind:  blk.Kind,
		Attrs: make(map[string]interface{}, len(blk.Attrs)),
	}
	for k, v := range blk.Attrs {
		blkCopy.Attrs[k] = v
	}
	shadow.mu.Unlock()

	processor := GetProcessor(kind)
	if processor == nil {
		return
	}

	if err := processor.RunJob(ctx, blkCopy, es.services); err != nil {
		shadow.setBlock(kind, blockID, map[string]interface{}{"status": "ERROR"})
	} else {
		shadow.setBlock(kind, blockID, blkCopy.Attrs)
	}

	_ = es.Flush(uuid)

	if notify != nil {
		shadow.mu.Lock()
		blk2, ok2 := shadow.Blocks[blockID]
		shadow.mu.Unlock()
		if ok2 {
			rawYaml, _ := fencedblock.Serialize[map[string]interface{}](blk2.Attrs)
			notify(blockID, rawYaml)
		}
	}
}
```

- [ ] **Step 5.5: Run — expect pass**

```bash
go test ./sieve/... -run "TestEditorService" -v
```
Expected: all PASS.

- [ ] **Step 5.6: Commit**

```bash
git add sieve/sieve/editor_service.go sieve/sieve/editor_service_test.go
git commit -m "feat(editor): SetServices, HandlePaste, RunJob — block paste + async job dispatch"
```

---

## Task 6: Wire Services and Register Processors in ServiceProvider

**Files:**
- Modify: `sieve/sieve/service_provider.go`

- [ ] **Step 6.1: Wire Services and register processors**

In `sieve/sieve/service_provider.go`, in `Init()`, after `s.Editor = NewEditorService(s.Documents)`, add:

```go
s.Editor.SetServices(Services{
    AI:        s.AI,
    Documents: s.Documents,
    Assets:    s.Assets,
})
// Register in order — more-specific processors first so they match before general ones.
RegisterProcessor("diagram", &DiagramBlockProcessor{})
RegisterProcessor("code", &CodeBlockProcessor{})
```

- [ ] **Step 6.2: Build + test**

```bash
go build ./...
go test ./...
```
Expected: all PASS.

- [ ] **Step 6.3: Commit**

```bash
git add sieve/sieve/service_provider.go
git commit -m "feat(sieve): register diagram + code processors, wire Services into EditorService"
```

---

## Task 7: WsHandler — Write Mutex and Paste Flow

**Files:**
- Modify: `requesthandlers/ws_handler.go`

- [ ] **Step 7.1: Refactor message writes to use a mutex-protected helper**

In `handleWS`, add before the message loop and update call sites:

```go
var writeMu sync.Mutex
writeMsg := func(v interface{}) {
    data, err := json.Marshal(v)
    if err != nil {
        return
    }
    writeMu.Lock()
    _ = conn.WriteMessage(websocket.TextMessage, data)
    writeMu.Unlock()
}
```

Change `handleFlush` and `handleEnterMarkdown` signatures from `(conn *websocket.Conn, uuid string)` to `(writeMsg func(interface{}), uuid string)`. Replace internal `conn.WriteMessage` calls with `writeMsg(...)`. Update call sites in the switch:

```go
case "flush":
    h.handleFlush(writeMsg, uuid)
case "enter-markdown":
    h.handleEnterMarkdown(writeMsg, uuid)
```

Updated helpers:

```go
func (h *WsHandler) handleFlush(writeMsg func(interface{}), uuid string) {
    _ = h.ServiceProvider.Editor.Flush(uuid)
    writeMsg(map[string]string{"type": "flush-ack", "uuid": uuid})
}

func (h *WsHandler) handleEnterMarkdown(writeMsg func(interface{}), uuid string) {
    merged := h.ServiceProvider.Editor.EnterMarkdown(uuid)
    writeMsg(map[string]string{
        "type":     "markdown-content",
        "uuid":     uuid,
        "markdown": merged,
    })
}
```

Add `"sync"` to imports.

- [ ] **Step 7.2: Add paste handler and wire in switch**

Add to the switch in `handleWS`:

```go
case "paste":
    h.handlePaste(uuid, raw, writeMsg)
```

Add method:

```go
func (h *WsHandler) handlePaste(uuid string, raw []byte, writeMsg func(interface{})) {
    var msg struct {
        Content string `json:"content"`
    }
    if err := json.Unmarshal(raw, &msg); err != nil {
        return
    }

    kind, id, rawYaml, matched := h.ServiceProvider.Editor.HandlePaste(uuid, msg.Content)
    if !matched {
        return
    }

    writeMsg(map[string]string{
        "type":    "insert-block",
        "kind":    kind,
        "id":      id,
        "rawYaml": rawYaml,
    })

    go h.ServiceProvider.Editor.RunJob(context.Background(), uuid, id, func(blkID, updatedRawYaml string) {
        writeMsg(map[string]string{
            "type":    "block-attrs-updated",
            "id":      blkID,
            "rawYaml": updatedRawYaml,
        })
    })
}
```

Add `"context"` to imports.

- [ ] **Step 7.3: Build check**

```bash
go build ./...
```
Expected: no errors.

- [ ] **Step 7.4: Commit**

```bash
git add requesthandlers/ws_handler.go
git commit -m "feat(ws): write mutex, paste handler, block-attrs-updated notification via goroutine"
```

---

## Task 8: sieve-block-extension.js

**Files:**
- Create: `frontend/src/static/sieve-block-extension.js`

- [ ] **Step 8.1: Create the extension**

Create `frontend/src/static/sieve-block-extension.js`:

```js
// sieve-block-extension.js — SieveBlock TipTap node for the 'code' kind.
// Parses ```code fences with YAML bodies, renders a contenteditable NodeView,
// and sends block-update events on source edit.
// Attaches T.SieveCode to window.TipTap.

import { esc, applyHighlighting, isStaleByTime, isJobActive } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap
  var Node = T.Node
  var mergeAttributes = T.mergeAttributes

  // ── isStale ─────────────────────────────────────────────────────────────────

  function isStale(createdAt, id) {
    if (isJobActive(id)) return false
    return isStaleByTime(createdAt)
  }

  // ── NodeView ─────────────────────────────────────────────────────────────────

  function makeNodeView(node) {
    var currentAttrs = Object.assign({}, node.attrs)

    var dom = document.createElement('div')
    dom.className = 'sieve-code'
    dom.setAttribute('data-block-id', node.attrs.id || '')
    dom.contentEditable = 'false'

    var header = document.createElement('div')
    header.className = 'sieve-code__header'
    header.contentEditable = 'false'

    var badge = document.createElement('span')
    badge.className = 'sieve-code__badge'
    header.appendChild(badge)

    var pre = document.createElement('pre')
    pre.className = 'sieve-code__pre not-prose'

    var codeEl = document.createElement('code')
    codeEl.className = 'sieve-code__source'
    codeEl.contentEditable = 'true'
    codeEl.spellcheck = false
    codeEl.setAttribute('autocorrect', 'off')
    codeEl.setAttribute('autocapitalize', 'off')
    pre.appendChild(codeEl)
    dom.appendChild(header)
    dom.appendChild(pre)

    function render(attrs) {
      currentAttrs = attrs
      var isPending = attrs.status === 'PENDING'
      var isStaleBlock = isPending && isStale(attrs.createdAt, attrs.id)

      if (isPending && !isStaleBlock) {
        badge.textContent = 'detecting…'
        badge.className = 'sieve-code__badge sieve-code__badge--pending'
      } else if (attrs.language && attrs.language !== 'unknown') {
        badge.textContent = attrs.language
        badge.className = 'sieve-code__badge'
      } else {
        badge.textContent = attrs.language || ''
        badge.className = 'sieve-code__badge sieve-code__badge--unknown'
      }

      // Only update source text when not actively editing
      if (document.activeElement !== codeEl) {
        codeEl.textContent = attrs.source || ''
        var langClass = (attrs.language && attrs.language !== 'unknown')
          ? 'language-' + attrs.language
          : 'language-text'
        codeEl.className = 'sieve-code__source ' + langClass
        applyHighlighting(pre)
      }
    }

    render(node.attrs)

    // Debounced source edits → sieve:block-update (relayed to WS by editor.js)
    var inputTimer = null
    codeEl.addEventListener('input', function () {
      clearTimeout(inputTimer)
      inputTimer = setTimeout(function () {
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'code', attrs: { source: codeEl.textContent } },
        }))
      }, 200)
    })

    // Stop TipTap keyboard handling while editing code source
    codeEl.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey) return // let shortcuts through
      e.stopPropagation()
    })

    return {
      dom: dom,
      contentDOM: null,
      update: function (updatedNode) {
        if (updatedNode.type.name !== 'sieveCode') return false
        render(updatedNode.attrs)
        return true
      },
      ignoreMutation: function () { return true },
      stopEvent: function (event) {
        if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
        return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
      },
      destroy: function () { clearTimeout(inputTimer) },
    }
  }

  // ── SieveCode TipTap Node ────────────────────────────────────────────────────

  var SieveCode = Node.create({
    name: 'sieveCode',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,

    addAttributes() {
      return {
        id:        { default: '', parseHTML: function (el) { return el.getAttribute('data-id') || '' } },
        kind:      { default: 'code', parseHTML: function (el) { return el.getAttribute('data-kind') || 'code' } },
        rawYaml:   { default: '', parseHTML: function (el) { return el.getAttribute('data-raw-yaml') || '' } },
        status:    { default: 'PENDING', parseHTML: function (el) { return el.getAttribute('data-status') || 'PENDING' } },
        language:  { default: '', parseHTML: function (el) { return el.getAttribute('data-language') || '' } },
        source:    { default: '', parseHTML: function (el) { return el.getAttribute('data-source') || '' } },
        createdAt: { default: null, parseHTML: function (el) { return el.getAttribute('data-created-at') || null } },
      }
    },

    parseHTML() {
      return [{ tag: 'div[data-type="sieveCode"]' }]
    },

    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes({ 'data-type': 'sieveCode' }, HTMLAttributes)]
    },

    addNodeView() {
      return function ({ node }) { return makeNodeView(node) }
    },

    addStorage() {
      return {
        markdown: {
          // Rule 1: replay rawYaml verbatim — Go owns all YAML generation.
          serialize: function (state, node) {
            state.ensureNewLine()
            if (node.attrs.rawYaml) {
              state.write('```code\n' + node.attrs.rawYaml + '\n```')
            } else {
              // Fallback for nodes inserted directly without a rawYaml
              var lang = node.attrs.language || ''
              state.write('```' + lang + '\n' + (node.attrs.source || '') + '\n```')
            }
            state.closeBlock(node)
          },
          parse: {
            setup: function (markdownit) {
              var defaultFence = markdownit.renderer.rules.fence
              markdownit.renderer.rules.fence = function (tokens, idx, options, env, self) {
                var token = tokens[idx]
                var info = (token.info || '').trim()

                // Only intercept ```code fences that have a YAML body with an id
                if (info !== 'code') {
                  return defaultFence
                    ? defaultFence(tokens, idx, options, env, self)
                    : self.renderToken(tokens, idx, options)
                }

                var data
                try { data = window.jsyaml.load(token.content) } catch (e) { data = null }
                if (!data || !data.id) {
                  return defaultFence
                    ? defaultFence(tokens, idx, options, env, self)
                    : self.renderToken(tokens, idx, options)
                }

                var attrs = [
                  'data-type="sieveCode"',
                  'data-id="' + esc(data.id) + '"',
                  'data-kind="code"',
                  'data-raw-yaml="' + esc(token.content) + '"',
                  'data-status="' + esc(data.status || 'PENDING') + '"',
                  'data-language="' + esc(data.language || '') + '"',
                  'data-source="' + esc((data.source || '').trim()) + '"',
                ]
                if (data.createdAt) attrs.push('data-created-at="' + esc(data.createdAt) + '"')
                return '<div ' + attrs.join(' ') + '></div>\n'
              }
            },
          },
        },
      }
    },
  })

  T.SieveCode = SieveCode

})()
```

- [ ] **Step 8.2: Commit**

```bash
git add frontend/src/static/sieve-block-extension.js
git commit -m "feat(js): SieveCode TipTap node — code fence parse/serialize, CODE NodeView"
```

---

## Task 9: editor.js — WS Event Dispatch and Paste Handler

**Files:**
- Modify: `frontend/src/static/editor.js`

- [ ] **Step 9.1: Dispatch insert-block and block-attrs-updated from WS messages**

In `editorWs.onmessage` (from Plan 1), add two new cases after the `markdown-content` dispatch:

```js
if (msg.type === 'insert-block') {
  document.dispatchEvent(new CustomEvent('editor:insert-block', { detail: msg }))
}
if (msg.type === 'block-attrs-updated') {
  document.dispatchEvent(new CustomEvent('editor:block-attrs-updated', { detail: msg }))
}
```

- [ ] **Step 9.2: Add sieveInsertPos state variable**

Near the top of the IIFE (alongside other state variables):

```js
var sieveInsertPos = null
```

- [ ] **Step 9.3: Relay sieve:block-update to WebSocket**

After the `wsSendAndAwait` helper definition, add:

```js
// NodeViews fire sieve:block-update when source is edited; relay to WS.
document.addEventListener('sieve:block-update', function (e) {
  if (!currentUuid || !e.detail.id) return
  wsSend({ type: 'block-update', uuid: currentUuid, id: e.detail.id, kind: e.detail.kind, attrs: e.detail.attrs })
})
```

- [ ] **Step 9.4: Handle editor:insert-block — insert SieveCode node**

Add listener after the `sieve:block-update` relay:

```js
document.addEventListener('editor:insert-block', function (e) {
  if (!currentEditor) return
  var msg = e.detail
  var parsed = {}
  try { parsed = window.jsyaml.load(msg.rawYaml) || {} } catch (_) {}

  var pos = sieveInsertPos !== null ? sieveInsertPos : currentEditor.state.doc.content.size
  sieveInsertPos = null

  currentEditor.commands.insertContentAt(pos, {
    type: 'sieveCode',
    attrs: {
      kind:     msg.kind || 'code',
      id:       msg.id || parsed.id || '',
      rawYaml:  msg.rawYaml || '',
      status:   parsed.status || 'PENDING',
      language: parsed.language || '',
      source:   typeof parsed.source === 'string' ? parsed.source.trim() : '',
    },
  })
})
```

- [ ] **Step 9.5: Handle editor:block-attrs-updated — update node attrs**

```js
document.addEventListener('editor:block-attrs-updated', function (e) {
  if (!currentEditor) return
  var msg = e.detail
  var parsed = {}
  try { parsed = window.jsyaml.load(msg.rawYaml) || {} } catch (_) {}

  currentEditor.commands.command(function (commandProps) {
    var tr = commandProps.tr
    commandProps.state.doc.descendants(function (node, pos) {
      if (node.type.name === 'sieveCode' && node.attrs.id === msg.id) {
        tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {
          rawYaml:  msg.rawYaml || node.attrs.rawYaml,
          status:   parsed.status   || node.attrs.status,
          language: parsed.language || node.attrs.language,
          source:   parsed.source != null
            ? (typeof parsed.source === 'string' ? parsed.source.trim() : String(parsed.source))
            : node.attrs.source,
        }))
        return false // stop traversal
      }
    })
    return true
  })
})
```

- [ ] **Step 9.6: Add code-fence paste detection**

In `handleSmartPaste`, BEFORE the existing `ai-block` paste check, add:

```js
// Code and diagram fences → route through Go processor registry via WebSocket.
// ai-block and web-clip have dedicated JS paste handlers below, so exclude them.
if (text && currentUuid && !currentUuid.startsWith('prompt:')) {
  var fenceMatch = text.trim().match(/^```(\w*)\n[\s\S]+\n```$/)
  var jsOwnedKinds = ['ai-block', 'web-clip']
  if (fenceMatch && jsOwnedKinds.indexOf((fenceMatch[1] || '').toLowerCase()) === -1) {
    event.preventDefault()
    sieveInsertPos = currentEditor ? currentEditor.state.selection.to : null
    wsSend({ type: 'paste', uuid: currentUuid, content: text.trim() })
    return true
  }
}
```

- [ ] **Step 9.7: Build check**

```bash
go build ./...
```

- [ ] **Step 9.8: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(editor): WS event dispatch, sieve:block-update relay, code-fence paste via WS"
```

---

## Task 10: index.html + Remove CodeBlockWithAttrs

**Files:**
- Modify: `frontend/src/index.html`
- Modify: `frontend/src/static/editor.js`
- Modify: `frontend/src/static/extensions.js`

- [ ] **Step 10.1: Load sieve-block-extension.js in index.html**

In `frontend/src/index.html`, after the `ai-block-extension.js` script tag, add:

```html
<script type="module" src="/static/sieve-block-extension.js"></script>
```

- [ ] **Step 10.2: Add T.SieveCode to TipTap extensions in editor.js**

In `mountWysiwyg` extensions array, after `T.WebClip`:

```js
T.SieveCode,
```

- [ ] **Step 10.3: Remove CodeBlockWithAttrs from editor.js**

In `mountWysiwyg`, remove:

```js
T.CodeBlockWithAttrs.configure({ lowlight: lowlight }),
```

Remove the `var lowlight = T.createLowlight(T.common)` line if `lowlight` has no other references:

```bash
grep -n "lowlight" frontend/src/static/editor.js
```

Remove the line if the count drops to zero after removing the `.configure` call.

- [ ] **Step 10.4: Remove CodeBlockWithAttrs from extensions.js**

Find and delete these sections from `frontend/src/static/extensions.js`:

```bash
grep -n "parseInfoString\|CodeBlockWithAttrs" frontend/src/static/extensions.js
```

Delete:
- `function parseInfoString(info) { ... }` 
- `var CodeBlockWithAttrs = T.CodeBlockLowlight.extend({ ... })` through its closing `})`
- `T.CodeBlockWithAttrs = CodeBlockWithAttrs`

- [ ] **Step 10.5: Run all tests**

```bash
go build ./...
go test ./...
```
Expected: all PASS.

- [ ] **Step 10.6: Smoke test**

`wails dev`:
1. Open a note
2. Paste: `` ```python\nprint("hello")\n``` `` — a `SieveCode` block appears with "detecting…" badge
3. After 2–5s, badge updates to "python"
4. Edit the source in the block — edits are visible; source sends via `sieve:block-update`
5. Switch to markdown mode → merged markdown contains updated source in the YAML
6. Switch back to WYSIWYG → block shows latest source
7. Paste: `` ```mermaid\ngraph TD\n    A-->B\n``` `` — creates a `diagram` block with "mermaid" badge and status COMPLETE immediately

- [ ] **Step 10.7: Commit**

```bash
git add frontend/src/index.html frontend/src/static/editor.js frontend/src/static/extensions.js
git commit -m "feat: wire SieveCode extension, remove CodeBlockWithAttrs — code block cutover complete"
```

---

## Completion Criteria

| Task | Done when |
|------|-----------|
| 1 | `TestRegisterProcessor*`, `TestPasteMatchers*`, `TestGenerateBlockID*` pass |
| 2 | `go build ./...` clean with `DetectCodeLanguage` present |
| 3 | `TestCodeBlockProcessor_*` (4 tests) pass |
| 4 | `TestDiagramBlockProcessor_*` (3 tests) pass |
| 5 | `TestEditorService_HandlePaste_*` (3 tests) pass; `HandlePaste` and `RunJob` in EditorService |
| 6 | `go build ./...` clean; processors registered in ServiceProvider |
| 7 | `go build ./...` clean; WsHandler handles `paste` message |
| 8 | `T.SieveCode` available in browser; `sieve-block-extension.js` loads without errors |
| 9 | `editor:insert-block` and `editor:block-attrs-updated` dispatched; code-fence paste goes via WS |
| 10 | `go test ./...` all pass; pasting a code fence creates SieveCode block; language badge updates; source editable; mermaid paste creates diagram block immediately |

---

## Future Work (Beyond This Plan)

| Work | Pattern |
|------|---------|
| Mermaid RENDER mode | Add `renderers['mermaid']` in `sieve-block-extension.js`; RENDER NodeView calls `mermaid.render()`; mode toggle via `Ctrl+R` |
| ai-block migration | Replace `ai-block-extension.js` with a SieveCode-style extension backed by `AiBlockProcessor`. On-disk YAML format is already correct — extension replacement only, no data migration. |
| web-clip migration | Same as ai-block: extension replacement, no data changes |
| rich-image | New `RichImageProcessor` (AI description job) + TipTap SieveCode-style node replacing `ImageWithAttrs` |
| titled-link | New `TitledLinkProcessor` (HTTP fetch + AI summary job) + renderer |

Each future block type follows: implement `BlockProcessor`, register in `service_provider.go`, write JS NodeView/renderer, load in `index.html`.
