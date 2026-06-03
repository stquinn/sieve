# Smart-Link → Sieve Block Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate SmartLink from a bespoke inline TipTap node (smart-link-extension.js) to a first-class sieve block rendered by the sieve-block-extension.js framework.

**Architecture:** SmartLink becomes a block-level fenced YAML node (`kind: smart-link`). Pasting a plain URL creates a `smart-link` block via Go's `PasteMatch`/`RunJob` — the JS URL-paste shortcut (editor.js step 3) is removed. The link bubble is removed; the block renders a compact link card. `smart-link-extension.js` is deleted.

**Tech Stack:** Go (sieve package), vanilla JS (sieve-block-extension.js renderer pattern), editor.css

---

## Architectural notes for the implementer

**What changes semantically:** SmartLinks move from inline `[label](href){id="..." detect="..."}` to block-level fenced YAML. A pasted URL creates a block below the cursor, not an inline hyperlink.

**Backward compat:** Existing documents with `[label](href){id="..." detect="..."}` will render the `{…}` suffix as literal text after the link — TipTap's default link mark will handle the `[label](href)` part, and `{id="…" detect="…"}` becomes visible text. This is expected and acceptable; no migration script is needed.

**PasteMatch priority:** `smart-link` is registered third, after `code` and `web-clip`. Code's PasteMatch only matches fenced code blocks; web-clip's PasteMatch returns false. A plain text URL therefore falls through to `smart-link`.

**Title-fetch failures are graceful:** `RunJob` sets `status: COMPLETE` even when `GetLinkTitle` fails, using `href` as the label. Blocks never get stuck in ERROR just because a page title couldn't be read.

---

## Files

| Action | File | Purpose |
|--------|------|---------|
| Create | `sieve/smart_link_processor_test.go` | Processor tests |
| Create | `sieve/smart_link_processor.go` | BlockProcessor implementation |
| Modify | `sieve/service_provider.go` | RegisterProcessor call |
| Create | `frontend/src/static/smart-link-renderer.js` | JS renderer |
| Modify | `frontend/src/static/editor.css` | Add .smart-link-block styles, remove .link-bubble styles |
| Modify | `frontend/src/index.html` | Add renderer `<script>`, remove smart-link-extension.js `<script>` |
| Modify | `frontend/src/static/editor.js` | Remove T.SmartLink extension, remove URL-paste step 3, remove generateId |
| Delete | `frontend/src/static/smart-link-extension.js` | Decommissioned |

---

## Task 1: Write failing Go processor tests

**Files:**
- Create: `sieve/smart_link_processor_test.go`

- [ ] **Step 1: Write the test file**

