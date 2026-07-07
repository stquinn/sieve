# Diagram Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `diagram` Sieve block kind that renders Mermaid diagrams inline, with a persistent header pill-toggle to switch between edit (code editor) and render (SVG) modes, persisted in YAML.

**Architecture:** Pure Sieve Block Framework block — no server-side job (`status: COMPLETE` from `InitAttrs`), client-side mermaid rendering via vendored `mermaid.min.js` lazy-loaded on first render. Mode (`"edit"` | `"render"`) is stored as a YAML attr and persisted via `block-update` WS. Edit mode mirrors the code block's textarea + highlight overlay pattern; render mode injects mermaid SVG. Spec: `docs/design/archive/2026-06-08-diagram-blocks-design.md`.

**Tech Stack:** Go (processor), vanilla JS ES module (renderer), mermaid.js v10 (vendored), Tailwind + custom CSS

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `sieve/diagram_processor.go` | Create | All 8 `BlockProcessor` methods; no async job |
| `sieve/diagram_processor_test.go` | Create | Unit tests for processor |
| `sieve/service_provider.go` | Modify | Register `"diagram"` processor |
| `frontend/src/static/diagram-renderer.js` | Create | NodeView, header toggle, edit mode, render mode, context menu |
| `frontend/src/static/vendor/mermaid.min.js` | Create | Vendored mermaid library (~2 MB) |
| `frontend/src/static/input.css` | Modify | Diagram block CSS (header, toggle, gutter, render area) |
| `frontend/src/index.html` | Modify | `<script type="module">` for diagram renderer |
| `frontend/src/static/editor.js` | Modify | `Ctrl+Shift+D` shortcut |
| `frontend/src/templates/help.html` | Modify | Keyboard shortcut entry |

---

## Task 1: DiagramProcessor — tests + implementation

**Files:**
- Create: `sieve/diagram_processor_test.go`
- Create: `sieve/diagram_processor.go`

- [ ] **Step 1.1 — Write the test file**

Create `sieve/diagram_processor_test.go`:

```go
package sieve

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestDiagramProcessor_InitAttrs_defaults(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	attrs := p.InitAttrs("di-a1b2", nil)

	if attrs["id"] != "di-a1b2" {
		t.Errorf("id: got %v, want di-a1b2", attrs["id"])
	}
	if attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", attrs["status"])
	}
	if attrs["diagramType"] != "mermaid" {
		t.Errorf("diagramType: got %v, want mermaid", attrs["diagramType"])
	}
	// empty source → edit mode
	if attrs["mode"] != "edit" {
		t.Errorf("mode with empty source: got %v, want edit", attrs["mode"])
	}
	if attrs["supportsPromotion"] != true {
		t.Errorf("supportsPromotion: got %v, want true", attrs["supportsPromotion"])
	}
	if attrs["createdAt"] == nil || attrs["createdAt"] == "" {
		t.Error("createdAt must be set")
	}
	for _, field := range []string{"source", "diagramType", "mode", "supportsPromotion", "createdAt"} {
		if _, ok := attrs[field]; !ok {
			t.Errorf("InitAttrs must declare field %q", field)
		}
	}
}

func TestDiagramProcessor_InitAttrs_withSourceSetsRenderMode(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	attrs := p.InitAttrs("di-a1b2", map[string]interface{}{"source": "graph TD\n  A-->B"})
	if attrs["mode"] != "render" {
		t.Errorf("mode with source: got %v, want render", attrs["mode"])
	}
	if attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", attrs["status"])
	}
}

func TestDiagramProcessor_InitAttrs_idNotOverridable(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	attrs := p.InitAttrs("di-0001", map[string]interface{}{"id": "injected"})
	if attrs["id"] != "di-0001" {
		t.Error("id must not be overridable via overrides")
	}
}

func TestDiagramProcessor_Mode(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	if p.Mode() != BlockModeBlock {
		t.Errorf("Mode: got %v, want block", p.Mode())
	}
}

func TestDiagramProcessor_PasteMatch_mermaidFence(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	src := "graph TD\n  A[Start] --> B[End]"
	content := "```mermaid\n" + src + "\n```"
	matched, overrides := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: content}}, "", "")
	if !matched {
		t.Fatal("PasteMatch must return true for a mermaid fenced block")
	}
	if overrides["source"] != src {
		t.Errorf("source: got %v, want %q", overrides["source"], src)
	}
	if overrides["mode"] != "render" {
		t.Errorf("mode override: got %v, want render", overrides["mode"])
	}
}

func TestDiagramProcessor_PasteMatch_otherFence(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	ok, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "```go\nfunc main() {}\n```"}}, "", "")
	if ok {
		t.Error("PasteMatch must return false for non-mermaid fenced block")
	}
}

func TestDiagramProcessor_PasteMatch_plainText(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	ok, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "hello world"}}, "", "")
	if ok {
		t.Error("PasteMatch must return false for plain text")
	}
}

func TestDiagramProcessor_BuildContext_withSource(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	block := SieveBlock{
		ID:    "di-0001",
		Kind:  "diagram",
		Attrs: map[string]interface{}{"source": "graph TD\n  A-->B"},
	}
	ctx := p.BuildContext(block, ShadowDocument{}, map[string]bool{})
	if ctx == "" {
		t.Error("BuildContext must return non-empty string when source is set")
	}
	if !strings.Contains(ctx, "```mermaid") {
		t.Error("BuildContext must include mermaid fence")
	}
	if !strings.Contains(ctx, "di-0001") {
		t.Error("BuildContext must include NODE ID")
	}
}

