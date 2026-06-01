# Block Model Architecture

## The Animating Principle

The user flows. The UI and AI enrich around them.

Paste a URL — the title fetches, the card promotes. Paste a code fence — language is detected, a renderer activates. Ask a question — the response appears in place. Ask AI to draw something — a diagram emerges. None of this interrupts. The document gets smarter in the background while the user keeps writing.

Every architectural decision in this document serves that principle. rawYaml verbatim replay, soft reload, SSE enrichment, debounced saves, type migration — these are all mechanisms for the same thing: the system catches up to the user, never the other way around.

---

## The Central Insight

**There is one block type. There are two registries. Everything else is data.**

Every content type in Sieve — AI Ask, Web Clip, Rich Link, Code, Diagram, SmartLink — is the same structure: a fenced YAML block on disk, a fence tag that is the key into two registries, and a soft reload as the transition mechanism.

The fence tag resolves in two places:

**JS renderer registry** — declares how to display the block: inline or block, atom or editable, what modes exist, how to render.

**Go descriptor registry** — declares what the server does when a job runs for this block: which prompt to use, what placeholders to fill, how to resolve the result back to YAML.

```
fence tag
  → JS:  registry['code'] = { modes: ['CODE','RENDER'], render: CodeRenderer }
  → Go:  registry["code"] = BlockDescriptor{ Job: AICall{ Prompt: "detect-language", Resolve: resolveCode } }
```

**All server operations are data.** An AI call is not a code path — it is a struct: prompt pointer, placeholders, timeout, response type, resolve function. The core app dispatches it. The descriptor owns the specifics.

**One endpoint handles all jobs.** JS fires `POST /api/job { docUUID, jobId }`. Go reads the block type, looks up the descriptor, runs the operation. JS does not know what runs — it just knows a job started and will end.

**Adding a new content type is two registry entries.** No new handler. No new endpoint. No new extension file. Define the YAML schema, register the Go descriptor, register the JS renderer. The infrastructure does not change.

This is what business logic collapsing looks like. The type-specific code that currently lives in `AiHandler`, `WebClipHandler`, `InternalizeHandler` retreats into descriptor data. The handlers become a single generic dispatcher. The extensions become a single generic renderer loop.

The differences between an AI block, a web clip, a titled link, and a diagram are not architectural — they are differences in schema and descriptor.

---

## The Base Class

All intelligent blocks share these invariants without exception:

**Storage**
- Fenced YAML block on disk: ` ```block-type ``` `
- `id: PREFIX-XXXX` (4 hex chars)
- Go owns the YAML — JS never generates or mutates YAML fields
- JS serialiser replays `rawYaml` verbatim on save

**Lifecycle**
- `flushSave()` before any Go document write
- `JobTracker` + `ai:job-started` / `ai:job-ended` SSE events
- `isJobActive(id)` from `fenced-block-base.js` for stale detection
- `softReloadContent` on job completion — Go has already written the canonical YAML

**JS Infrastructure**
- `fenced-block-base.js` — shared utilities: `esc`, `renderMarkdown`, `applyHighlighting`, `isStaleByTime`, `isJobActive`
- Non-destructive parse: unknown or malformed YAML falls back to a raw code block
- Context menu via `sieve:contextmenu` event
- All are block-level TipTap atoms

---

## Renderer Capabilities

The renderer registration declares everything about a type. There is no fixed taxonomy — capabilities are open-ended. A renderer can declare whatever it needs:

```js
registry['my-type'] = {
  inline: false,        // block or inline — answers the TipTap schema question
  atom: true,           // editable content or sealed atom
  modes: ['VIEW', 'EDIT', 'ANIMATE'],   // user-togglable display modes, if any
  chains: true,         // participates in sequential ref chain
  job: 'llm',           // what the Go backend does: 'llm' | 'http' | 'detect' | null
  render: MyRenderer,
}
```

**The architecture imposes nothing beyond the base class.** If a future type needs `ANIMATE` mode, an `HTTP` call, an `EMBED`, or something not yet imagined — the renderer declares it. The infrastructure does not need to change.

### Capabilities observed in current types

These are observations about what exists today, not a closed list:

| Capability | Types that use it | Notes |
|------------|-------------------|-------|
| **LLM job** | AI Ask, AI Explain, Web Clip (fetch+summarise), Code (detect) | Uses `JobTracker` + SSE lifecycle |
| **HTTP job** | Rich Link Card | No LLM; same `JobTracker` + SSE pattern |
| **Chaining** | AI Ask, AI Explain | Ref chain — sequential context, semantically load-bearing. UI shows chain hints. Block N used Block N-1 as context. |
| **User-toggled modes** | Code (`CODE`/`RENDER`) | Mode is display preference; persisted on autosave; no Go roundtrip |
| **Inline shape** | SmartLink (`link`) | Sits inside prose; same lifecycle, different TipTap schema |
| **Type migration target** | `richlink`, `code` | Other types can promote into these via Go rewrite + soft reload |