```go
package sieve

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
	"sieve/store/filestore"
)

// ── InitAttrs ────────────────────────────────────────────────────────────────

func TestSmartLinkProcessor_InitAttrs_defaults(t *testing.T) {
	p := &SmartLinkProcessor{}
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
	p := &SmartLinkProcessor{}
	attrs := p.InitAttrs("sl-0001", map[string]interface{}{"href": "https://example.com"})
	if attrs["label"] != "https://example.com" {
		t.Errorf("label should default to href; got %q", attrs["label"])
	}
}

func TestSmartLinkProcessor_InitAttrs_explicitLabelPreserved(t *testing.T) {
	p := &SmartLinkProcessor{}
	attrs := p.InitAttrs("sl-0001", map[string]interface{}{
		"href":  "https://example.com",
		"label": "My Site",
	})
	if attrs["label"] != "My Site" {
		t.Errorf("explicit label must be preserved; got %q", attrs["label"])
	}
}

func TestSmartLinkProcessor_InitAttrs_idNotOverridable(t *testing.T) {
	p := &SmartLinkProcessor{}
	attrs := p.InitAttrs("sl-0001", map[string]interface{}{"id": "injected"})
	if attrs["id"] != "sl-0001" {
		t.Error("id must not be overridable via overrides")
	}
}

// ── PasteMatch ───────────────────────────────────────────────────────────────

func TestSmartLinkProcessor_PasteMatch_httpsURL(t *testing.T) {
	p := &SmartLinkProcessor{}
	ok, overrides := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "https://example.com"}})
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
	p := &SmartLinkProcessor{}
	ok, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "http://example.com/path?q=1"}})
	if !ok {
		t.Fatal("expected match for plain HTTP URL")
	}
}

func TestSmartLinkProcessor_PasteMatch_multiLine(t *testing.T) {
	p := &SmartLinkProcessor{}
	ok, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "https://a.com\nhttps://b.com"}})
	if ok {
		t.Error("multi-line paste must not match")
	}
}

func TestSmartLinkProcessor_PasteMatch_plainText(t *testing.T) {
	p := &SmartLinkProcessor{}
	ok, _ := p.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "just some text"}})
	if ok {
		t.Error("plain text must not match")
	}
}

func TestSmartLinkProcessor_PasteMatch_noEntries(t *testing.T) {
	p := &SmartLinkProcessor{}
	ok, _ := p.PasteMatch(nil)
	if ok {
		t.Error("empty clipboard must not match")
	}
}

// ── RunJob ───────────────────────────────────────────────────────────────────

func newSmartLinkTestAI(t *testing.T, tmpDir string) *AIService {
	t.Helper()
	fs, err := filestore.NewFileStore(tmpDir, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	state, err := NewStateService(fs)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	prompts, err := NewPromptService(fs)
	if err != nil {
		t.Fatalf("NewPromptService: %v", err)
	}
	ds, err := NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	return NewAIService(state, prompts, ds, tmpDir)
}

func TestSmartLinkProcessor_RunJob_fetchesTitle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<html><head><title>Example Domain</title></head><body></body></html>`))
	}))
	defer srv.Close()

	ai := newSmartLinkTestAI(t, t.TempDir())
	p := &SmartLinkProcessor{}
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

	err := p.RunJob(context.Background(), "uuid-1", block, Services{AI: ai})
	if err != nil {
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
	// Unreachable server → GetLinkTitle returns error
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer srv.Close()

	ai := newSmartLinkTestAI(t, t.TempDir())
	p := &SmartLinkProcessor{}
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

	err := p.RunJob(context.Background(), "uuid-1", block, Services{AI: ai})
	if err != nil {
		t.Fatalf("RunJob must not return error on title-fetch failure; got %v", err)
	}
	if block.Attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %q; a failed title fetch must still COMPLETE the block", block.Attrs["status"])
	}
	if block.Attrs["label"] != srv.URL {
		t.Errorf("label must fall back to href; got %q", block.Attrs["label"])
	}
}

func TestSmartLinkProcessor_RunJob_nilAIService(t *testing.T) {
	p := &SmartLinkProcessor{}
	block := &SieveBlock{
		ID:   "sl-0003",
		Kind: "smart-link",
		Attrs: map[string]interface{}{
			"href":      "https://example.com",
			"label":     "https://example.com",
			"status":    BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}
	err := p.RunJob(context.Background(), "uuid-1", block, Services{AI: nil})
	if err != nil {
		t.Fatalf("RunJob must not panic or return error with nil AI; got %v", err)
	}
	if block.Attrs["status"] != BlockStatusComplete {
		t.Errorf("status: got %q, want COMPLETE", block.Attrs["status"])
	}
}
```

- [ ] **Step 2: Run to confirm the tests fail (file under test doesn't exist)**

```bash
go test -tags webkit2_41 ./sieve/... -run TestSmartLink -v 2>&1 | head -30
```
Expected: compilation error — `SmartLinkProcessor` undefined.

---

## Task 2: Implement SmartLinkProcessor

**Files:**
- Create: `sieve/smart_link_processor.go`

- [ ] **Step 1: Write the implementation**

```go
package sieve

import (
	"context"
	"net/url"
	"strings"
	"time"
)

// SmartLinkProcessor handles the 'smart-link' block kind.
// Pasting a bare URL (http:// or https://) creates this block. RunJob fetches
// the page title and sets it as the label. Title-fetch failures are silent —
// the block completes with href as the label rather than entering ERROR state.
type SmartLinkProcessor struct{}

func (p *SmartLinkProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":          id,
		"href":        "",
		"label":       "",
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
	// label defaults to href when the caller did not supply one
	if label, _ := attrs["label"].(string); label == "" {
		if href, _ := attrs["href"].(string); href != "" {
			attrs["label"] = href
		}
	}
	return attrs
}

// PasteMatch returns true for a clipboard that contains a single bare URL
// (http:// or https://) and nothing else. Multi-line pastes and prose text
// are not matched so that paragraph text containing a URL is not swallowed.
func (p *SmartLinkProcessor) PasteMatch(entries []PasteEntry) (bool, map[string]interface{}) {
	var content string
	for _, e := range entries {
		if e.MIMEType == "text/plain" {
			content = e.Content
			break
		}
	}
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return false, nil
	}
	if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
		return false, nil
	}
	// Reject multi-line pastes — only a single isolated URL should match.
	if strings.ContainsAny(trimmed, " \t\n\r") {
		return false, nil
	}
	return true, map[string]interface{}{"href": trimmed, "label": trimmed}
}

