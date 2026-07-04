# Specification: Internalise URL (Web Clip)

## 1. Overview

The Internalise URL feature lets the user pull external web content — a Confluence architecture doc, a Medium article, an internal wiki page — into the current note as a `web-clip` block. The user picks a mode (Fetch or Summarise), Claude retrieves and processes the content using whatever MCP tools it has configured, and the result lands in the document ready to annotate, discuss, or use as AI context.

This is explicitly an AI operation. The user is making a request to Claude, not performing a copy-paste. Sieve never touches authentication — Claude's MCP configuration owns that transparently.

A `web-clip` block is a machine artefact block (see `docs/extension-architecture.md`). It is distinct from:
- `ai-block` — a Q&A reasoning artefact (user asked something, AI answered). The fetched content sits *upstream* of the Q&A chain, not inside it.
- `link-card` — a lightweight OGP preview. A web clip is the full content, not a reference.

---

## 2. Block Format

### Pending (inserted immediately on submission)

````markdown
```web-clip
id: abc123
source: https://confluence.example.com/display/ENG/Architecture+Overview
mode: summarise
status: PENDING
model: claude-sonnet-4-6
createdAt: 2026-05-02T10:00:00Z
```
````

### Complete

````markdown
```web-clip
id: abc123
source: https://confluence.example.com/display/ENG/Architecture+Overview
title: Architecture Overview
mode: summarise
status: COMPLETE
model: claude-sonnet-4-6
createdAt: 2026-05-02T10:00:00Z
completedAt: 2026-05-02T10:00:45Z
content: |
  The system is divided into three layers: ingestion, processing, and serving.

  ## Ingestion

  All data enters through a single gateway service that validates and
  enqueues incoming requests. The queue is Kafka-backed with a 7-day
  retention window.

  ## Processing

  Worker nodes consume from Kafka and apply a configurable transformation
  pipeline...
```
````

### Error

````markdown
```web-clip
id: abc123
source: https://confluence.example.com/display/ENG/Architecture+Overview
mode: fetch
status: ERROR
createdAt: 2026-05-02T10:00:00Z
error: Claude could not retrieve this page. Check that your Confluence MCP server is configured.
```
````

### Timeout

````markdown
```web-clip
id: abc123
source: https://confluence.example.com/display/ENG/Architecture+Overview
mode: fetch
status: TIMEOUT
model: claude-sonnet-4-6
createdAt: 2026-05-02T10:00:00Z
```
````

### Schema

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | UUID, unique per block |
| `source` | string | The URL that was internalised |
| `title` | string | Page title. Set on completion, absent while pending |
| `mode` | string | `fetch` \| `summarise` |
| `status` | string | `PENDING` \| `COMPLETE` \| `TIMEOUT` \| `ERROR` |
| `model` | string | Claude model used |
| `createdAt` | string | ISO 8601 — set when block is inserted |
| `completedAt` | string | ISO 8601 — set when content arrives |
| `content` | string | Fetched or summarised content as a markdown `\|` block scalar. Absent until complete |
| `error` | string | Human-readable error message. Present only on `ERROR` |

---

## 3. User Experience

### 3.1 Triggering

- **Shortcut**: `Ctrl+U`
- **Action**: Opens a modal with a URL input and two equal action buttons

```
┌─ Internalise URL ──────────────────────────┐
│                                             │
│  https://________________________           │
│                                             │
│         [ Fetch ]   [ Summarise ]           │
└─────────────────────────────────────────────┘
```

Both modes are first-class. Summarise is not a secondary option — architectural reviews, article digests, and knowledge-base triage are primary workflows.

### 3.2 Modes

| Mode | Intent | Claude instruction |
|------|--------|--------------------|
| **Fetch** | Full content, verbatim conversion | "Retrieve the content at this URL and return it as clean, well-structured markdown. Preserve headings, lists, tables, and code blocks." |
| **Summarise** | Concise digest | "Retrieve the content at this URL and return a concise markdown summary. Prioritise key decisions, architecture, and conclusions. Omit boilerplate." |

Claude uses whatever MCP tools it has configured to reach the URL — Atlassian MCP for Confluence, a web browsing MCP for public pages. The mode affects the prompt, not the code path. Sieve does not know or care which MCP server Claude uses.

### 3.3 Lifecycle

1. User submits URL and picks a mode
2. Modal closes
3. `web-clip` block inserted at cursor with `status: PENDING` — NodeView shows source domain and a spinner (see §3.6)
4. `RunCLI` called in background with the constructed prompt
5. On completion: backend runs image localisation pass (see §4.3), then broadcasts SSE
6. Frontend applies ProseMirror attribute transaction — `status: COMPLETE`, `title`, `content`, `completedAt` set
7. NodeView re-renders: "Fetched from confluence.example.com" or "Summarised from confluence.example.com" badge, content body rendered as markdown