**Chaining is worth naming explicitly** because it is the only capability that creates a *semantic dependency between block instances*. It is not just a UI hint — the chain IS the conversation. AI blocks are the universal interaction layer: open-ended input, open-ended output, anything can be asked and anything can be returned. The promoted artifact (diagram, code, card) is what comes *out* of that conversation.

---

## The Renderer Registry

The type tag is the renderer key. The JS extension maintains a registry where **each entry declares the full shape of the type** — not just the NodeView, but whether it is inline or block, atom or editable:

```js
const registry = {
  // Inline atoms
  'link': {
    inline: true,  atom: true,
    render: SmartLinkRenderer,    // → <a> with fetched title
  },
  'richlink': {
    inline: false, atom: true,
    render: RichLinkCardRenderer, // → block OG card
  },

  // Block artifacts
  'web-clip': {
    inline: false, atom: true,
    render: WebClipRenderer,
  },
  'code': {
    inline: false, atom: true,
    render: CodeRenderer,         // delegates to language sub-registry
  },

  // Block interactions
  'ai-block': {
    inline: false, atom: true,
    render: AiBlockRenderer,
  },
}
```

Unknown type → raw YAML/text display. Always graceful.

The registry entry answers all TipTap schema questions. `fenced-block-base.js` is the shared base class. Adding a new content type is:
1. Define the schema (YAML for blocks, attrs for inline)
2. Write a Go handler following the established pattern
3. Register a renderer entry with its shape declaration

### Code block language sub-registry

The `code` block type has a nested registry keyed on `language`:

```js
const codeRenderers = {
  mermaid:  { modes: ['CODE', 'RENDER'], render: MermaidRenderer },
  // plantuml: { modes: ['CODE', 'SERVER'], render: PlantUMLRenderer },
}
```

Unknown language → `CODE` mode only. Renderer capabilities are declared in the registration, not in the YAML schema.

---

## Type Migration

Because all content types share the same infrastructure, converting one type to another is a Go operation: read the existing data, write the new form with a different type tag and remapped fields, soft reload. The registry selects the correct renderer and shape automatically.

**Migration is purely a Go concern.** JS does not decide — it responds to what Go wrote. Soft reload activates the correct renderer and TipTap node shape.

### The link evolution chain

The SmartLink lifecycle is the clearest example of migration as a first-class operation:

```
bare URL paste
  → type: link, detect: pending    inline <a>, spinner while title fetches
  → type: link, detect: peek       inline <a>, fetched title as label        ← already ships
  → [user: Enrich as Card]
  → type: richlink                  block OG card with image, description
```

Each arrow is Go rewriting the on-disk representation and a soft reload. The editor replaces an inline atom with a block atom because the registry declared different shapes for `link` and `richlink`. JS never decides the shape — the registry does.

### The AI Ask → Diagram chain

```
AI Ask response contains mermaid source
  → type: ai-block                  response text in AI block
  → [user: Promote to Diagram]
  → type: code, language: mermaid   block diagram with CODE/RENDER toggle
```

Go remaps `response:` → `source:`, changes fence tag, writes to disk, soft reload. The mermaid renderer activates.

Type migration is a first-class operation, not a special case. Any type transition is a field remap + fence tag change in Go.

---

## Current vs Target State

| Type | Shape | Current state | Direction |
|------|-------|--------------|-----------|
| `link` (SmartLink) | inline atom | Ships — title fetch works | Already follows the model; `richlink` migration to add |
| `richlink` | block atom | Phase 1 shipped (title fetch); Phase 2 specced | Build Phase 2 as first renderer registration from day one |
| `ai-block` | block atom | Standalone extension | Renderer registration (long-term) |
| `web-clip` | block atom | Standalone extension | Renderer registration (long-term) |
| `code` | block atom | **To be built** — first generic block | Proves the registry pattern |
| Diagram (mermaid) | — | Specced — `spec-diagram-blocks.md` | Renderer within `code` block (Phase 4 of implementation plan) |

The existing blocks (`ai-block`, `web-clip`) are not being migrated now. They work. The `code` block is the proof of concept. If it ships cleanly, future blocks are renderer registrations by default, and the existing blocks migrate over time.

---

## Block Save Semantics — The Open Problem

### The Constraint

Every block in Sieve is embedded inline in the document as a fenced YAML block. The document is the thing — intelligence is part of it, not beside it. This is non-negotiable: a document opened in any text editor shows the full picture.

This creates a save problem specific to **user-editable blocks** — blocks where the user can directly modify content (e.g. a `code` block where the user edits `source`). The problem does not affect Go-owned blocks (AI Ask, Web Clip) because their content is only ever written by Go.

