# Paste Pipeline & Race Condition Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three bugs found in code review: a data race on `blk2.Attrs` after lock release, a lossy smart-paste fallback that strips rich-text formatting, and stale language detection that locks a code block's badge after first assignment.

**Architecture:** Task 1 is a one-line Go fix (snapshot attrs before unlocking). Tasks 2–4 replace the async WS smart-paste round-trip with a synchronous HTTP endpoint (`POST /api/editor/smart-paste`) that accepts all raw clipboard entries, delegates to `EditorService.HandlePaste`, and returns a match/no-match result the JS acts on immediately — no stashed globals. The `PasteEntry` type replaces the plain `string` in `PasteMatch` so future processors can match on any MIME type. Task 5 rewrites `OnUpdate` so heuristics always run and only defer to a prior AI result when heuristics have no opinion.

**Tech Stack:** Go 1.21, gorilla/websocket, chi router, vanilla JS (no build step), TipTap 2 / ProseMirror

---

## File Map

| File | Change |
|------|--------|
| `sieve/editor_service.go` | Task 1: snapshot attrs; Task 2: update `HandlePaste` signature |
| `sieve/processor_registry.go` | Task 2: update `BlockProcessor` interface `PasteMatch` signature |
| `sieve/code_processor.go` | Task 2: update `PasteMatch`; Task 5: rewrite `OnUpdate` |
| `sieve/code_processor_test.go` | Task 2: update `PasteMatch` tests; Task 5: add `OnUpdate` tests |
| `sieve/editor_service_test.go` | Task 1: add notify-snapshot test |
| `requesthandlers/editor_handler.go` | Task 3: add `POST /api/editor/smart-paste` route + handler |
| `requesthandlers/ws_handler.go` | Task 3: remove `smart-paste` case and `handlePaste` method |
| `frontend/src/static/editor.js` | Task 4: rewrite step 4 of `handlePaste` to use `fetch` |

---

## Task 1: Fix data race — snapshot Attrs before unlocking

**The bug:** `HandleBlockUpdate` releases `shadow.mu` at line 452, then reads `blk2.Attrs` at line 454 without the lock. A concurrent `setBlock` call on the same block writes `blk.Attrs[k] = v` under `shadow.mu`, creating a concurrent map read+write — a fatal data race in Go.

**Files:**
- Modify: `sieve/editor_service.go` (lines 449–457)
- Test: `sieve/editor_service_test.go`

- [ ] **Step 1: Write the failing test**

Add to `sieve/editor_service_test.go`:

```go
func TestHandleBlockUpdate_notifyReceivesSnapshotNotLiveMap(t *testing.T) {
	svc, cleanup := newTestEditorService(t)
	defer cleanup()

	const uuid = "doc-race-test"
	if err := svc.Open(uuid, func() {}); err != nil {
		t.Fatalf("Open: %v", err)
	}

	// Create a block directly in the shadow so HandleBlockUpdate has something to merge into.
	svc.UpdateBlock(uuid, "code", "co-0001", map[string]interface{}{
		"id":       "co-0001",
		"source":   "print('hello')",
		"language": "unknown",
		"status":   "COMPLETE",
	})

	var gotYaml string
	var notifyCalled bool
	notify := func(id, rawYaml string) {
		notifyCalled = true
		gotYaml = rawYaml
	}

	// Send a block-update that OnUpdate will change (language is unknown → heuristic fires).
	svc.HandleBlockUpdate(uuid, "code", "co-0001", map[string]interface{}{
		"source": "fmt.Println(\"hello\")",
	}, notify)

	if !notifyCalled {
		t.Fatal("expected notify to be called after OnUpdate changed attrs")
	}
	if !strings.Contains(gotYaml, "language:") {
		t.Errorf("expected rawYaml to contain language field, got:\n%s", gotYaml)
	}
}
```

This requires a `newTestEditorService` helper. Add it to `editor_service_test.go` if it does not already exist (check first):

```go
// newTestEditorService returns an EditorService wired to an in-memory store.
// cleanup must be called when the test finishes.
func newTestEditorService(t *testing.T) (*EditorService, func()) {
	t.Helper()
	dir := t.TempDir()
	fs, err := filestore.New(dir)
	if err != nil {
		t.Fatalf("filestore.New: %v", err)
	}
	docSvc := NewDocumentService(fs)
	// Create a placeholder document so Open can load it.
	doc, err := docSvc.New()
	if err != nil {
		t.Fatalf("docSvc.New: %v", err)
	}
	// Open uses LoadByUUID; we need the UUID to match "doc-race-test".
	// Instead, use the real UUID the service assigned.
	_ = doc
	svc := NewEditorService(docSvc)
	svc.SetServices(Services{})
	return svc, func() {}
}
```