func TestDiagramProcessor_BuildContext_emptySource(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	block := SieveBlock{ID: "di-0001", Kind: "diagram", Attrs: map[string]interface{}{"source": ""}}
	if ctx := p.BuildContext(block, ShadowDocument{}, map[string]bool{}); ctx != "" {
		t.Errorf("BuildContext must return empty for empty source; got %q", ctx)
	}
}

func TestDiagramProcessor_MarkdownRepresentation_withSource(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	block := SieveBlock{Attrs: map[string]interface{}{"source": "graph TD\n  A-->B"}}
	got := p.MarkdownRepresentation(block)
	want := "```mermaid\ngraph TD\n  A-->B\n```"
	if got != want {
		t.Errorf("MarkdownRepresentation: got %q, want %q", got, want)
	}
}

func TestDiagramProcessor_MarkdownRepresentation_emptySource(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	block := SieveBlock{Attrs: map[string]interface{}{"source": ""}}
	if got := p.MarkdownRepresentation(block); got != "" {
		t.Errorf("MarkdownRepresentation must return empty string for empty source; got %q", got)
	}
}

func TestDiagramProcessor_RunJob_noopComplete(t *testing.T) {
	p := NewDiagramProcessor(BlockServices{})
	block := &SieveBlock{
		ID:   "di-0001",
		Kind: "diagram",
		Attrs: map[string]interface{}{
			"status":    BlockStatusComplete,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}
	if err := p.RunJob(JobContext{Ctx: context.Background(), UUID: "test", Block: block}); err != nil {
		t.Fatalf("RunJob must not error; got %v", err)
	}
	if block.Attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", block.Attrs["status"])
	}
}
```

- [ ] **Step 1.2 — Run tests to verify they fail**

```bash
go test -tags webkit2_41 ./sieve/... -run TestDiagram -v 2>&1 | head -20
```

Expected: compile error `undefined: NewDiagramProcessor`

- [ ] **Step 1.3 — Create `sieve/diagram_processor.go`**

```go
package sieve

import (
	"regexp"
	"strings"
	"time"
)

var mermaidFenceRe = regexp.MustCompile("(?s)^```mermaid\n(.+)\n```$")

// DiagramProcessor handles the 'diagram' block kind.
// Rendering is entirely client-side; no async server job is needed.
// InitAttrs sets status: COMPLETE directly so DispatchJobIfNeeded skips dispatch.
type DiagramProcessor struct{ svc BlockServices }

func NewDiagramProcessor(svc BlockServices) *DiagramProcessor {
	return &DiagramProcessor{svc: svc}
}

func (p *DiagramProcessor) Mode() BlockMode { return BlockModeBlock }

func (p *DiagramProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            BlockStatusComplete,
		"source":            "",
		"diagramType":       "mermaid",
		"mode":              "render",
		"supportsPromotion": true,
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	// Empty source → open in edit mode so the user can type immediately
	source, _ := attrs["source"].(string)
	if strings.TrimSpace(source) == "" {
		attrs["mode"] = "edit"
	}
	return attrs
}

func (p *DiagramProcessor) PasteMatch(entries []PasteEntry, _ string, _ string) (bool, map[string]interface{}) {
	var content string
	for _, e := range entries {
		if e.MIMEType == "text/plain" {
			content = e.Content
			break
		}
	}
	if content == "" {
		return false, nil
	}
	m := mermaidFenceRe.FindStringSubmatch(strings.TrimSpace(content))
	if m == nil {
		return false, nil
	}
	return true, map[string]interface{}{
		"source": m[1],
		"mode":   "render",
	}
}