### The Conflict

Three principles are in tension. You can satisfy any two — not all three simultaneously:

| # | Principle |
|---|-----------|
| A | **The document is the thing** — intelligence inline, not in a parallel file |
| B | **The user flows** — no friction, no explicit saves, no commit gestures |
| C | **Go owns all YAML** — JS never generates or mutates YAML fields |

- **A + B, not C** → JS must send current user content as node attrs; Go generates YAML from them. Typed node array (Option 6).
- **A + C, not B** → Explicit commit required before flushSave() can safely replay rawYaml. Edit mode (Option 2).
- **B + C, not A** → Blocks stored separately, Go owns them entirely, prose saved independently. Margin file (Option 7 — rejected).

We are 90% there. The unresolved 10% is which pair of principles governs user-editable block content. All other block types (Go-owned: AI Ask, Web Clip, Rich Link) satisfy all three — they are never edited by the user directly, so rawYaml verbatim replay is always safe.

---

### Why rawYaml Verbatim Breaks for User-Editable Blocks

The current invariant: JS serialises by replaying `rawYaml` verbatim. `rawYaml` is the last Go-written state. The moment a user starts editing a block's source, `rawYaml` is stale.

`flushSave()` is called from many places — debounce timer, tab change, sidebar navigation, AI job start, AI job completion. With a 10-second debounce, a user editing a code block for 8 seconds who then changes tab loses all 8 seconds of edits. This is not a rare race condition — it is the normal operation of the app.

**Each block is a sub-document.** It has its own identity, lifecycle, and save semantics. The current approach treats blocks as opaque chunks of the document. The tension is that the document file is shared — prose and blocks live in the same file — and any independent save path must deal with that.

### The Options

These are listed without a chosen answer. The right choice depends on tradeoffs the design has not yet resolved.

---

#### Option 1 — rawYaml Verbatim + Go Mutex (current approach, minimal change)

Add a per-document write mutex in Go. `flushSave()` continues to send the full document with `rawYaml` verbatim replay. Go serialises all writes.

**Works for:** Go-owned blocks (AI, Web Clip). No race conditions.

**Breaks for:** User-editable blocks. Data loss window exists: user edits between `flushSave()` calls are lost. Tab change while editing = edits gone.

**Verdict:** Correct for the current block set. Not viable once user-editable blocks (code) exist.

---

#### Option 2 — Explicit Commit / Edit Mode

User-editable blocks have an explicit edit/apply cycle. User enters edit mode (double-click or Edit button), edits content, clicks Apply or presses a commit shortcut. Apply sends the content to Go before `flushSave()` can fire. Cancel discards.

**Works for:** Eliminates data loss. Go owns all YAML. No JS coordination. Discrete save event is clear.

**Breaks for:** "The user flows." Explicit commit introduces friction. This is the Confluence macro model — deliberate and structured, not scratchpad-first.

**Verdict:** Safe and clean. Wrong feel for Sieve. May be the right pragmatic starting point for code blocks while longer-term save architecture is resolved.

---

#### Option 3 — Debounced Block Micro-saves

The NodeView debounces as the user types. After a short pause, it sends `{ docUUID, id, source }` to Go. Go updates the YAML on disk and returns the updated fence. The NodeView updates `rawYaml` in TipTap attrs with Go's response. When `flushSave()` fires, `rawYaml` is current.

`flushSave()` must wait for any in-flight block saves to complete before serialising the document.

**Works for:** Feels like "just type." Go owns all YAML generation.

**Breaks for:** Two save paths that must coordinate. `flushSave()` gains awareness of pending block saves. Network round-trips on every keystroke pause. The coordination smell is real — `flushSave()` is already called from many places; adding a pre-flight block flush to each is fragile.

**Verdict:** Correct direction philosophically. Coordination burden is the problem.

---

#### Option 4 — Optimistic Locking with Block Versions

Each block carries `version: N` in its YAML. JS sends the current version with every update (document save and block events). Go arbitrates: for each block, the higher version wins.

```yaml
id: cb-a3f9
version: 4
language: mermaid
source: |
    graph TD
        A-->B
```

Document save: Go parses the incoming document and the disk document, compares versions per block, assembles the authoritative result.

**Works for:** JS becomes fire-and-forget. No coordination. `flushSave()` stays simple — just send what you have.

**Breaks for:** Go must implement a parse-merge-write on every save. Version field added to every block's YAML. The merge logic is non-trivial. Overkill for a single-user local app.

**Verdict:** Correct distributed-systems answer. Probably too heavy for Sieve's actual concurrency profile.

---

#### Option 5 — Event-Driven per Block/Node

