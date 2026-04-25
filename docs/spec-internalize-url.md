# Specification: Internalize URL (Smart Web Clipper)

## 1. Overview
The "Internalize URL" feature is a web clipper for the Stash editor. It supports three modes depending on the nature of the content and whether authentication is involved. All modes insert Markdown content directly into the document at the cursor, wrapped in an `AiBlock`. Stash itself never handles authentication — authenticated sources are accessed transparently via the Claude CLI's MCP server configuration.

---

## 2. User Experience

### 2.1 Triggering the Command
- **Shortcut**: `Ctrl + U` (Proposed).
- **Action**: Opens a centered modal titled "Internalize URL" with a text input for the destination URL and three action buttons.

### 2.2 Three Modes

| Mode | Button label | When to use |
|------|-------------|-------------|
| **Copy** | Copy | Public page — want the full content at high fidelity |
| **Summarise** | Summarise | Public page — want a concise, context-aware digest |
| **Fetch via AI** | Fetch via AI | Authenticated source (Confluence, Jira, internal tools) — AI retrieves it via MCP |

All three modes insert an `AiBlock` at the cursor. The block label reflects which mode ran ("Copy", "Summary", or "Fetch").

### 2.3 Feedback & State
- Upon submission, a new `AiBlock` is inserted at the cursor location.
- **Initial State**: The block displays the URL with a `(fetching...)` status badge.
- **Completion**: Badge updates to the mode label and the Markdown content appears immediately below the `[!ai-end]` marker.
- **Provenance**: The source URL and mode are stored as attributes on the `AiBlock` so the internalization can be traced back.

---

## 3. Backend Logic — Three Paths

### 3.1 Copy Mode (Go-native, no AI)
Go fetches and converts the page without involving the AI. Deterministic, fast, zero AI cost.

1. Go fetches the URL using the existing HTTP client (with proxy support and TLS config from `main.go`).
2. If the response is a redirect to a login page or returns 401/403, return an error block — do not silently fall back.
3. HTML is cleaned with `go-readability` (extracts main content, strips nav/ads/footers).
4. Cleaned HTML is converted to Markdown with an HTML→Markdown library.
5. Image localization pass runs (see §3.4).
6. Result inserted into the document.

**Libraries**: `go-shirou/readability` or `nicholasgasior/go-readability` for extraction; `JohannesKaufmann/html-to-markdown` for conversion.

### 3.2 Summarise Mode (Go fetch + AI)
Go fetches and cleans the page (same as Copy, steps 1–4), then passes the plain text to Claude for summarisation. AI is used where it adds value — judgment and distillation — not for mechanical conversion.

The summarisation prompt contains:
1. The cleaned page text.
2. Current document context (snapshot of the note being written).
3. Judgment instructions:
   - **Technical/Resource**: Prioritize code snippets, data tables, diagrams, APIs.
   - **News/Article**: Prioritize narrative; ignore stock images, author bios, related links.
   - Return a concise Markdown summary with no preamble or meta-commentary.

Image localization pass runs on any images the AI includes in its summary.

### 3.3 Fetch via AI Mode (Claude CLI + MCP)
The entire fetch and conversion is delegated to the Claude CLI. This is the path for authenticated enterprise content (Confluence, Jira, internal wikis) where Stash must not handle credentials.

- Stash calls `RunCLI` with a prompt containing the URL and the requested mode (copy or summarise).
- The CLI uses whatever MCP servers are configured in the user's Claude environment (e.g., an Atlassian MCP server) to retrieve the content — Stash has no visibility into this.
- The CLI returns Markdown; Stash inserts it as an `AiBlock`.
- Image localization pass runs if the result contains remote image links.

**Design principle**: Stash never stores, proxies, or sees authentication tokens. The user's MCP configuration is the auth layer. This keeps Stash deployable in enterprise environments without any credential management.

### 3.4 Image Localization Pass (all modes)
After content is obtained by any mode:
- Scan the Markdown for remote `http`/`https` image links.
- For each, call `DownloadImageAsset` to save the image to `store/assets/`.
- Rewrite the Markdown link to the local relative path.
- This ensures the note is self-contained and permanent — images do not rot.

---

## 4. Technical Architecture

### 4.1 Backend (Go)
- **HTML fetch + clean**: `stash/fetch.go` — `FetchAndClean(url string) (text, html string, err error)`
- **Conversion**: thin wrapper around `html-to-markdown` library
- **Prompt templates**: `DefaultSummarisePrompt`, `DefaultFetchViaAIPrompt` in `stash/prompts.go`
- **Entry point**: `InternalizeURL(uuid, url, mode string)` method on `App`, callable from the Wails bridge (and later from the HTMX router as `POST /api/internalize`)
- **Tooling**: Reuses `RunCLI` (Fetch via AI mode) and `DownloadImageAsset` (localization pass)

### 4.2 Frontend (Editor island — post HTMX migration)
- **Gesture**: `Ctrl+U` keydown in `editor.js` opens the modal
- **Modal**: HTML `<dialog>` with URL input and three buttons
- **Integration**: Reuse `AiBlock` extension as the insertion anchor
- **Post-processing**: Scan result for remote image links, trigger localization before final DOM insertion

---

## 5. Edge Cases

| Scenario | Handling |
|----------|---------|
| Login redirect / 401 on Go fetch | Error block: "Could not fetch — page may require authentication. Try **Fetch via AI** if you have an MCP server configured." |
| Direct link to PDF or binary | Detect `Content-Type`; offer summary (via AI) or direct download link rather than conversion |
| Mermaid/code-heavy Confluence page | Copy mode preserves fenced blocks; Summarise mode should retain code snippets verbatim |
| AI returns remote image links | Localization pass downloads and rewrites them in all modes |
| MCP server not configured | Fetch via AI mode returns Claude's error message in the `AiBlock` — no special handling needed |
| Very large pages | Summarise mode truncates input to fit context window before sending to Claude |