func (p *DiagramProcessor) OnChange(_ *SieveBlock) {}

func (p *DiagramProcessor) BuildContext(block SieveBlock, _ ShadowDocument, _ map[string]bool) string {
	src, _ := block.Attrs["source"].(string)
	if strings.TrimSpace(src) == "" {
		return ""
	}
	return "NODE ID: " + block.ID + "\n\n```mermaid\n" + src + "\n```"
}

func (p *DiagramProcessor) JobLabel(_ *SieveBlock) string { return "" }

func (p *DiagramProcessor) RunJob(jctx JobContext) error {
	jctx.Block.Attrs["status"] = BlockStatusComplete
	return nil
}

func (p *DiagramProcessor) MarkdownRepresentation(block SieveBlock) string {
	src, _ := block.Attrs["source"].(string)
	src = strings.TrimSpace(src)
	if src == "" {
		return ""
	}
	return "```mermaid\n" + src + "\n```"
}
```

- [ ] **Step 1.4 — Run tests to verify they pass**

```bash
go test -tags webkit2_41 ./sieve/... -run TestDiagram -v
```

Expected: all `TestDiagram*` tests PASS

- [ ] **Step 1.5 — Build check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors

- [ ] **Step 1.6 — Commit**

```bash
git add sieve/diagram_processor.go sieve/diagram_processor_test.go
git commit -m "feat(diagram): add DiagramProcessor — no-op job, mermaid paste detection"
```

---

## Task 2: Register the processor

**Files:**
- Modify: `sieve/service_provider.go`

- [ ] **Step 2.1 — Add registration**

In `sieve/service_provider.go`, find the block of `RegisterProcessor` calls (currently ends with `RegisterProcessor("ai-block", NewAIBlockProcessor(svc))`). Add `diagram` after `ai-block`:

```go
RegisterProcessor("ai-block",  NewAIBlockProcessor(svc))
RegisterProcessor("diagram",   NewDiagramProcessor(svc))
```

- [ ] **Step 2.2 — Build check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors

- [ ] **Step 2.3 — Commit**

```bash
git add sieve/service_provider.go
git commit -m "feat(diagram): register diagram processor"
```

---

## Task 3: Diagram block CSS

**Files:**
- Modify: `frontend/src/static/input.css`

- [ ] **Step 3.1 — Append diagram block styles to `frontend/src/static/input.css`**

Add at the end of the file:

```css
/* ── Diagram Block ──────────────────────────────────────────────────────────── */

.sieve-block--diagram {
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  background: var(--theme-bgDark);
  overflow: hidden;
  margin: 4px 0;
}

.sieve-block--diagram:hover {
  border-color: var(--theme-border2);
}

/* Header: always visible in both modes */
.sieve-block--diagram .sieve-block__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px 5px 8px;
  border-bottom: 1px solid var(--theme-border);
  background: var(--theme-bgAlt);
}

.sieve-block--diagram .sieve-block__badge {
  font-size: 10px;
  font-family: var(--theme-monoFont);
  color: var(--theme-fg2);
  background: var(--theme-bgLight);
  border: 1px solid var(--theme-border2);
  border-radius: 3px;
  padding: 1px 6px;
  letter-spacing: 0.02em;
}

.sieve-block--diagram .sieve-block__type-label {
  font-size: 10px;
  color: var(--theme-fg3);
  font-family: var(--theme-monoFont);
}

/* Pill mode toggle */
.diagram-block__toggle {
  display: flex;
  align-items: center;
  background: var(--theme-bgLight);
  border: 1px solid var(--theme-border2);
  border-radius: 4px;
  overflow: hidden;
  height: 22px;
}

.diagram-block__toggle-btn {
  font-size: 10px;
  padding: 0 9px;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--theme-fg3);
  cursor: pointer;
  border: none;
  background: transparent;
  letter-spacing: 0.02em;
  user-select: none;
  transition: color 0.1s;
}

.diagram-block__toggle-btn svg {
  width: 9px;
  height: 9px;
  flex-shrink: 0;
}

.diagram-block__toggle-btn--active-edit {
  background: var(--theme-bgDark);
  color: var(--theme-accent);
  border-radius: 3px;
  margin: 1px;
  height: calc(100% - 2px);
  padding: 0 8px;
}