func (p *SmartLinkProcessor) OnChange(block *SieveBlock, _ Services) {}

func (p *SmartLinkProcessor) BuildContext(block SieveBlock, _ ShadowDocument) string {
	href, _ := block.Attrs["href"].(string)
	label, _ := block.Attrs["label"].(string)
	if label != "" && label != href {
		return "[" + label + "](" + href + ")"
	}
	return href
}

func (p *SmartLinkProcessor) JobLabel(block *SieveBlock) string {
	href, _ := block.Attrs["href"].(string)
	host := href
	if u, err := url.Parse(href); err == nil && u.Host != "" {
		host = u.Host
	}
	return "Fetching " + host
}

func (p *SmartLinkProcessor) RunJob(ctx context.Context, uuid string, block *SieveBlock, svc Services) error {
	href, _ := block.Attrs["href"].(string)
	now := time.Now().UTC().Format(time.RFC3339)

	if href == "" || svc.AI == nil {
		block.Attrs["status"] = BlockStatusComplete
		block.Attrs["completedAt"] = now
		return nil
	}

	title, err := svc.AI.GetLinkTitle(href)
	if err != nil || strings.TrimSpace(title) == "" {
		// Title fetch failed — use href as label, still mark COMPLETE.
		// SmartLinks are useful even without a resolved title.
		block.Attrs["status"] = BlockStatusComplete
		block.Attrs["label"] = href
		block.Attrs["completedAt"] = now
		return nil
	}

	block.Attrs["status"] = BlockStatusComplete
	block.Attrs["label"] = strings.TrimSpace(title)
	block.Attrs["completedAt"] = now
	return nil
}
```

- [ ] **Step 2: Run tests to confirm they pass**

```bash
go test -tags webkit2_41 ./sieve/... -run TestSmartLink -v 2>&1
```
Expected: all `TestSmartLink*` tests PASS.

---

## Task 3: Register processor and build check

**Files:**
- Modify: `sieve/service_provider.go` — add `RegisterProcessor` call

- [ ] **Step 1: Add registration alongside existing calls**

In `sieve/service_provider.go`, find the block:
```go
RegisterProcessor("code",     &CodeBlockProcessor{})
RegisterProcessor("web-clip", &WebClipBlockProcessor{})
```

Add the smart-link line after web-clip:
```go
RegisterProcessor("code",       &CodeBlockProcessor{})
RegisterProcessor("web-clip",   &WebClipBlockProcessor{})
RegisterProcessor("smart-link", &SmartLinkProcessor{})
```

- [ ] **Step 2: Build check**

```bash
go build -tags webkit2_41 ./...
```
Expected: compiles with no errors.

- [ ] **Step 3: Run full test suite**

```bash
go test -tags webkit2_41 ./sieve/... -v 2>&1 | tail -20
```
Expected: all tests PASS (or only pre-existing failures).

- [ ] **Step 4: Commit**

```bash
git add sieve/smart_link_processor.go sieve/smart_link_processor_test.go sieve/service_provider.go
git commit -m "feat(sieve): add SmartLinkProcessor for smart-link sieve block kind"
```

---

## Task 4: Create the JS renderer

**Files:**
- Create: `frontend/src/static/smart-link-renderer.js`

- [ ] **Step 1: Write the renderer**

```js
// smart-link-renderer.js — Smart Link block renderer.
// Registers window.TipTap.registerSieveRenderer('smart-link', SmartLinkRenderer)
// A smart-link block is created by pasting a bare URL. Go's RunJob fetches the
// page title; the renderer shows a compact link card.

