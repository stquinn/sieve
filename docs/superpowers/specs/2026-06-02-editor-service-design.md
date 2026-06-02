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
  → Go processor registry:  what the server does (job, prompt, paste match, serialise)
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
    owns: paste intelligence (via processor registry)
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
    Markdown string                  // full doc from TipTap — stale block rawYaml is acceptable
    Blocks   map[string]*SieveBlock  // authoritative block state, keyed by ID
    mu       sync.Mutex
    debounce *time.Timer
}

type SieveBlock struct {
    ID    string
    Tag   string                 // resolves via registries
    Attrs map[string]interface{} // all YAML fields — open map
}
```

No segment tree. No structural parsing. `Markdown` is a verbatim string from TipTap — prose is correct, block rawYaml may be stale. `Blocks` is always authoritative.

### Remux at flush time

EditorService takes `shadow.Markdown` and replaces each block's fence with a freshly serialised version from `shadow.Blocks`:

```go
func (s *ShadowDocument) Remux() string {
    out := s.Markdown
    for _, block := range s.Blocks {
        yaml, _ := fencedblock.Serialize(block.Attrs)
        out = replaceBlockFence(out, block.Tag, block.ID, yaml)
    }
    return out
}
```

`replaceBlockFence` scans for ` ```tag...id: X...``` ` and substitutes the YAML body. This is the same targeted fence-replace already used by `ResolveAiBlock` and `ResolveWebClip` — no new parsing infrastructure required.

**Timing invariant:** block-update debounce (~200ms) is shorter than the save debounce (1s). By the time the save fires, all pending block updates have settled in `shadow.Blocks`. The remux always has current block state.

---

## WebSocket Protocol

One persistent WebSocket connection per open document. Replaces the current `flushSave()` HTTP pattern and eventually consolidates with SSE.

### JS → Go

```json
{ "type": "doc-update", "uuid": "...", "markdown": "..." }
```
Fired by TipTap's `onUpdate` (debounced, ~200ms). Carries the full TipTap markdown — prose is current, block rawYaml may be stale for user-edited blocks. EditorService stores it as `shadow.Markdown` and resets the save debounce. No parsing required.

```json
{ "type": "block-update", "uuid": "...", "id": "...", "attrs": { "source": "..." } }
```
Fired by a block NodeView when the user edits block content. EditorService merges `attrs` into `shadow.Blocks[id].Attrs` and resets the debounce timer.

```json
{ "type": "paste", "uuid": "...", "content": "...", "cursorRef": "after:cb-a3f9" }
```
Fired on paste. EditorService runs the content against the Go processor registry paste matchers. Returns an insert instruction.

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

## The Go Processor Registry

The processor registry maps tag → `BlockProcessor`. The registry returns an interface — each block type provides its own implementation. No handler code, no routing logic lives here.

```go
// The interface the registry returns for every tag.
type BlockProcessor interface {
    // PasteMatch decides whether pasted content should become this block type.
    // Returns matched=true and the initial attrs if so.
    PasteMatch(content string) (matched bool, attrs map[string]interface{})

    // BuildContext assembles the full AI prompt from the block's own attrs
    // and the surrounding shadow document (for chain/ref resolution).
    BuildContext(block SieveBlock, doc ShadowDocument) string

    // RunJob executes the server-side job for this block: calls AI or HTTP,
    // then updates block attrs with the result.
    RunJob(ctx context.Context, block *SieveBlock, svc Services) error
}

var processorRegistry = map[string]BlockProcessor{}
```

**The AI Call as data.** The block carries its own context — question, ref chain, conversation history — in its attrs. `BuildContext` assembles the full prompt from those attrs + the shadow document (to walk the chain and resolve refs). The AI service receives a complete, self-contained prompt. It has no knowledge of block types. One generic dispatcher runs all processors:

```go
func (es *EditorService) RunJob(uuid, blockID string) {
    block     := es.shadows[uuid].Blocks[blockID]
    processor := processorRegistry[block.Tag]

    if err := processor.RunJob(ctx, block, es.services); err != nil {
        block.Attrs["status"] = "ERROR"
    }
    es.Flush(uuid)
    // broadcast job-ended via WebSocket
}
```

**`AiHandler`, `InternalizeHandler`, `CodeHandler` are retired** as distinct concepts. Their type-specific logic retreats into processor implementations. Adding a new AI-powered block type means implementing `BlockProcessor` and registering it. No new handler. No new endpoint. No new infrastructure.

### Example: ai-block processor

```go
processorRegistry["ai-block"] = &AiBlockProcessor{}