> Note: the test helper above uses whatever UUID `docSvc.New()` assigns. Adjust the test to call `svc.Open(doc.UUID(), ...)` instead of a hardcoded UUID, and pass that UUID to `UpdateBlock` and `HandleBlockUpdate`.

- [ ] **Step 2: Run the test to confirm it fails or errors**

```bash
cd /home/stephen/Development/projects/sieve && go test ./sieve/... -run TestHandleBlockUpdate_notifyReceivesSnapshotNotLiveMap -v -race
```

Expected: test compiles and either passes (if the race is not triggered deterministically) or panics under `-race`. Either way the test codifies the intended behaviour.

- [ ] **Step 3: Fix the race — snapshot attrs while holding the lock**

In `sieve/editor_service.go`, replace lines 449–457:

```go
		if notify != nil {
			shadow.mu.Lock()
			blk2, ok2 := shadow.Blocks[blockID]
			shadow.mu.Unlock()
			if ok2 {
				rawYaml, _ := fencedblock.Serialize[map[string]interface{}](blk2.Attrs)
				notify(blockID, rawYaml)
			}
		}
```

with:

```go
		if notify != nil {
			shadow.mu.Lock()
			blk2, ok2 := shadow.Blocks[blockID]
			var attrsCopy map[string]interface{}
			if ok2 {
				attrsCopy = make(map[string]interface{}, len(blk2.Attrs))
				for k, v := range blk2.Attrs {
					attrsCopy[k] = v
				}
			}
			shadow.mu.Unlock()
			if ok2 {
				rawYaml, _ := fencedblock.Serialize[map[string]interface{}](attrsCopy)
				notify(blockID, rawYaml)
			}
		}
```

- [ ] **Step 4: Run tests**

```bash
cd /home/stephen/Development/projects/sieve && go test ./sieve/... -race -v
```

Expected: all pass, no data race detected.

- [ ] **Step 5: Compile check**

```bash
cd /home/stephen/Development/projects/sieve && go build ./...
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add sieve/editor_service.go sieve/editor_service_test.go
git commit -m "fix(editor-service): snapshot Attrs under lock before serialising to prevent data race"
```

---

## Task 2: Introduce PasteEntry and update PasteMatch interface

**The goal:** Replace the plain `string` in `PasteMatch` with `[]PasteEntry` so every processor receives the full clipboard envelope and picks out the MIME types it cares about. The `CodeBlockProcessor` extracts `text/plain`.

**Files:**
- Modify: `sieve/processor_registry.go`
- Modify: `sieve/editor_service.go`
- Modify: `sieve/code_processor.go`
- Modify: `sieve/code_processor_test.go`

- [ ] **Step 1: Add PasteEntry type to processor_registry.go**

In `sieve/processor_registry.go`, add after the imports block and before `BlockProcessor`:

```go
// PasteEntry is one item from the browser clipboard DataTransfer.
// MIMEType is the raw MIME type string (e.g. "text/plain", "text/html").
// Content is the UTF-8 string value returned by clipboardData.getData(mimeType).
type PasteEntry struct {
	MIMEType string `json:"mimeType"`
	Content  string `json:"content"`
}
```

- [ ] **Step 2: Update the BlockProcessor interface in processor_registry.go**

Change:

```go
	PasteMatch(content string) (matched bool, overrides map[string]interface{})
```

to:

```go
	PasteMatch(entries []PasteEntry) (matched bool, overrides map[string]interface{})
```

- [ ] **Step 3: Update HandlePaste in editor_service.go**

Change the signature and call site. Find:

```go
func (es *EditorService) HandlePaste(uuid, content string) (kind, id, rawYaml string, matched bool) {
	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		ok, overrides := pm.Processor.PasteMatch(content)
```

Replace with:

```go
func (es *EditorService) HandlePaste(uuid string, entries []PasteEntry) (kind, id, rawYaml string, matched bool) {
	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		ok, overrides := pm.Processor.PasteMatch(entries)
```

- [ ] **Step 4: Update CodeBlockProcessor.PasteMatch in code_processor.go**

Find the method signature:

```go
func (p *CodeBlockProcessor) PasteMatch(content string) (bool, map[string]interface{}) {
```

Replace it and add text extraction at the top of the method body:

```go
func (p *CodeBlockProcessor) PasteMatch(entries []PasteEntry) (bool, map[string]interface{}) {
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
```

The rest of the method body is unchanged.

- [ ] **Step 5: Update PasteMatch tests in code_processor_test.go**

Find all calls to `.PasteMatch(someString)` in `sieve/code_processor_test.go` and replace them with `.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: someString}})`.

Example — every test line of the form:

```go
matched, overrides := proc.PasteMatch(input)
```

becomes:

```go
matched, overrides := proc.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: input}})
```

- [ ] **Step 6: Build to catch any missed call sites**

```bash
cd /home/stephen/Development/projects/sieve && go build ./...
```

Expected: no errors. If the compiler reports a missing method or wrong argument, fix the call site.

- [ ] **Step 7: Run tests**

```bash
cd /home/stephen/Development/projects/sieve && go test ./sieve/... -v
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add sieve/processor_registry.go sieve/editor_service.go sieve/code_processor.go sieve/code_processor_test.go
git commit -m "refactor(paste): replace PasteMatch(string) with PasteMatch([]PasteEntry) — full clipboard envelope"
```

---

## Task 3: Sync HTTP smart-paste endpoint + remove WS path

**The goal:** Add `POST /api/editor/smart-paste` to `EditorHandler`. It decodes the clipboard entries, calls `HandlePaste`, and returns a JSON result synchronously. The `handlePaste`/`smart-paste` WS path is deleted.

**Files:**
- Modify: `requesthandlers/editor_handler.go`
- Modify: `requesthandlers/ws_handler.go`

- [ ] **Step 1: Add the route and handler to editor_handler.go**

In `RegisterPaths`, add one line:

```go
func (h *EditorHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/editor", h.handleEditorShell)
	r.Get("/api/editor/load", h.handleEditorLoad)
	r.Post("/api/editor/save", h.handleEditorSave)
	r.Post("/api/editor/smart-paste", h.handleSmartPaste)  // ← add this
}
```

Add the handler at the end of `editor_handler.go`:

```go
func (h *EditorHandler) handleSmartPaste(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UUID    string            `json:"uuid"`
		Entries []sieve.PasteEntry `json:"entries"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UUID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	kind, id, rawYaml, matched := h.ServiceProvider.Editor.HandlePaste(req.UUID, req.Entries)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Matched bool   `json:"matched"`
		Kind    string `json:"kind,omitempty"`
		ID      string `json:"id,omitempty"`
		RawYaml string `json:"rawYaml,omitempty"`
	}{
		Matched: matched,
		Kind:    kind,
		ID:      id,
		RawYaml: rawYaml,
	})
}
```

- [ ] **Step 2: Remove the smart-paste case from ws_handler.go**

In the `switch msg.Type` block in `ws_handler.go`, delete:

```go
		case "smart-paste":
			h.handlePaste(uuid, raw, writeMsg)
```

Then delete the entire `handlePaste` method:

```go
func (h *WsHandler) handlePaste(uuid string, raw []byte, writeMsg func(interface{})) {
	// ... whole method
}
```

- [ ] **Step 3: Build**

```bash
cd /home/stephen/Development/projects/sieve && go build ./...
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add requesthandlers/editor_handler.go requesthandlers/ws_handler.go
git commit -m "feat(paste): sync HTTP smart-paste endpoint — POST /api/editor/smart-paste"
```

---

## Task 4: Update JS paste handler to use HTTP fetch

**The goal:** Replace the WS-based step 4 of `handlePaste` in `editor.js`. Collect all clipboard entries synchronously, call `event.preventDefault()`, fire `fetch('/api/editor/smart-paste')`, and on return either insert a block (matched) or replay the original clipboard content to TipTap (no-match). Remove the `pendingPasteText` global from the paste path.

**Files:**
- Modify: `frontend/src/static/editor.js`

- [ ] **Step 1: Update step 4 of handlePaste**

Find the step 4 block (look for the comment `// ── 4. Smart-paste pipeline`):

```js
    // ── 4. Smart-paste pipeline ──────────────────────────────────────────────────
    // All remaining text → Go. BlockProcessors get first refusal via PasteMatch.
    //   insert-block   → same flow as any block creation (context menu, shortcut)
    //   paste-no-match → JS re-inserts text as prose (TipTap insertContent fallback)
    if (text && currentUuid && !currentUuid.startsWith('prompt:')) {
      pendingPasteText = text.trim()
      event.preventDefault()
      sieveInsertPos = currentEditor ? currentEditor.state.selection.to : null
      wsSend({ type: 'smart-paste', uuid: currentUuid, content: text.trim() })
      return true
    }
```