import { isJobStale } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  var SmartLinkRenderer = {

    nodeConfig: { atom: true, selectable: true, draggable: false },

    attrs: {
      href:        { default: '',   parseHTML: function (el) { return el.getAttribute('data-href')         || '' } },
      label:       { default: '',   parseHTML: function (el) { return el.getAttribute('data-label')        || '' } },
      completedAt: { default: null, parseHTML: function (el) { return el.getAttribute('data-completed-at') || null } },
      error:       { default: null, parseHTML: function (el) { return el.getAttribute('data-error')        || null } },
    },

    parseAttrs: function (data) {
      return {
        href:        data.href        || '',
        label:       data.label       || '',
        completedAt: data.completedAt || null,
        error:       data.error       || null,
      }
    },

    makeNodeView: function (node, editor) {
      var dom = document.createElement('div')
      dom.className = 'smart-link-block'
      dom.contentEditable = 'false'
      dom.setAttribute('data-sl-id', node.attrs.id || '')

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })
      dom.addEventListener('mousedown', function (e) { e.stopPropagation() })

      function openURL(href) {
        if (href && window.runtime && window.runtime.BrowserOpenURL) {
          window.runtime.BrowserOpenURL(href)
        }
      }

      function render(n) {
        dom.innerHTML = ''
        dom.setAttribute('data-sl-id', n.attrs.id || '')
        dom.className = 'smart-link-block'

        var status = n.attrs.status || 'PENDING'
        var href = n.attrs.href || ''
        var label = n.attrs.label || href

        var icon = document.createElement('span')
        icon.className = 'smart-link-block__icon'
        icon.textContent = '🔗'

        var textWrap = document.createElement('div')
        textWrap.className = 'smart-link-block__text'

        if (status === 'PENDING' || status === 'DISPATCHED') {
          dom.classList.add('smart-link-block--loading')
          var titleEl = document.createElement('span')
          titleEl.className = 'smart-link-block__title'
          titleEl.textContent = label || href || 'Fetching…'
          var urlEl = document.createElement('span')
          urlEl.className = 'smart-link-block__url'
          urlEl.textContent = 'Fetching title…'
          textWrap.appendChild(titleEl)
          textWrap.appendChild(urlEl)

          if (isJobStale(n.attrs.createdAt, n.attrs.id)) {
            dom.classList.remove('smart-link-block--loading')
            var retryBtn = document.createElement('button')
            retryBtn.className = 'smart-link-block__retry'
            retryBtn.textContent = 'Retry'
            retryBtn.addEventListener('click', function () {
              document.dispatchEvent(new CustomEvent('sieve:block-retry', { detail: { id: n.attrs.id } }))
            })
            textWrap.appendChild(retryBtn)
          }
        } else if (status === 'COMPLETE') {
          var titleLink = document.createElement('a')
          titleLink.className = 'smart-link-block__title'
          titleLink.href = href || '#'
          titleLink.textContent = label || href
          titleLink.title = 'Ctrl+Click to open'
          titleLink.addEventListener('click', function (e) {
            e.preventDefault()
            if (window.isMod && window.isMod(e)) {
              openURL(href)
            }
          })
          var urlEl = document.createElement('span')
          urlEl.className = 'smart-link-block__url'
          urlEl.textContent = href
          textWrap.appendChild(titleLink)
          textWrap.appendChild(urlEl)
        } else {
          // ERROR / TIMEOUT
          dom.classList.add('smart-link-block--error')
          var errLink = document.createElement('a')
          errLink.className = 'smart-link-block__title'
          errLink.href = href || '#'
          errLink.textContent = label || href
          errLink.addEventListener('click', function (e) {
            e.preventDefault()
            if (window.isMod && window.isMod(e)) openURL(href)
          })
          var errMsg = document.createElement('span')
          errMsg.className = 'smart-link-block__url smart-link-block__url--error'
          errMsg.textContent = (n.attrs.error || 'Could not fetch title').trim()
          textWrap.appendChild(errLink)
          textWrap.appendChild(errMsg)
        }

        dom.appendChild(icon)
        dom.appendChild(textWrap)
      }

      render(node)

      return {
        dom: dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieve-smart-link') return false
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
      var node = opts.node
      var editor = opts.editor
      var getPos = opts.getPos
      var IC = window.SieveIcons || {}
      var href = node.attrs.href || ''
      var label = node.attrs.label || href

      function del() {
        if (typeof getPos === 'function') {
          var pos = getPos()
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
        }
      }

      var items = [
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
        { type: 'divider' },
        { icon: IC.trash, label: 'Delete', action: del },
      ]

      if (node.attrs.status === 'COMPLETE' && href) {
        items.push({ type: 'divider' })
        items.push({
          icon: IC.sparkle,
          label: 'Ask AI…',
          action: function () {
            if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
            else editor.commands.focus()
            var ctx = {
              content: label !== href ? '[' + label + '](' + href + ')' : href,
              history: '',
              blockRef: node.attrs.id,
              imageIds: [],
              contextLabel: 'Smart Link',
            }
            document.dispatchEvent(new CustomEvent('sieve:ai-ask', { detail: { precomputedCtx: ctx } }))
          },
        })
      }

      return items
    },
  }

  T.registerSieveRenderer('smart-link', SmartLinkRenderer)
})()
```

---

## Task 5: Add CSS for smart-link-block; remove link-bubble CSS

**Files:**
- Modify: `frontend/src/static/editor.css`

Two operations in this task: add new styles, remove dead styles.

### 5a — Add smart-link-block styles

Find the end of the `/* ── Web-clip blocks */` section (around line 1030 in the current file, after `.web-clip-block__retry:hover`). Add the following block immediately after:

```css
/* ── Smart-link blocks ───────────────────────────────────────────────── */