.diagram-block__toggle-btn--active-render {
  background: var(--theme-bgDark);
  color: var(--theme-accentGreen);
  border-radius: 3px;
  margin: 1px;
  height: calc(100% - 2px);
  padding: 0 8px;
}

/* Edit mode body — same CSS grid pattern as code block */
.sieve-block--diagram .sieve-block__body {
  display: flex;
  min-height: 80px;
}

.sieve-block--diagram .sieve-block__gutter {
  width: 36px;
  flex-shrink: 0;
  background: var(--theme-bgAlt);
  border-right: 1px solid var(--theme-border);
  padding: 10px 8px 10px 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}

.sieve-block--diagram .sieve-block__gutter span {
  font-size: 10px;
  font-family: var(--theme-monoFont);
  color: var(--theme-fg3);
  line-height: 18px;
  display: block;
}

.sieve-block--diagram .sieve-block__code-area {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: 1fr;
  min-height: 80px;
}

.sieve-block--diagram .sieve-block__highlight,
.sieve-block--diagram .sieve-block__edit {
  grid-area: 1 / 1;
  font-family: var(--theme-monoFont);
  font-size: 12px;
  line-height: 18px;
  padding: 10px 12px;
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
  tab-size: 2;
  word-break: normal;
}

.sieve-block--diagram .sieve-block__highlight {
  color: var(--theme-text);
  background: transparent;
  pointer-events: none;
  border: none;
  margin: 0;
}

.sieve-block--diagram .sieve-block__edit {
  background: transparent;
  color: transparent;
  caret-color: var(--theme-text);
  border: none;
  resize: none;
  outline: none;
  width: 100%;
  min-height: 80px;
}

/* Render mode body */
.diagram-block__render {
  padding: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
}

.diagram-block__render svg {
  max-width: 100%;
  height: auto;
}

/* Error state */
.diagram-block__error {
  padding: 14px 16px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.diagram-block__error-icon {
  color: var(--theme-accentRed);
  font-size: 14px;
  flex-shrink: 0;
  margin-top: 1px;
}

.diagram-block__error-title {
  font-size: 12px;
  color: var(--theme-accentRed);
  font-weight: 500;
  margin-bottom: 4px;
}

.diagram-block__error-msg {
  font-family: var(--theme-monoFont);
  font-size: 11px;
  color: var(--theme-fg2);
  line-height: 1.5;
  margin-bottom: 10px;
}

/* Loading state while mermaid.js loads */
.diagram-block__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 80px;
  color: var(--theme-fg3);
  font-size: 12px;
  gap: 8px;
}

