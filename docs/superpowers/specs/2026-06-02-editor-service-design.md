# Design: Go-Heavy Editor Architecture — EditorService, Shadow Document, SieveBlock

**Date:** 2026-06-02
**Status:** Approved for planning
**Supersedes:** The "Block Save Semantics — Open Problem" section of `docs/architecture-block-model.md`

---

## The Problem Being Solved

Sieve's editor is split: TipTap (JS) owns the document state and serialises it; Go owns block YAML and writes it to disk. This dual ownership creates an unsolvable coordination problem for user-editable blocks.

The specific failure: `flushSave()` replays `rawYaml` verbatim. The moment a user edits a block's source, `rawYaml` is stale. A tab switch, debounce fire, or AI job start during editing silently discards the user's changes. This is not a race condition — it is the normal operation of the app.

Every attempted fix (JS YAML generation, debounced micro-saves, typed node array) either reintroduces the data-loss race, creates format asymmetry, or violates the proven rule that Go owns all YAML. The root cause is architectural: serialisation responsibility is split across two runtimes.

---

## The Animating Principle (Unchanged)

The user flows. The UI and AI enrich around them.

All architectural decisions serve this. The new architecture solves the save problem while making the "user flows" principle *more* true — not less.

---

## Core Decisions

### 1. Markdown on disk is a core principle

Markdown storage is non-negotiable. It keeps documents portable, human-readable, git-syncable, and walkable by AI agents. YAML fence blocks within markdown have high signal-to-noise ratio for both humans and AI. Even in a future Go HTTP + S3 architecture, the Sieve document format remains markdown with YAML fence blocks.

### 2. There is one block type: SieveBlock

There are no code blocks, AI blocks, web clip blocks as distinct Go types. There is one `SieveBlock`. The `tag` field is a key into two registries. Everything else is data.

```
tag
  → Go descriptor registry:  what the server does (job, prompt, paste match, serialise)
  → JS renderer registry:    how it looks (inline/block, modes, render function)
```

Adding a new content type means adding two registry entries. No new Go types. No new infrastructure.

### 3. Go is the document model. JS is the View.

Today: JS coordinates → Go executes.
After: Go coordinates and owns state → JS observes and renders.

The split that caused the save problem is resolved by collapsing document ownership entirely to Go. TipTap becomes a rich input surface and renderer. It does not own, serialise, or coordinate the document.

---

## The New Layer Separation

```
TipTap (View)
    ↕ WebSocket (bidirectional, one connection per open document)
EditorService  (sieve package)
    owns: ShadowDocument per open document (in-memory)
    owns: WebSocket connections
    owns: debounce timers
    owns: paste intelligence (via descriptor registry)
    owns: AI context assembly
    method: Flush(uuid)     → assembled markdown → DocumentService.Save()
    method: FlushAll()      → shutdown, flush all open shadows
    method: GetState(uuid)  → current shadow state (for AI context, jobs)
        ↓ Flush only
DocumentService  (sieve package — unchanged contract)
    LoadByUUID → always on-disk final version, no ambiguity
    Save       → writes to disk
        ↓
FileStore  (store/filestore — unchanged)
    versioning, history, categories, bytes to disk
```

**DocumentService is unchanged.** `LoadByUUID` always returns the committed on-disk version. Any caller — AI jobs, sidebar, search — gets the canonical state. No ambiguity about which version is returned.

**EditorService is new.** It is the Go-side representation of the editor. If a native Go terminal editor were built tomorrow, EditorService would be exactly what it needs. It is not a Wails or TipTap concept.

---

## ShadowDocument

The shadow is **in-memory only**. No shadow files. No micro-writes to disk.

Crash recovery is the same as today: lose whatever is in shadow since the last flush (≤1s debounce). This is universal behaviour across editors. The tradeoff is accepted.

On shutdown: `EditorService.FlushAll()` writes every open shadow to disk via DocumentService. One call, wired into Wails `OnBeforeClose`.

```go
type ShadowDocument struct {
    UUID     string
    Segments []ShadowSegment          // ordered document structure
    Blocks   map[string]*SieveBlock   // keyed by block ID
    mu       sync.Mutex
}

type ShadowSegment struct {
    Type    string  // "prose" | "block"
    Prose   string  // markdown text, when Type == "prose"
    BlockID string  // when Type == "block"
}

type SieveBlock struct {
    ID    string
    Tag   string                 // resolves via registries
    Attrs map[string]interface{} // all YAML fields — open map
}
```