.smart-link-block {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  background: var(--theme-bgAlt);
  padding: 0.4rem 0.7rem;
  margin: 0.25rem 0;
  max-width: 560px;
  cursor: default;
  transition: border-color 0.15s ease;
  user-select: text;
  -webkit-user-select: text;
}

.smart-link-block:hover {
  border-color: var(--theme-accentPrimary);
}

.smart-link-block.ProseMirror-selectednode {
  border-color: var(--theme-accentPrimary) !important;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-accentPrimary) 25%, transparent) !important;
  outline: none !important;
}

.smart-link-block__icon {
  font-size: 14px;
  flex-shrink: 0;
  line-height: 1;
}

.smart-link-block__text {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
}

.smart-link-block__title {
  color: var(--theme-accentPrimary);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 480px;
}

.smart-link-block__title:hover { text-decoration: underline; }

.smart-link-block__url {
  color: var(--theme-muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 480px;
}

.smart-link-block--loading .smart-link-block__title {
  color: var(--theme-muted);
  font-style: italic;
}

.smart-link-block--error .smart-link-block__title { color: var(--theme-accentOrange); }
.smart-link-block__url--error { color: var(--theme-accentOrange); }

.smart-link-block__retry {
  background: var(--theme-border2);
  border: none;
  border-radius: 4px;
  color: var(--theme-text);
  cursor: pointer;
  font-size: 11px;
  padding: 0.15rem 0.5rem;
  margin-top: 0.2rem;
}

.smart-link-block__retry:hover { background: var(--theme-bgAlt); }
```

### 5b — Remove the first link-bubble block (around line 230)

Remove the entire section from `/* ── Link bubble menu ── */` through the closing `}` of `.link-bubble__btn--remove:hover`. That is, remove lines that look like:

```css
/* ── Link bubble menu ────────────────────────────────────────────────── */

.link-bubble { ... }
.link-bubble__input { ... }
.link-bubble__input:focus { ... }
.link-bubble__btn { ... }
.link-bubble__btn:hover { ... }
.link-bubble__btn--remove { ... }
.link-bubble__btn--remove:hover { ... }
```

### 5c — Remove the second link-bubble block (around line 2208)

Remove the section from `/* The main container */` comment through the closing `}` of `.link-bubble__actions`. That section spans roughly:

```css
/* The main container */
.link-bubble { ... }
/* Individual Rows */
.link-bubble__row { ... }
.link-bubble__row label { ... }
/* Input styling */
.link-bubble__input { ... }
/* Action row */
.link-bubble__actions { ... }
```

- [ ] **Step 1: Add smart-link-block styles after web-clip section**

Use the Edit tool — find the exact end of the web-clip section (the `.web-clip-block__retry:hover` rule) and insert the smart-link CSS immediately after.

- [ ] **Step 2: Remove first link-bubble block**

Use the Edit tool — remove from `/* ── Link bubble menu` through `.link-bubble__btn--remove:hover { background: color-mix(...); }`.

- [ ] **Step 3: Remove second link-bubble block**

Use the Edit tool — remove from `/* The main container */` through the closing `}` of `.link-bubble__actions { ... }`.

---

## Task 6: Wire into index.html

**Files:**
- Modify: `frontend/src/index.html`

- [ ] **Step 1: Find the renderer script tags**

They look like:
```html
<script type="module" src="/static/code-renderer.js"></script>
<script type="module" src="/static/web-clip-renderer.js"></script>
```

- [ ] **Step 2: Add smart-link-renderer.js after web-clip-renderer.js**

```html
<script type="module" src="/static/code-renderer.js"></script>
<script type="module" src="/static/web-clip-renderer.js"></script>
<script type="module" src="/static/smart-link-renderer.js"></script>
```

- [ ] **Step 3: Remove the smart-link-extension.js script tag**

Find and remove:
```html
<script type="module" src="/static/smart-link-extension.js"></script>
```

---

## Task 7: Update editor.js

**Files:**
- Modify: `frontend/src/static/editor.js`

Three surgical removals in this task.

### 7a — Remove T.SmartLink from TipTap extension list

Find the block (around line 108):
```js
].concat(T.getSieveNodes()).concat([
  T.SmartLink,
  T.TaskList,
```

Change to:
```js
].concat(T.getSieveNodes()).concat([
  T.TaskList,
```

### 7b — Remove the JS URL-paste step 3 block

Find and remove the entire block (around line 1077):
```js
    // ── 3. URL paste → smartLink (JS-owned) ─────────────────────────────────────
    if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
      event.preventDefault()
      var id = generateId('lnk')
      currentEditor.commands.insertContent({
        type: 'smartLink',
        attrs: { id: id, detect: 'pending', href: text, label: text }
      })
      fetch('/api/link-preview?url=' + encodeURIComponent(text))
        .then(function(r) { return r.ok ? r.text() : null })
        .then(function(title) {
          if (!title || title.trim() === '') return
          currentEditor.commands.command(function(props) {
            var tr = props.tr
            var state = props.state
            var found = false
            state.doc.descendants(function(node, pos) {
              if (node.type.name === 'smartLink' && node.attrs.id === id) {
                found = true
                tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, { label: title, detect: 'peek' }))
                return false
              }
            })
            if (found) {
              currentEditor.view.dispatch(tr)
              var md = currentEditor.storage.markdown.getMarkdown() || ''
              lastSyncedBody = md
              wsSend({ type: 'doc-update', uuid: currentUuid, markdown: md })
              document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
            }
            return found
          })
        }).catch(function(err) { console.error('[editor.js] GetLinkTitle failed', err) })
      return true
    }