.diagram-block__spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--theme-border2);
  border-top-color: var(--theme-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
```

- [ ] **Step 3.2 — Rebuild Tailwind**

```bash
cd /home/stephen/Development/projects/sieve/frontend && npx tailwindcss -i src/static/input.css -o src/static/tailwind.css
```

Expected: `Done in Xs.`

- [ ] **Step 3.3 — Commit**

```bash
git add frontend/src/static/input.css frontend/src/static/tailwind.css
git commit -m "feat(diagram): add diagram block CSS — header, pill toggle, edit/render modes"
```

---

## Task 4: Vendor mermaid.min.js

**Files:**
- Create: `frontend/src/static/vendor/mermaid.min.js`

- [ ] **Step 4.1 — Download mermaid v10**

```bash
curl -L "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js" \
  -o frontend/src/static/vendor/mermaid.min.js
```

- [ ] **Step 4.2 — Verify file size**

```bash
ls -lh frontend/src/static/vendor/mermaid.min.js
```

Expected: ~2–3 MB. If significantly larger (>5 MB), investigate before committing.

- [ ] **Step 4.3 — Verify it loads correctly**

```bash
head -c 200 frontend/src/static/vendor/mermaid.min.js
```

Expected: begins with minified JS, not an error page or HTML.

- [ ] **Step 4.4 — Commit**

```bash
git add frontend/src/static/vendor/mermaid.min.js
git commit -m "feat(diagram): vendor mermaid.js v10"
```

---

## Task 5: diagram-renderer.js — full implementation

**Files:**
- Create: `frontend/src/static/diagram-renderer.js`

- [ ] **Step 5.1 — Create the renderer file**

Create `frontend/src/static/diagram-renderer.js`:

```js
// diagram-renderer.js — Sieve block renderer for the 'diagram' kind.
//
// Edit mode: textarea + syntax-highlight overlay + line gutter (same pattern as code-renderer.js).
// Render mode: SVG from mermaid.js, lazy-loaded from vendor/mermaid.min.js.
// Mode is persisted in YAML via sieve:block-update so it survives document reload.

import { getLowlight, hastToHtml } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  // ── Mermaid lazy-loader ───────────────────────────────────────────────────────

  var mermaidReady = null

  function ensureMermaid() {
    if (mermaidReady) return mermaidReady
    mermaidReady = new Promise(function (resolve, reject) {
      if (window.mermaid) { initMermaid(); resolve(); return }
      var s = document.createElement('script')
      s.src = '/static/vendor/mermaid.min.js'
      s.onload = function () { initMermaid(); resolve() }
      s.onerror = function () { mermaidReady = null; reject(new Error('Failed to load mermaid.min.js')) }
      document.head.appendChild(s)
    })
    return mermaidReady
  }

  function buildMermaidTheme() {
    var s = getComputedStyle(document.documentElement)
    function v(name) { return s.getPropertyValue(name).trim() }
    return {
      startOnLoad: false,
      theme: 'base',
      themeVariables: {
        background:          v('--theme-bgDark')  || '#0e0e0e',
        primaryColor:        v('--theme-bgAlt')   || '#1a1a1a',
        primaryTextColor:    v('--theme-text')     || '#cccccc',
        lineColor:           v('--theme-fg3')      || '#555555',
        edgeLabelBackground: v('--theme-bgDark')  || '#0e0e0e',
        nodeBorder:          v('--theme-border2')  || '#3a3a3a',
        clusterBkg:          v('--theme-bgAlt')   || '#1a1a1a',
      },
    }
  }

  function initMermaid() {
    if (!window.mermaid) return
    window.mermaid.initialize(buildMermaidTheme())
  }

  // Re-theme on settings change
  document.addEventListener('sse:settings:changed', function () {
    if (window.mermaid) initMermaid()
  })

  // ── Helpers ───────────────────────────────────────────────────────────────────

  var renderCounter = 0

  function uniqueMermaidId(blockId) {
    return 'mermaid-' + (blockId || 'di') + '-' + (++renderCounter)
  }

  function updateGutter(gutter, source) {
    var lines = (source || '').split('\n')
    var count = Math.max(lines.length, 1)
    if (gutter.childElementCount === count) return
    gutter.innerHTML = ''
    for (var i = 1; i <= count; i++) {
      var span = document.createElement('span')
      span.textContent = String(i)
      gutter.appendChild(span)
    }
  }

  function applyHighlight(highlightCode, source) {
    var display = source ? source + '\n' : '\n'
    highlightCode.textContent = display
    highlightCode.className = 'hljs'
    // mermaid syntax may not be available in lowlight — fall back to plain text
    var low = getLowlight()
    if (low && source) {
      try {
        var result = low.highlight('mermaid', source)
        highlightCode.innerHTML = hastToHtml(result.children) + '\n'
        highlightCode.className = 'language-mermaid hljs'
      } catch (_) {
        // lowlight doesn't know mermaid — plain text overlay is fine
      }
    }
  }

  // ── DiagramRenderer ───────────────────────────────────────────────────────────

  var DiagramRenderer = {

    nodeConfig: {
      atom:       true,
      selectable: false,  // textarea in edit mode needs mouse to select text, not the node
      draggable:  false,
    },

    attrs: {
      source:      { default: '', parseHTML: function (el) { return el.getAttribute('data-source')       || '' } },
      diagramType: { default: 'mermaid', parseHTML: function (el) { return el.getAttribute('data-diagram-type') || 'mermaid' } },
      mode:        { default: 'render', parseHTML: function (el) { return el.getAttribute('data-mode')   || 'render' } },
    },

    parseAttrs: function (data) {
      return {
        source:      typeof data.source === 'string' ? data.source : '',
        diagramType: data.diagramType || 'mermaid',
        mode:        data.mode        || 'render',
      }
    },

    makeNodeView: function (node, editor) {
      var nodeTypeName   = node.type.name
      var currentAttrs   = Object.assign({}, node.attrs)

      // ── DOM shell ─────────────────────────────────────────────────────────────

      var dom = document.createElement('div')
      dom.className = 'sieve-block sieve-block--diagram'
      dom.setAttribute('data-id', node.attrs.id || '')
      dom.contentEditable = 'false'

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })

      // ── Header ────────────────────────────────────────────────────────────────

      var header = document.createElement('div')
      header.className = 'sieve-block__header'
      header.contentEditable = 'false'

      var badge = document.createElement('span')
      badge.className = 'sieve-block__badge'
      badge.textContent = 'diagram'

      var typeLabel = document.createElement('span')
      typeLabel.className = 'sieve-block__type-label'
      typeLabel.textContent = 'mermaid'

      var headerSpacer = document.createElement('div')
      headerSpacer.style.flex = '1'

      var toggle = document.createElement('div')
      toggle.className = 'diagram-block__toggle'

      var editBtn = document.createElement('button')
      editBtn.className = 'diagram-block__toggle-btn'
      editBtn.setAttribute('data-toggle', 'edit')
      editBtn.innerHTML =
        '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<path d="M1 7.5 L6 2 L8 4 L3 9 L1 9 Z"/><line x1="5" y1="3" x2="7" y2="5"/></svg> Edit'

      var renderBtn = document.createElement('button')
      renderBtn.className = 'diagram-block__toggle-btn'
      renderBtn.setAttribute('data-toggle', 'render')
      renderBtn.innerHTML =
        '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<ellipse cx="5" cy="5" rx="4" ry="2.5"/>' +
        '<circle cx="5" cy="5" r="1.2" fill="currentColor" stroke="none"/></svg> Render'

      toggle.appendChild(editBtn)
      toggle.appendChild(renderBtn)
      header.appendChild(badge)
      header.appendChild(typeLabel)
      header.appendChild(headerSpacer)
      header.appendChild(toggle)
      dom.appendChild(header)

      // ── Edit body ─────────────────────────────────────────────────────────────

      var editBody = document.createElement('div')
      editBody.className = 'sieve-block__body'

      var gutter = document.createElement('div')
      gutter.className = 'sieve-block__gutter'
      gutter.contentEditable = 'false'

      var codeArea = document.createElement('div')
      codeArea.className = 'sieve-block__code-area'

      var highlightPre = document.createElement('pre')
      highlightPre.className = 'sieve-block__highlight'
      var highlightCode = document.createElement('code')
      highlightPre.appendChild(highlightCode)

      var editEl = document.createElement('textarea')
      editEl.className = 'sieve-block__edit'
      editEl.spellcheck = false
      editEl.setAttribute('autocorrect', 'off')
      editEl.setAttribute('autocapitalize', 'off')
      editEl.setAttribute('autocomplete', 'off')

      codeArea.appendChild(highlightPre)
      codeArea.appendChild(editEl)
      editBody.appendChild(gutter)
      editBody.appendChild(codeArea)

      // ── Render body ───────────────────────────────────────────────────────────

      var renderBody = document.createElement('div')
      renderBody.className = 'diagram-block__render'

      // ── State helpers ─────────────────────────────────────────────────────────

      function flushSource() {
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'diagram', attrs: { source: editEl.value } },
        }))
      }

      function switchMode(newMode) {
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'diagram', attrs: { mode: newMode } },
        }))
      }

      function updateToggle(mode) {
        editBtn.className = 'diagram-block__toggle-btn' +
          (mode === 'edit' ? ' diagram-block__toggle-btn--active-edit' : '')
        renderBtn.className = 'diagram-block__toggle-btn' +
          (mode === 'render' ? ' diagram-block__toggle-btn--active-render' : '')
      }

      // ── Render function ───────────────────────────────────────────────────────

      function showEdit(attrs) {
        if (dom.contains(renderBody)) dom.removeChild(renderBody)
        if (!dom.contains(editBody)) dom.appendChild(editBody)
        if (document.activeElement !== editEl) {
          editEl.value = attrs.source || ''
          applyHighlight(highlightCode, attrs.source || '')
          updateGutter(gutter, attrs.source || '')
        }
      }

      function showRender(attrs) {
        if (dom.contains(editBody)) dom.removeChild(editBody)
        if (!dom.contains(renderBody)) dom.appendChild(renderBody)

        var src = (attrs.source || '').trim()

        if (!src) {
          renderBody.innerHTML =
            '<div class="diagram-block__loading" style="color:var(--theme-fg3);font-size:12px;padding:20px">' +
            'Add diagram source in Edit mode</div>'
          return
        }

        renderBody.innerHTML = '<div class="diagram-block__loading"><span class="diagram-block__spinner"></span>Rendering…</div>'

        ensureMermaid().then(function () {
          var id = uniqueMermaidId(attrs.id)
          return window.mermaid.render(id, src)
        }).then(function (result) {
          renderBody.innerHTML = ''
          renderBody.innerHTML = result.svg
        }).catch(function (err) {
          var msg = (err && err.message) ? err.message : String(err)
          renderBody.innerHTML =
            '<div class="diagram-block__error">' +
            '<div class="diagram-block__error-icon">⚠</div>' +
            '<div>' +
            '<div class="diagram-block__error-title">Diagram syntax error</div>' +
            '<div class="diagram-block__error-msg">' + msg.replace(/</g, '&lt;') + '</div>' +
            '</div></div>'
          // flip back to edit mode
          switchMode('edit')
        })
      }

      function render(attrs) {
        currentAttrs = attrs
        updateToggle(attrs.mode)
        if (attrs.mode === 'render') {
          showRender(attrs)
        } else {
          showEdit(attrs)
        }
      }

      render(node.attrs)

      // ── Events ────────────────────────────────────────────────────────────────

      editBtn.addEventListener('mousedown', function (e) {
        e.preventDefault()
        e.stopPropagation()
        if (currentAttrs.mode !== 'edit') switchMode('edit')
        else editEl.focus()
      })

      renderBtn.addEventListener('mousedown', function (e) {
        e.preventDefault()
        e.stopPropagation()
        if (currentAttrs.mode !== 'render') {
          flushSource()
          switchMode('render')
        }
      })

      var inputTimer = null
      var highlightTimer = null

      editEl.addEventListener('input', function () {
        updateGutter(gutter, editEl.value)
        clearTimeout(highlightTimer)
        highlightTimer = setTimeout(function () {
          applyHighlight(highlightCode, editEl.value)
        }, 50)
        clearTimeout(inputTimer)
        inputTimer = setTimeout(flushSource, 200)
      })

      editEl.addEventListener('blur', function () {
        clearTimeout(highlightTimer)
        clearTimeout(inputTimer)
        flushSource()
        applyHighlight(highlightCode, editEl.value)
        updateGutter(gutter, editEl.value)
      })

      editEl.addEventListener('paste', function (e) { e.stopPropagation() })

      editEl.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') {
          e.preventDefault()
          var start = editEl.selectionStart
          var end   = editEl.selectionEnd
          editEl.value = editEl.value.substring(0, start) + '  ' + editEl.value.substring(end)
          editEl.selectionStart = editEl.selectionEnd = start + 2
          updateGutter(gutter, editEl.value)
          clearTimeout(highlightTimer)
          highlightTimer = setTimeout(function () { applyHighlight(highlightCode, editEl.value) }, 50)
          clearTimeout(inputTimer)
          inputTimer = setTimeout(flushSource, 200)
          return
        }
        // Ctrl+Enter / Cmd+Enter: flush source and switch to render mode
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          flushSource()
          switchMode('render')
          return
        }
        if (e.metaKey || e.ctrlKey) return
        e.stopPropagation()
      })

      // ── NodeView ──────────────────────────────────────────────────────────────

      return {
        dom:        dom,
        contentDOM: null,

        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          render(updatedNode.attrs)
          return true
        },

        selectNode: function () {
          if (currentAttrs.mode === 'edit') editEl.focus()
        },

        ignoreMutation: function () { return true },

        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },

        destroy: function () {
          clearTimeout(inputTimer)
          clearTimeout(highlightTimer)
        },
      }
    },
  }

  // ── Context menu ──────────────────────────────────────────────────────────────

  DiagramRenderer.buildContextMenuItems = function (ctx) {
    var n = ctx.node, editor = ctx.editor, getPos = ctx.getPos
    var IC = window.SieveIcons || {}

    function del() {
      if (typeof getPos === 'function') {
        var pos = getPos()
        editor.view.dispatch(editor.state.tr.delete(pos, pos + n.nodeSize))
      }
    }

    function toggleMode() {
      var newMode = n.attrs.mode === 'render' ? 'edit' : 'render'
      document.dispatchEvent(new CustomEvent('sieve:block-update', {
        detail: { id: n.attrs.id, kind: 'diagram', attrs: { mode: newMode } },
      }))
    }

    function copySource() {
      if (n.attrs.source) navigator.clipboard.writeText(n.attrs.source)
    }

    var modeLabel = n.attrs.mode === 'render' ? 'Edit source' : 'Render'

    return [
      { icon: IC.edit,    label: modeLabel, action: toggleMode },
      { type: 'divider' },
      { icon: IC.copy,    label: 'Copy source', action: copySource },
      { icon: IC.sparkle, label: 'Ask AI…', action: function () {
        if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
        else editor.commands.focus()
        var ctx = {
          content:      n.attrs.source || '',
          blockRef:     n.attrs.id || 'doc',
          history:      '',
          contextLabel: 'Diagram',
          imageIds:     [],
        }
        document.dispatchEvent(new CustomEvent('sieve:ai-ask', { detail: { precomputedCtx: ctx } }))
      }},
      { type: 'divider' },
      { icon: IC.trash, label: 'Delete', action: del },
    ]
  }

  T.registerSieveRenderer('diagram', DiagramRenderer)

})()
```

- [ ] **Step 5.2 — Commit**

```bash
git add frontend/src/static/diagram-renderer.js
git commit -m "feat(diagram): add diagram-renderer.js — edit/render toggle, mermaid lazy-load"
```

---

## Task 6: Wire up index.html, editor.js, help.html

**Files:**
- Modify: `frontend/src/index.html`
- Modify: `frontend/src/static/editor.js`
- Modify: `frontend/src/templates/help.html`

- [ ] **Step 6.1 — Add script tag to `frontend/src/index.html`**

Find the line:
```html
    <script type="module" src="/static/rich-link-renderer.js"></script>