Each change fires a typed event rather than a full document save. Prose changes fire `ProseChangedEvent`. Block content changes fire typed block events (`CodeBlockSourceEvent { id, source }`). Go applies events to the document in order, per-document channel ensuring serialisation.

```
JS → [ ProseChangedEvent ]    ──┐
JS → [ CodeBlockSourceEvent ] ──┼──→ Go event queue (per doc) → disk
JS → [ CodeBlockModeEvent ]   ──┘
```

**Works for:** Granular. Blocks and prose have separate concerns. No coordination in JS — just fire events. Go serialises via channel. "Just type" feel preserved.

**Breaks for:** Prose events are complex — paragraph splits, merges, reordering don't map cleanly to named events. Block events are clean (atoms with IDs). Prose events would require something closer to ProseMirror transactions. Significant Go infrastructure for event application.

**Verdict:** Right model for blocks. Unclear model for prose. Hybrid (events for blocks, snapshot for prose) may be the answer but adds complexity.

---

#### Option 6 — Typed Node Array (Go as Serialiser)

`flushSave()` sends a typed array representing the current document state. NodeViews keep live attrs (including `source`) in TipTap, updated as the user types. Go receives the array and generates all YAML — JS never touches YAML.

```json
[
  { "type": "prose", "markdown": "Some paragraph text.\n" },
  { "type": "code-block", "id": "cb-a3f9", "source": "graph TD\n    A-->B", "language": "mermaid", "mode": "CODE" },
  { "type": "ai-block", "id": "ab-1234", "rawYaml": "id: ab-1234\n..." }
]
```

Go-owned blocks pass `rawYaml` verbatim (Go still generates it). User-editable blocks pass live attrs. Go generates the canonical YAML and assembles the document file.

Single save path. Always current. `rawYaml` becomes optional — only needed for Go-owned blocks until they migrate to full attr representation.

**Works for:** Eliminates the data loss problem entirely. Single `flushSave()` path with no coordination. NodeView just keeps attrs current. The format is ours — we define it, it is stable.

**Breaks for:** Go must understand the node array format and implement YAML generation for each block type. Coupling between Go's file writer and the JS node schema. Significant refactor of the save path and `flushSave()` serialiser.

**Verdict:** Cleanest long-term answer. The `rawYaml` verbatim hack disappears. The most significant implementation investment.

---

#### Option 7 — Separate Block Store (Margin File) ✗ Rejected

Blocks stored in a parallel file (`doc._margin`), keyed by block ID. Prose document holds placeholders. Go assembles on read.

**Rejected because:** Breaks the core principle — the document must be complete and self-contained. Intelligence is part of the document, not beside it. A document opened outside Sieve shows placeholders, not content.

---

### Current Position

No option has been chosen for user-editable blocks. The code block implementation plan currently defers this decision — the first `code` block implementation will use **Option 2 (explicit commit)** as a safe starting point while the longer-term save architecture is resolved.

The likely long-term direction is **Option 6 (typed node array)** — it eliminates the `rawYaml` hack, has a single save path, and preserves "just type" without coordination. The implementation cost is real and is the reason it has not been chosen immediately.

---

### Open Question: Is Markdown Storage a Core Principle?

**This question resolves the entire save semantics debate.**

Every option above is complicated by the fact that blocks and prose live in the same text file. Parsing, merging, rawYaml verbatim replay, version arbitration — all of it exists because structured block data is embedded in an unstructured markdown format.

If storage were structured — SQLite, JSON, or any format with first-class block entities — the problem disappears entirely. Block saves and prose saves are independent operations on independent data. No parsing. No merging. No coordination. The two-registry architecture maps onto it cleanly.

Markdown storage gives you something real: documents are portable, human-readable, syncable via git or Dropbox, openable in any text editor. The intelligence travels with the file. That is a genuine product property worth defending.

But the long-term architecture direction is a Go HTTP server with an S3 store and web/mobile frontends. That future already surrenders "open in any editor." If that direction is real, the markdown insistence may be optimising for a property that does not survive to v2.

**The question to answer before committing to any save option:**

> Is markdown-on-disk a core product principle — something Sieve is defined by — or is it a current-phase convenience that the v2 architecture will move beyond?

If it is a principle: the save architecture must work within the markdown constraint. Option 6 (typed node array, Go as serialiser) is the ceiling.

If it is a convenience: a structured document store removes the problem entirely and the two-registry plugin architecture has no impedance mismatch with its storage layer.

---

## Relationship to Other Docs

- `docs/spec-code-blocks.md` — schema, Go handler, JS extension for the `code` block
- `docs/spec-diagram-blocks.md` — mermaid as a renderer within the `code` block
- `docs/how-to-intelligent-fenced-blocks.md` — implementation rules for all block types
- `docs/spec-rich-link-cards.md` — Rich Link Card spec (Phase 1 shipped; Phase 2 to be built as renderer registration)