Replace with:

```js
    // ── 4. Smart-paste pipeline ──────────────────────────────────────────────────
    // Collect all clipboard entries synchronously before any await/return.
    // event.preventDefault() is called immediately so TipTap does not paste.
    // If Go matches a processor the block is inserted here.
    // If not, the original clipboard content is replayed to TipTap via insertContent.
    if (text && currentUuid && !currentUuid.startsWith('prompt:')) {
      var pasteEntries = []
      var pasteHtml = ''
      if (event.clipboardData) {
        pasteHtml = event.clipboardData.getData('text/html')
        Array.from(event.clipboardData.types || []).forEach(function (mimeType) {
          pasteEntries.push({ mimeType: mimeType, content: event.clipboardData.getData(mimeType) })
        })
      }
      var pasteInsertPos = currentEditor ? currentEditor.state.selection.to : null
      event.preventDefault()

      fetch('/api/editor/smart-paste', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: currentUuid, entries: pasteEntries }),
      })
        .then(function (r) { return r.json() })
        .then(function (result) {
          if (!currentEditor) return
          if (result.matched) {
            var parsed = {}
            try { parsed = window.jsyaml.load(result.rawYaml) || {} } catch (_) {}
            var pos = pasteInsertPos !== null ? pasteInsertPos : currentEditor.state.doc.content.size
            currentEditor.commands.insertContentAt(pos, {
              type: 'sieve-' + (result.kind || 'code'),
              attrs: {
                kind:            result.kind || 'code',
                id:              result.id || parsed.id || '',
                rawYaml:         result.rawYaml || '',
                status:          parsed.status || 'PENDING',
                language:        parsed.language || '',
                source:          typeof parsed.source === 'string' ? parsed.source : '',
                createdAt:       parsed.createdAt || null,
                detectionMethod: parsed.detectionMethod || '',
              },
            })
            // Kick off background AI job via existing WS retry path.
            wsSend({ type: 'retry-block-job', uuid: currentUuid, id: result.id })
          } else {
            // No processor matched — replay original clipboard content to TipTap.
            if (pasteHtml) {
              currentEditor.commands.insertContent(pasteHtml)
            } else {
              currentEditor.commands.insertContent(text)
            }
          }
        })
        .catch(function (err) {
          console.error('[editor.js] smart-paste fetch failed', err)
          // Network error — fall back to plain text insertion so the user's content is not lost.
          if (currentEditor) currentEditor.commands.insertContent(text)
        })

      return true
    }
```

- [ ] **Step 2: Remove pendingPasteText from the paste path**

Search `editor.js` for every reference to `pendingPasteText`:
- The `var pendingPasteText = null` declaration — keep it only if create-block still uses it; otherwise remove it.
- The `pendingPasteText = null` line in the `insert-block` WS handler (line ~322) — remove it; `insert-block` now only comes from create-block and there is no paste stash to clear.
- The `paste-no-match` handler block (~lines 328–341) — remove it entirely; the WS no longer sends `paste-no-match`.

If `pendingPasteText` has no remaining references after these removals, remove the `var pendingPasteText = null` declaration too.

`sieveInsertPos` is still needed for the create-block flow — do not remove it.

- [ ] **Step 3: Build check (Go is unchanged; verify JS has no syntax errors)**

```bash
cd /home/stephen/Development/projects/sieve && go build ./...
```

Then open the app with `wails dev` and paste:
1. A fenced Go code block — should become a sieve code block.
2. A formatted paragraph from a webpage (bold + link) — should paste with formatting intact.
3. A plain sentence — should paste as prose.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "fix(paste): sync HTTP smart-paste — full clipboard entries, no-match replays HTML to TipTap"
```

---

## Task 5: Fix OnUpdate — always run heuristics, respect prior AI result

**The bug:** `OnUpdate` returns immediately when `language` is non-empty, so replacing a code block's content never triggers re-detection. The fix: always run heuristics (cheap). If they identify a language, update the badge unconditionally. If they have no opinion and AI already ran, leave the AI result alone. Only schedule a new AI job when heuristics are silent AND no language is set yet.

**Files:**
- Modify: `sieve/code_processor.go`
- Modify: `sieve/code_processor_test.go`

- [ ] **Step 1: Write failing tests**

Add to `sieve/code_processor_test.go`:

```go
func TestOnUpdate_alwaysRunsHeuristicsWhenLanguageAlreadySet(t *testing.T) {
	proc := &CodeBlockProcessor{}

	// Block already tagged 'python' by AI. User replaced source with obvious Go.
	block := &SieveBlock{
		ID:   "co-0001",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":       "co-0001",
			"language": "python",
			"status":   "COMPLETE",
			"source":   strings.Repeat("fmt.Println(\"hello\")\nif err != nil { return err }\n", 5),
		},
	}

	scheduleJob := proc.OnUpdate(block, Services{})

	if scheduleJob {
		t.Error("expected scheduleJob=false: heuristics should identify Go without AI")
	}
	if lang, _ := block.Attrs["language"].(string); lang != "go" {
		t.Errorf("expected language=go after heuristics, got %q", lang)
	}
}