```

Add immediately after it:
```html
    <script type="module" src="/static/diagram-renderer.js"></script>
```

- [ ] **Step 6.2 — Add `Ctrl+Shift+D` shortcut to `frontend/src/static/editor.js`**

Find the keydown block that currently ends at:
```js
    if (e.key === 'L' && window.isMod(e) && e.shiftKey && !e.altKey) {
      e.preventDefault()
      ensureOverlays()
      openRichLinkDialog()
    }
  })
```

Add the `D` case inside the same listener, immediately after the `L` case:
```js
    if (e.key === 'L' && window.isMod(e) && e.shiftKey && !e.altKey) {
      e.preventDefault()
      ensureOverlays()
      openRichLinkDialog()
    }
    if (e.key === 'D' && window.isMod(e) && e.shiftKey && !e.altKey) {
      e.preventDefault()
      if (!currentUuid || !currentEditor) return
      wsSend({ type: 'create-block', kind: 'diagram', attrs: {}, uuid: currentUuid })
    }
  })
```

- [ ] **Step 6.3 — Add help entry to `frontend/src/templates/help.html`**

Find:
```html
          <tr>
            <td class="help-modal__keys"><kbd class="help-modal__kbd">Mod</kbd><span class="help-modal__plus">+</span><kbd class="help-modal__kbd">Shift</kbd><span class="help-modal__plus">+</span><kbd class="help-modal__kbd">L</kbd></td>
            <td class="help-modal__desc">Insert URL Card</td>
          </tr>