### 3.4 Promote to Document

Right-click → **"Promote to Document"**:
1. Parse `content` field as markdown
2. Insert resulting nodes at the block's position
3. Remove the `web-clip` node

Content becomes first-class prose, indistinguishable from user-written text. This is the natural exit when the fetched content is worth keeping permanently rather than as a scratchpad reference.

### 3.5 NodeView States

The NodeView renders differently for each status. All states are determined from node attributes — no external state.

| Status | Visual |
|--------|--------|
| `PENDING` (active) | Spinner + "Fetching from confluence.example.com…" or "Summarising from medium.com…". Source domain extracted from `source` URL. No retry button. |
| `PENDING` (stale — on app load) | Spinner replaced by warning icon + "Fetch interrupted" or "Summarise interrupted". Retry button shown. Active PENDING is distinguished from stale by comparing `createdAt` against the CLI timeout threshold on mount. |
| `COMPLETE` | Mode badge ("Fetched" / "Summarised") + domain. Content rendered as markdown. Right-click menu: "Promote to Document", "Use as AI Context". |
| `TIMEOUT` | Warning icon + "Timed out". Retry button shown. |
| `ERROR` | Warning icon + error message from `error` field. Retry button shown. |

Active vs stale PENDING: on mount, if `createdAt` + `cliTimeout` < `now`, the block is stale and should show the retry affordance. If the app closed mid-fetch, the block was written to disk with `status: PENDING` and never updated — the stale check catches this on next open.

### 3.6 Use as AI Context

A `web-clip` block can anchor a chain of `ai-block` Q&A nodes. The fetched content becomes the source ref:

```
[web-clip: Architecture Overview — Fetched]
  └── [ai-block: "What are the risks in the ingestion layer?"]
  └── [ai-block: "How does this compare to our current approach?"]
```

The `ref` field on follow-up `ai-block` nodes points to the `web-clip` block id. `gatherChain` and chain highlighting work identically to `ai-block` chains.

### 3.7 Retry

**This is the first retry implementation in Sieve.** The fenced YAML format with explicit `source`, `mode`, `model`, and `status` fields is what makes retry possible — the block carries enough metadata to reconstruct the request without any user input. Retry does not exist for `ai-block` yet; `web-clip` is the proof-of-concept for the pattern.

**When retry is available:** any block where `status` is `ERROR`, `TIMEOUT`, or stale `PENDING` (detected on mount as described in §3.5).

**Retry flow:**

1. User clicks the retry button in the NodeView
2. Frontend resets block to `status: PENDING` via attribute transaction (clears `error` and `content` fields, updates `createdAt` to now)
3. Frontend calls `POST /api/internalize` with the existing block `id`, same `source` and `mode`
4. Backend reuses the provided `id` rather than generating a new one — the block is updated in place, not replaced
5. `RunCLI` runs again; completion and error paths are identical to the initial request

The block `id` is stable across retries. Any `ai-block` nodes already chained to this `web-clip` via `ref` continue to point at the same block — the chain is preserved.

---

## 4. Backend

### 4.1 Prompt Construction

```go
func buildWebClipPrompt(source, mode string) string {
    switch mode {
    case "fetch":
        return fmt.Sprintf(
            "Please retrieve the content at the following URL and return it as clean, "+
            "well-structured markdown. Preserve all meaningful content including headings, "+
            "lists, tables, and code blocks. URL: %s", source)
    case "summarise":
        return fmt.Sprintf(
            "Please retrieve the content at the following URL and return a concise markdown "+
            "summary. Prioritise key decisions, architecture, data structures, and conclusions. "+
            "Omit navigation, boilerplate, author bios, and related links. URL: %s", source)
    }
}
```

### 4.2 Execution

Reuses `RunCLI` exactly as AI blocks do. No new infrastructure required:

```go
func (a *App) InternaliseURL(uuid, id, source, mode string) {
    prompt := buildWebClipPrompt(source, mode)
    job := &Job{DocId: uuid, BlkId: id}

    go func() {
        result, err := a.services.CLI.RunCLI(prompt)
        if err != nil {
            // broadcast error update via SSE
            return
        }
        // broadcast complete update via SSE
    }()
}
```

SSE event: `ai:progress` with block `id` and updated attrs — same event the frontend already handles for `ai-block` completion. The frontend applies the update as a ProseMirror attribute transaction finding the node by `id`.

### 4.3 Image Localisation

Before broadcasting the SSE completion event, the backend runs an image localisation pass over the content markdown:

1. Scan `content` for remote image references: `![alt](https://...)` patterns
2. For each remote URL: attempt a Go HTTP GET
3. On success: save to `.assets/<uuid>.<ext>` relative to the document, rewrite the URL in `content` to the local path
4. On failure (auth-gated, 404, timeout): leave the remote URL unchanged — the image will load from the remote host if accessible, or show broken in an offline context

This pass runs **server-side, synchronously, before the SSE event fires**. The frontend always receives a `content` field with as many images localised as Go could reach. There is no second SSE event for image localisation.

**Scope:** Phase 1 localises public images reachable by a plain HTTP GET. Images behind authentication (Confluence attachments, private CDNs) remain as remote URLs. Full authenticated image localisation is a Phase 2 concern.

```go
func localiseImages(content, docDir string) string {
    // regex over content, for each remote img URL:
    //   fetch, write to docDir/.assets/, rewrite URL
    // return updated content string
}
```

The `.assets/` directory follows the same convention as the existing image handling in the document store.

### 4.4 Entry Point

`POST /api/internalize` — accepts `{ uuid, source, mode, id? }`:
1. If `id` is provided (retry): reuse it. Otherwise generate a new UUID.
2. Returns the PENDING block YAML immediately so the frontend can insert or update it
3. Kicks off `RunCLI` in background
4. On completion: runs image localisation pass (§4.3), then broadcasts SSE completion

---

## 5. Frontend

- **Extension file**: `frontend/src/static/web-clip-extension.js` — fenced YAML extension following `extension-architecture.md`
- **Gesture**: `Ctrl+U` in `editor.js` opens the modal
- **Modal**: `<dialog>` with URL input and two buttons
- **Insertion**: ProseMirror command inserts a `web-clip` node with `status: PENDING` directly — no string injection
- **Completion**: `ai:progress` SSE event → find node by `id` → attribute transaction. Identical handling to `ai-block` completion

---

## 6. MCP Dependency

This feature requires Claude to have MCP tools capable of reaching the target URL:

| Content type | Required MCP |
|---|---|
| Confluence | Atlassian MCP server |
| Jira, Linear, Notion | Respective MCP servers |
| Public web pages | Web browsing MCP (e.g. Puppeteer, Brave) |

If Claude cannot reach the URL with its configured tools, it returns a natural language error. Sieve writes this to the `error` field and sets `status: ERROR`. The NodeView surfaces it clearly.

This is not a Sieve problem to solve — it is the same model as everything else in the app. The user's MCP configuration is the capability layer. Sieve does not own credentials or fetch paths.

---

## 7. Phase 2 — Go Fast Path

For public, static pages that Claude charges tokens to retrieve, a Go-native fast path is a worthwhile optimisation:

1. `POST /api/internalize` tries `go-readability` (`codeberg.org/readeck/go-readability/v2`) against the URL
2. Content quality check — if extracted text is substantive, proceed with Go
3. Pass cleaned text to Claude for Summarise mode (prompt only, no fetch required)
4. For Fetch mode with good Go extraction: html-to-markdown, no Claude needed at all
5. If Go returns thin content (SPA, 401, empty body) — fall back to full RunCLI path

The `web-clip` block schema is unchanged. A `fetchedBy: go` field can optionally record which path was taken, but this is an internal detail and not surfaced in the UI.

The image localisation pass (§4.3) applies on the Go path too — after Go extraction, before handing off to Claude or directly writing `content`. Auth-gated images (Confluence attachments) require an authenticated HTTP client in Phase 2.

Phase 2 is a cost and latency optimisation. Phase 1 is correct and complete without it.

---

## 8. Edge Cases

| Scenario | Handling |
|---|---|
| MCP server not configured for target URL | Claude returns error message → `status: ERROR`, `error` field set |
| CLI timeout during fetch | `status: TIMEOUT` written to disk. NodeView shows retry button on next render. |
| App closed while PENDING | Block remains on disk with `status: PENDING`. On next open, NodeView detects stale PENDING via `createdAt` age check and shows retry button. |
| Retry after ERROR/TIMEOUT | User clicks retry → `status` reset to `PENDING`, same `id` reused, `POST /api/internalize` called with existing `id`. Chain refs are preserved. |
| Fetch returns public images | Image localisation pass fetches and saves to `.assets/` before SSE fires. Broken or auth-gated images remain as remote URLs. |
| Fetch returns auth-gated images (e.g. Confluence attachments) | Remote URL preserved in Phase 1 — images visible only when authenticated. Full localisation is Phase 2. |
| Very large pages in Summarise mode | Claude's context window manages this — it will truncate or note the limitation in its response. |
| User submits same URL twice | Two separate `web-clip` blocks. No deduplication — the user may want both a Fetch and a Summarise of the same page. |