### Assembly at flush time

EditorService iterates `Segments`. For prose segments: output markdown. For block segments: look up `SieveBlock` by ID, call `fencedblock.Serialize` on `Attrs`, wrap in fence. One assembly path, regardless of block tag.

---

## WebSocket Protocol

One persistent WebSocket connection per open document. Replaces the current `flushSave()` HTTP pattern and eventually consolidates with SSE.

### JS → Go

```json
{ "type": "prose-update", "uuid": "...", "markdown": "..." }
```
Fired by TipTap's `onUpdate` (debounced, ~200ms). Carries the full TipTap markdown. EditorService updates the shadow's prose segments and resets the debounce timer.

```json
{ "type": "block-update", "uuid": "...", "id": "...", "attrs": { "source": "..." } }
```
Fired by a block NodeView when the user edits block content. EditorService merges `attrs` into `shadow.Blocks[id].Attrs` and resets the debounce timer.

```json
{ "type": "paste", "uuid": "...", "content": "...", "cursorRef": "after:cb-a3f9" }
```
Fired on paste. EditorService runs the content against the Go descriptor registry paste matchers. Returns an insert instruction.

```json
{ "type": "flush", "uuid": "..." }
```
Fired by JS when an immediate write is needed (before AI job, tab switch, app close). EditorService writes shadow to disk synchronously, acknowledges.

### Go → JS (via WebSocket)

```json
{ "type": "insert-block", "id": "...", "fence": "...", "cursorRef": "..." }
```
Response to paste or job completion. JS inserts the fence into TipTap at the given position.

```json
{ "type": "block-attrs-updated", "id": "...", "rawYaml": "..." }
```
Sent when a job completes and block attrs change. JS performs a targeted `updateAttributes({ rawYaml })` on the TipTap node — no full soft reload needed for block updates.

```json
{ "type": "job-started", "jobId": "...", "label": "..." }
{ "type": "job-ended",   "jobId": "..." }
```
Drive the status bar and tab spinner. Consolidates what SSE does today.

---

## The Go Descriptor Registry

The descriptor registry is the authoritative definition of what a block type *does* on the server. Each entry is a pure data struct — no handler code, no routing logic.

```go
type BlockDescriptor struct {
    Tag        string

    // How a block of this type comes into existence from a user paste
    PasteMatch func(content string) (matched bool, attrs map[string]interface{})

    // What the server does when a job runs for this block
    Job *AICallDescriptor  // nil = no server job
}

type AICallDescriptor struct {
    Prompt       string  // key into PromptService
    BuildContext func(block SieveBlock, doc ShadowDocument) string
    Resolve      func(response string, block *SieveBlock) error
    Timeout      time.Duration
}
```

**The AI Call as data.** An AI operation is not a code path — it is a struct: prompt pointer, context builder, resolve function, timeout. The descriptor owns the specifics. One generic dispatcher runs all of them:

```go
func (es *EditorService) RunJob(uuid, blockID string) {
    block  := es.shadows[uuid].Blocks[blockID]
    desc   := descriptorRegistry[block.Tag]
    if desc.Job == nil { return }

    prompt := desc.Job.BuildContext(*block, *es.shadows[uuid])
    resp   := es.ai.Call(desc.Job.Prompt, prompt)
    desc.Job.Resolve(resp, block)
    es.Flush(uuid)
    // broadcast job-ended via WebSocket
}
```

**The block carries its own context.** The AI Ask block holds its question, ref chain, and conversation history in its own attrs. `BuildContext` assembles the full prompt from those attrs + the shadow document (to walk the chain and resolve refs). The AI service receives a complete, self-contained prompt. It has no knowledge of block types.

**`AiHandler`, `InternalizeHandler`, `CodeHandler` are retired** as distinct concepts. Their type-specific logic retreats into descriptor data. Adding a new AI-powered block type means writing a `BuildContext` and `Resolve` function and registering them. No new handler. No new endpoint. No new infrastructure.

### Example: ai-block descriptor

```go
descriptorRegistry["ai-block"] = BlockDescriptor{
    Tag: "ai-block",
    Job: &AICallDescriptor{
        Prompt:  "ai-ask",
        Timeout: 60 * time.Second,
        BuildContext: func(block SieveBlock, doc ShadowDocument) string {
            // block carries question, ref, chain history in attrs
            return assembleAiAskContext(block, doc)
        },
        Resolve: func(resp string, block *SieveBlock) error {
            block.Attrs["response"] = resp
            block.Attrs["status"]   = "COMPLETE"
            return nil
        },
    },
}
```