```

Add immediately after it:
```html
          <tr>
            <td class="help-modal__keys"><kbd class="help-modal__kbd">Mod</kbd><span class="help-modal__plus">+</span><kbd class="help-modal__kbd">Shift</kbd><span class="help-modal__plus">+</span><kbd class="help-modal__kbd">D</kbd></td>
            <td class="help-modal__desc">Insert Diagram</td>
          </tr>
```

- [ ] **Step 6.4 — Build check**

```bash
go build -tags webkit2_41 ./...
```

Expected: no errors

- [ ] **Step 6.5 — Smoke test in wails dev**

```bash
wails dev
```

Verify:
1. `Ctrl+Shift+D` creates a diagram block in edit mode (empty textarea visible, edit tab highlighted blue)
2. Typing mermaid source and clicking Render shows the SVG (or loading indicator then SVG)
3. Clicking Edit returns to the textarea with the source intact; `Ctrl+Enter` in the textarea also switches to render mode
4. Pasting ` ```mermaid\ngraph TD\n  A-->B\n``` ` creates a diagram block in render mode
5. Right-clicking the block shows the context menu with Edit source / Copy source / Ask AI / Delete
6. `Ctrl+/` opens help — "Insert Diagram" entry visible alongside "Insert URL Card"
7. Promote to Document (context menu) replaces block with ` ```mermaid\n...\n``` ` fence in the document

- [ ] **Step 6.6 — Commit**

```bash
git add frontend/src/index.html frontend/src/static/editor.js frontend/src/templates/help.html
git commit -m "feat(diagram): wire up script tag, Ctrl+Shift+D shortcut, help page entry"
```