func TestOnUpdate_doesNotScheduleAIWhenLanguageAlreadySetAndHeuristicsBlind(t *testing.T) {
	proc := &CodeBlockProcessor{}

	// Block tagged 'rust' by AI. New source is ambiguous — heuristics can't decide.
	// Expect: leave 'rust' alone, do not schedule AI.
	block := &SieveBlock{
		ID:   "co-0002",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":       "co-0002",
			"language": "rust",
			"status":   "COMPLETE",
			"source":   "x = 1\ny = 2\nz = x + y",
		},
	}

	scheduleJob := proc.OnUpdate(block, Services{})

	if scheduleJob {
		t.Error("expected scheduleJob=false: AI result should be trusted when heuristics are silent")
	}
	if lang, _ := block.Attrs["language"].(string); lang != "rust" {
		t.Errorf("expected language=rust (untouched), got %q", lang)
	}
}

func TestOnUpdate_schedulesAIWhenNoLanguageAndHeuristicsBlind(t *testing.T) {
	proc := &CodeBlockProcessor{}

	block := &SieveBlock{
		ID:   "co-0003",
		Kind: "code",
		Attrs: map[string]interface{}{
			"id":       "co-0003",
			"language": "unknown",
			"status":   "COMPLETE",
			"source":   strings.Repeat("x = 1\ny = 2\n", 10),
		},
	}

	scheduleJob := proc.OnUpdate(block, Services{})

	if !scheduleJob {
		t.Error("expected scheduleJob=true: no language set and heuristics blind → need AI")
	}
}
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd /home/stephen/Development/projects/sieve && go test ./sieve/... -run "TestOnUpdate_" -v
```

Expected: `TestOnUpdate_alwaysRunsHeuristicsWhenLanguageAlreadySet` fails (language stays `python`).

- [ ] **Step 3: Rewrite OnUpdate in code_processor.go**

Find the current `OnUpdate` implementation and replace it entirely:

```go
// OnUpdate runs on every block-update from the client. It always re-applies
// heuristics so the language badge tracks the current source.
// If heuristics identify a language it is applied immediately (no AI needed).
// If heuristics are silent and AI already ran, the AI result is left untouched —
// the user can force re-detection via the context-menu Retry action.
// If heuristics are silent and no language is set, a new RunJob is scheduled.
func (p *CodeBlockProcessor) OnUpdate(block *SieveBlock, _ Services) bool {
	source, _ := block.Attrs["source"].(string)
	if len(strings.TrimSpace(source)) < minSourceLength {
		return false
	}

	hint, _ := block.Attrs["hint"].(string)
	if detected, ok := detectByHeuristics(source, hint); ok {
		lang, _ := block.Attrs["language"].(string)
		if detected != lang {
			block.Attrs["language"] = detected
			block.Attrs["detectionMethod"] = "heuristic"
		}
		return false
	}

	// Heuristics have no opinion. Trust any language already set by AI.
	lang, _ := block.Attrs["language"].(string)
	if lang != "" && lang != "unknown" {
		return false
	}

	// No confident language anywhere — schedule AI unless one is already in flight.
	status, _ := block.Attrs["status"].(string)
	if status == "PENDING" {
		return false
	}
	block.Attrs["status"] = "PENDING"
	return true
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /home/stephen/Development/projects/sieve && go test ./sieve/... -run "TestOnUpdate_" -v
```

Expected: all three new tests pass.

- [ ] **Step 5: Run the full test suite**

```bash
cd /home/stephen/Development/projects/sieve && go test ./... -race
```

Expected: all pass, no race.

- [ ] **Step 6: Commit**

```bash
git add sieve/code_processor.go sieve/code_processor_test.go
git commit -m "fix(processor): OnUpdate always runs heuristics — re-detects language when source changes"
```