### Example: code-block descriptor (language detection)

```go
descriptorRegistry["code"] = BlockDescriptor{
    Tag: "code",
    PasteMatch: func(content string) (bool, map[string]interface{}) {
        // match bare fenced code block
    },
    Job: &AICallDescriptor{
        Prompt:  "detect-language",
        Timeout: 5 * time.Second,
        BuildContext: func(block SieveBlock, doc ShadowDocument) string {
            return block.Attrs["source"].(string)
        },
        Resolve: func(resp string, block *SieveBlock) error {
            block.Attrs["language"] = strings.TrimSpace(resp)
            block.Attrs["status"]   = "COMPLETE"
            return nil
        },
    },
}
```

---

## What Leaves JS

| Responsibility | Today | After |
|---|---|---|
| Document serialisation | `getMarkdown()` + `flushSave()` | Gone from JS |
| Save debounce timer | `saveTimer` in JS | Go debounce in EditorService |
| Pre-job flush coordination | `flushSave().then(...)` everywhere | EditorService.Flush() internal to dispatcher |
| Paste intelligence | Scattered across extension files, untested | `PasteMatch` in descriptor registry, fully testable |
| AI context assembly | `buildAiContext()` walks TipTap in JS | `BuildContext` in descriptor, runs against shadow |
| Job coordination | `flushSave().then(fetch(...))` | Generic dispatcher — no handler-specific code |
| Distinct AI handlers | `AiHandler`, `InternalizeHandler`, `CodeHandler` | Single `RunJob` dispatcher + descriptor data |

## What Stays in JS

| Responsibility | Notes |
|---|---|
| TipTap setup and extensions | Unchanged |
| NodeView rendering per tag | Via renderer registry — JS only concern |
| User interactions | Clicks, keyboard, context menus |
| WebSocket message handling | Receive instructions, apply to TipTap |
| Cursor / position management | TipTap owns cursor; Go references positions by block ID |

---

## Paste Intelligence in Go

The Go descriptor registry declares a paste matcher per tag:

```go
type BlockDescriptor struct {
    Tag        string
    PasteMatch func(content string) (matched bool, attrs map[string]interface{})
    Job        JobDescriptor
    // ...
}
```

EditorService runs pasted content through all registered matchers. First match wins. If no match: JS handles as plain text paste (unchanged behaviour). Fully unit-testable without a browser.

---

## `flushSave()` After

The JS `flushSave()` function survives — its call sites are unchanged — but its implementation becomes:

```js
function flushSave() {
    return ws.sendAndAwait({ type: 'flush', uuid: currentUuid })
}
```

No `getMarkdown()`. No serialisation. No `saveTimer`. A signal to Go; an acknowledgment back.

---

## rawYaml in TipTap

`rawYaml` remains in TipTap node attrs for rendering purposes (NodeViews use it for initial parse). It is no longer part of the persistence path. When a job completes, Go sends `block-attrs-updated` with the new `rawYaml`; JS does a targeted attr update — no full `softReloadContent` needed for block-level changes.

Full `softReloadContent` is retained only for whole-document changes (e.g., external file modification detected by the watcher).

---

## Shutdown

```go
// app.go
func (a *App) OnBeforeClose(ctx context.Context) bool {
    a.services.Editor.FlushAll()
    return false
}
```

One line. All open shadows written to disk.

---

## What This Does Not Change

- `DocumentService` contract — unchanged
- `FileStore` — unchanged  
- The two-registry pattern (JS renderer + Go descriptor) — clarified and extended
- Markdown on disk — preserved
- SSE for broadcast events (notes:changed, etc.) — retained; job events migrate to WebSocket over time
- Existing blocks (ai-block, web-clip) continue working during migration; they gain the shadow document benefits without code changes

---

## Implementation Sequence

This design is delivered in two implementation plans:

1. **Go-heavy frontend plan** — EditorService, ShadowDocument, WebSocket infrastructure, flushSave migration, paste intelligence
2. **SieveBlock plan** — Go descriptor registry, JS renderer registry, first block (code/mermaid), migration path from existing block extensions

The frontend plan is a prerequisite for the SieveBlock plan. Existing blocks continue to function throughout — no flag days.