```

After this removal, the step numbers in the surrounding comment blocks shift — update the `// ── 4. Smart-paste pipeline` comment to `// ── 3. Smart-paste pipeline` (or leave it as-is; both are fine, renumbering is cosmetic).

### 7c — Remove the generateId helper function

Find and remove (around line 1161):
```js
  function generateId(prefix = "blk") {
    var id = prefix + '-' + Math.random().toString(16).substring(2, 6)
    return id;
  }
```

- [ ] **Step 1: Remove T.SmartLink from extensions list**

Use the Edit tool with the exact context shown above.

- [ ] **Step 2: Remove the URL-paste step 3 block**

Use the Edit tool. Find the exact text starting with `// ── 3. URL paste → smartLink` and ending with `return true` (the final `return true` in that block, not a later one).

- [ ] **Step 3: Remove generateId**

Use the Edit tool.

- [ ] **Step 4: Build check**

```bash
go build -tags webkit2_41 ./...
```

---

## Task 8: Decommission smart-link-extension.js

**Files:**
- Delete: `frontend/src/static/smart-link-extension.js`

- [ ] **Step 1: Delete the file**

```bash
rm /home/stephen/Development/projects/sieve/frontend/src/static/smart-link-extension.js
```

---

## Task 9: Full verification

- [ ] **Step 1: Run Go tests**

```bash
go test -tags webkit2_41 ./sieve/... -v 2>&1 | tail -30
```
Expected: all tests pass.

- [ ] **Step 2: Confirm no JS references remain**

```bash
grep -r "SmartLink\|smartLink\|smart-link-extension\|link-bubble\|generateId" \
  /home/stephen/Development/projects/sieve/frontend/src/static/editor.js \
  /home/stephen/Development/projects/sieve/frontend/src/index.html
```
Expected: no output (no remaining references).

- [ ] **Step 3: Build check**

```bash
go build -tags webkit2_41 ./...
```
Expected: clean build.

- [ ] **Step 4: Commit everything**

```bash
git add \
  frontend/src/static/smart-link-renderer.js \
  frontend/src/static/editor.css \
  frontend/src/index.html \
  frontend/src/static/editor.js
git rm frontend/src/static/smart-link-extension.js
git commit -m "feat(sieve): migrate SmartLink to sieve block framework, decommission smart-link-extension.js"
```

---

## Out of scope / future

- **`/api/link-preview` HTTP endpoint** (`requesthandlers/ai_handler.go:358`) is now dead code. Remove in a separate cleanup commit.
- **Link editing**: The link bubble is removed. To edit a smart-link's label or URL, delete the block and re-paste. A "Edit…" context-menu action that dispatches `sieve:block-update` can be added as a future enhancement.
- **Backward compat**: Existing documents with `[label](href){id="..." detect="..."}` will show the `{…}` suffix as literal text. Clean up individually if needed.