type AiBlockProcessor struct{}

func (p *AiBlockProcessor) PasteMatch(_ string) (bool, map[string]interface{}) {
    return false, nil  // ai-blocks are created by user action, not paste
}

func (p *AiBlockProcessor) BuildContext(block SieveBlock, doc ShadowDocument) string {
    return assembleAiAskContext(block, doc)  // walks ref chain in shadow
}

func (p *AiBlockProcessor) RunJob(ctx context.Context, block *SieveBlock, svc Services) error {
    prompt := p.BuildContext(*block, *svc.Editor.Shadow(block.ID))
    resp, err := svc.AI.Call(ctx, "ai-ask", prompt)
    if err != nil { return err }
    block.Attrs["response"] = resp
    block.Attrs["status"]   = "COMPLETE"
    return nil
}
```

### Example: code-block processor

```go
processorRegistry["code"] = &CodeBlockProcessor{}

func (p *CodeBlockProcessor) PasteMatch(content string) (bool, map[string]interface{}) {
    // match bare fenced code block — ` ```lang\n...\n``` `
}

func (p *CodeBlockProcessor) BuildContext(block SieveBlock, _ ShadowDocument) string {
    return block.Attrs["source"].(string)  // just the source for language detection
}

func (p *CodeBlockProcessor) RunJob(ctx context.Context, block *SieveBlock, svc Services) error {
    lang, err := svc.AI.Call(ctx, "detect-language", p.BuildContext(*block, ShadowDocument{}))
    if err != nil { return err }
    block.Attrs["language"] = strings.TrimSpace(lang)
    block.Attrs["status"]   = "COMPLETE"
    return nil
}
```

### Example: (legacy) ai-block — inline registration style

For simple processors, a struct-literal with method closures also works:

```go
// See Example: ai-block processor above.
```

---

## What Leaves JS

| Responsibility | Today | After |
|---|---|---|
| Document serialisation | `getMarkdown()` + `flushSave()` | Gone from JS |
| Save debounce timer | `saveTimer` in JS | Go debounce in EditorService |
| Pre-job flush coordination | `flushSave().then(...)` everywhere | EditorService.Flush() internal to dispatcher |
| Paste intelligence | Scattered across extension files, untested | `PasteMatch` in processor registry, fully testable |
| AI context assembly | `buildAiContext()` walks TipTap in JS | `BuildContext` on `BlockProcessor`, runs against shadow |
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

The Go processor registry declares a paste matcher per tag:

```go
type BlockProcessor struct {
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

## Planned Block Types

The SieveBlock model accommodates all current and future block types:

| Tag | Notes |
|-----|-------|
| `code` | First SieveBlock implementation. User-editable source, AI language detection, mermaid renderer. Clean cutover from `CodeBlockWithAttrs` — no backward compat needed; existing code fences degrade gracefully to standard markdown rendering. |
| `ai-block` | Migration from existing fenced YAML. Needs dual-format support during transition. |
| `web-clip` | Migration from existing fenced YAML. Needs dual-format support during transition. |
| `rich-image` | New. Replaces TipTap image-with-attrs extension. Binary stored in AssetService; fence carries metadata (src, description, dimensions, alt). AI description job on paste. |
| `titled-link` | New. Replaces HTTP-title link extension. Fence carries url, title, description. HTTP fetch + AI summary job on paste. |

Migration sequencing: `code` first (proves user-editable + rendering). Once SieveBlock is established, migrate `ai-block` and `web-clip` into the processor registry, then introduce `rich-image` and `titled-link` as new first-class blocks.

---

## Implementation Sequence

This design is delivered in two implementation plans:

1. **Go-heavy frontend plan** — EditorService, ShadowDocument, WebSocket infrastructure, flushSave migration, paste intelligence
2. **SieveBlock plan** — Go processor registry, JS renderer registry, `code` as first block, migration path for existing blocks, `rich-image` and `titled-link` as new blocks

The frontend plan is a prerequisite for the SieveBlock plan. Existing blocks continue to function throughout — no flag days.
