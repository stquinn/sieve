# Stash — Full Product Specification
*Version 1.0*

---

## Changelog

| Version | Summary |
|---|---|
| 0.1 | Initial concept — lightweight scratchpad with AI filing |
| 0.2 | Added buffer persistence to disk, vault structure |
| 0.3 | Added versioning, focus counter, session persistence, full decision matrix |
| 0.4 | Refined buffer lifecycle, folder intelligence, timeout popup, shortcuts, meta fields, app name Stash |
| 0.5 | Sidebar design, prompt management, session.json in vault root, defensive settings handling, OS file explorer integration |
| 0.6 | Per-host subdirectory structure, host-local buffers and settings, shared notes and assets, asset promotion on filing, block ID scope resolution |
| 0.7 | Core data safety principle, clarified discard paths, uncertainty always resolves to keep |
| 0.8 | user_intent field, per-tab view mode, search, rich tags as search index, revised shortcuts, onboarding, filed note re-evaluation model, ai_last_evaluated, debug meta panel, future enhancements appendix |
| 0.9 | Close all buffers/tabs, CLI strategy pattern, CLI args and multi-file handling, autosave debounce, user_intent keep AI naming clarification |
| 1.0 | Design aesthetic defined — Sublime Text, right panel as meta display v1, margin paradigm as v2, tech stack decided — Wails + Go + Tiptap + TypeScript + React + shadcn/ui |

---

## Vision

A lightweight, portable, cross-platform scratchpad application that solves the gap between a code editor and a notes app. At its simplest it is a zero-friction WYSIWYG markdown editor with intelligent paste detection. At its most powerful it is a persistent AI conversation surface that inherits the full capability of whatever CLI toolchain the user has configured.

The app has three tiers of capability determined entirely by configuration. Moving between tiers requires no reinstall, no migration, no data changes — just editing settings.json.

---

## Tiers

**Tier 1 — Dumb Mode**
No CLI configured. A genuinely useful, fully portable WYSIWYG markdown editor with local folder storage and heuristic paste intelligence. Solves the core scratchpad problem with zero external dependencies. Tab close discards silently — the user accepts this tradeoff by running without intelligence.

**Tier 2 — Smart Mode**
CLI configured. Adds background language refinement, filing intelligence, explain gesture, ask gesture, and AI folder suggestions. The scratchpad becomes a productivity tool. Full data safety guarantee applies.

**Tier 3 — Unbounded Mode**
CLI configured with MCP servers, agents, or global prompts. The ask gesture inherits whatever the CLI has access to — filesystem, Home Assistant, APIs, external tools. The app makes no assumptions and adds no constraints. This capability is entirely user configured outside the app.

---

## Core Data Safety Principle

> **Stash never discards content in Tier 2 or above without a conscious decision from either the AI or the user. When in doubt — keep. Uncertainty always resolves to the buffer remaining open and safe, never to data loss.**

The only acceptable discard paths are:
- An explicit AI `keep: false` decision following successful evaluation
- An explicit user Delete action in the timeout popup
- A buffer marked `user_intent: trash` closed by the user explicitly

Everything else — timeout without user decision, CLI unreachable, ambiguous response — resolves to the buffer staying open. Stash never takes the path of least resistance and discards.

In Tier 1 dumb mode this guarantee does not apply — tab close discards silently and the user understands this tradeoff.

**Discard decision matrix:**

| Situation | Dumb Mode | Smart Mode |
|---|---|---|
| Tab close — `user_intent: trash` | Silent discard | Silent discard — no AI evaluation |
| Tab close — `user_intent: keep` | N/A | Silent file — AI names, tags, summarises |
| Tab close — AI says discard | N/A | Discarded — AI conscious decision |
| Tab close — AI says keep | N/A | Filed — AI conscious decision |
| Tab close — AI timeout, user hits Delete | N/A | Discarded — user explicit decision |
| Tab close — AI timeout, user hits Cancel | N/A | Buffer stays open — no decision, no loss |
| Tab close — AI timeout, user hits Accept | N/A | Filed with user provided name |
| Tab close — CLI not reachable | N/A | Timeout popup — falls back to human |
| Tab close — unparseable AI response | N/A | Timeout popup — falls back to human |
| App close | Buffers safe in buffers/ | Buffers safe in buffers/ |
| Crash | Buffers safe in buffers/ | Buffers safe in buffers/ |

---

## Architecture

**Stack**
- **Wails** — Go backend, webview frontend, native app feel, Mac and Linux
- **CodeMirror 6** — editor surface, WYSIWYG markdown, syntax highlighting, image rendering
- **CLI delegation** — Claude / Gemini / Copilot CLI for all intelligence, no embedded API keys, no network dependency in the app itself
- **Vault** — a local folder with a shared notes area and per-host subdirectories for settings, session, buffers, and prompts. Sync is the user's responsibility and out of scope.

**Portability**
- Single binary, no daemon, no server, no installer
- Works on corporate laptop, air-gapped if necessary
- No API keys stored in the app
- Different vault per context — home vault points to Claude CLI, work vault points to Copilot CLI
- Per-host configuration travels with the vault but never conflicts with other hosts

---

## Vault Structure

```
vault/
├── notes/                              # shared across all devices
│   ├── kubernetes/
│   │   └── k8s-ingress-fix.md
│   ├── home-assistant/
│   │   └── lawn-mowing-automation.md
│   └── random-thought.md               # root — Unclassified in sidebar
│
├── assets/                             # shared — filed note assets only
│   └── k8s-ingress-fix-blk-a3f9.png   # prefixed with note filename
│
├── {hostname-work-laptop}/             # host-local
│   ├── settings.json                   # copilot CLI
│   ├── session.json
│   ├── prompts/
│   │   └── file.md                     # materialises on edit
│   └── buffers/
│       ├── buf-20260411-1023.md
│       └── assets/
│           └── blk-a3f9.png
│
└── {hostname-home-desktop}/            # host-local
    ├── settings.json                   # claude CLI
    ├── session.json
    ├── prompts/
    └── buffers/
        ├── buf-20260411-1045.md
        └── assets/
            └── blk-b2c1.png
```

**notes/** — shared canonical knowledge base. All devices see the same filed notes. Only named filed content lives here. Edited in place once filed.

**assets/** — shared filed note assets. Prefixed with source note filename — no block ID clashes possible. Only promoted here on filing.

**{hostname}/** — everything host-local. Settings, session, prompts, buffers, and buffer assets. Never conflicts with other hosts. Created automatically on first launch on a new machine.

**{hostname}/buffers/** — every unsaved scratch tab continuously written here. Only unfiled content. Deleted on discard, promoted to notes/ on filing.

**{hostname}/buffers/assets/** — images pasted into buffers. Host-local, ephemeral. Promoted to vault/assets/ on filing with note filename prefix. Cleaned up on buffer discard.

---

## Startup Sequence

**CLI launch:**
1. Stash checks for a vault path argument — `stash /path/to/vault`
2. If no argument — uses PWD as vault path
3. If PWD is not a valid vault — folder picker shown
4. Determines current hostname
5. Looks for `vault/{hostname}/` — creates if missing
6. Reads `vault/{hostname}/settings.json` — falls back to defaults if missing or unparseable
7. Checks configured CLI is available on PATH — drops to Tier 1 silently if not
8. Restores session from `vault/{hostname}/session.json` — opens with empty tab if missing
9. Creates any missing subdirectories silently — buffers/, buffers/assets/, prompts/
10. Cleans up any orphaned `.tmp` files in buffers/ from a previous crash
11. Watches vault/notes/ and vault/{hostname}/ for filesystem changes

**First launch / new vault:**
- If vault path contains no notes/, no settings.json — treat as new vault
- Create directory structure silently
- Open with single empty tab
- If Tier 2+ — show subtle welcome note explaining CLI is configured and Stash is ready

---

## Defensive Handling

Stash never crashes or shows an unrecoverable error due to vault configuration issues. The core data safety principle governs all discard decisions. All other failures fall back gracefully.

**The guiding rules:**
- Create what is missing
- Ignore what is corrupt
- Fall back to defaults when in doubt
- In Smart Mode — when in doubt about a discard decision, always keep

| Situation | Behaviour |
|---|---|
| `settings.json` missing | Use all defaults, create on first change |
| `settings.json` unparseable | Use all defaults, log to debug panel |
| `cli` not found on PATH | Silently drop to Tier 1 dumb mode |
| Prompt listed in settings but file missing | Use baked-in default silently |
| Prompt file listed but unparseable | Use baked-in default silently |
| `session.json` missing | Open with empty tab |
| `session.json` references missing file | Skip that tab silently, restore the rest |
| `buffers/` folder missing | Create silently |
| `buffers/assets/` folder missing | Create silently |
| `notes/` folder missing | Create silently |
| `assets/` folder missing | Create silently |
| `prompts/` folder missing | Create silently if CLI configured |
| Block ID in AI response no longer exists | Append response at end of buffer |
| CLI not responding | Timeout after configured seconds, handle per context |
| CLI returns unparseable response | Treat as timeout — fall back to human decision |
| Any ambiguous discard situation in Smart Mode | Buffer stays open — never silently discard |
| Orphaned .tmp files on startup | Delete silently |
| Vault path does not exist and no PWD context | Folder picker shown — only interactive startup moment |

---

## Settings

**`vault/{hostname}/settings.json`**

```json
{
  "cli": "claude",
  "cli_timeout": 20,
  "autosave_debounce": 30,
  "debug": false,
  "prompts": {
    "file": "./prompts/file.md",
    "explain": "./prompts/explain.md",
    "ask": "./prompts/ask.md"
  }
}
```

**Rules:**
- All keys optional — sensible defaults for everything
- If `cli` absent or not found on PATH — Tier 1 dumb mode, silent
- `cli_timeout` defaults to 20 seconds
- `autosave_debounce` defaults to 30 seconds — configurable for user risk tolerance
- `debug: true` enables the debug meta panel
- Prompt paths relative to `vault/{hostname}/`
- Prompt entry added to settings.json automatically when user edits a default prompt
- Prompt entry removed from settings.json automatically when user restores to default
- User can hand-edit settings.json freely — Stash handles mismatches defensively
- Default prompts baked into binary — works with zero config

---

## Session State

**`vault/{hostname}/session.json`** — managed entirely by Stash. User can inspect but need not edit.

```json
{
  "tabs": [
    {
      "path": "buffers/buf-20260411-1023.md",
      "scroll": 245,
      "active": true,
      "mode": "wysiwyg"
    },
    {
      "path": "notes/kubernetes/k8s-ingress-fix.md",
      "scroll": 0,
      "active": false,
      "mode": "markdown"
    }
  ]
}
```

Paths relative to vault root. Written on every tab change, open, close, scroll, or mode toggle. Host-specific — each machine maintains its own open tabs, scroll positions, and view modes independently.

---

## Meta Block

Every buffer and note carries a YAML frontmatter meta block. Standard markdown frontmatter delimited by `---`. WYSIWYG never renders it. Raw markdown shows it. User can hand-edit at any time in Stash or any other editor.

**Unfiled buffer:**
```yaml
---
status: unfiled
version: 3
focus_count: 2
user_intent: null
ai_eval: none
ai_last_evaluated: null
ai_folder_suggestion: null
user_suggested_name: null
filename: null
summary: null
tags: []
created: 2026-04-11T10:23:00
modified: 2026-04-11T10:31:00
cli: null
---
```

**Filed note:**
```yaml
---
status: filed
version: 7
focus_count: 4
user_intent: null
ai_eval: complete
ai_last_evaluated: 2026-04-11T11:45:00
ai_folder_suggestion: kubernetes
user_suggested_name: null
filename: k8s-ingress-websocket-fix.md
summary: Ingress annotation fix for websocket timeout handling
tags: [kubernetes, networking, ingress, nginx, websocket, annotation, k8s, devops]
created: 2026-04-11T10:23:00
modified: 2026-04-11T11:45:00
cli: claude
---
```

**Meta field reference:**

| Field | Description |
|---|---|
| `status` | `unfiled` or `filed` |
| `version` | Increments on every debounced save or explicit save event |
| `focus_count` | Increments each time tab holds focus for more than 2 minutes |
| `user_intent` | `null`, `trash`, or `keep` — overrides AI keep/discard decision |
| `ai_eval` | `none`, `complete`, or `timeout` |
| `ai_last_evaluated` | Timestamp of last AI evaluation — set after any filing, explain, ask, or re-evaluation |
| `ai_folder_suggestion` | Latest AI folder suggestion — updated on re-evaluation, never acted on automatically after initial filing |
| `user_suggested_name` | Name typed in timeout popup — persists across retries and restarts |
| `filename` | Final filename after filing — never changed by AI after initial filing |
| `summary` | Latest AI generated summary — updated on re-evaluation |
| `tags` | Latest AI generated tags — updated on re-evaluation, used as search index |
| `created` | Buffer creation timestamp — never changes |
| `modified` | Last write timestamp |
| `cli` | Which CLI made the last filing decision |

---

## User Intent

The user can set an explicit intent on any buffer or note that overrides the AI keep/discard decision entirely.

**Values:**
- `null` — AI decides on close
- `trash` — always discard on close, no AI evaluation, no popup, no questions
- `keep` — always file on close, AI still runs fully for naming, tagging, summary, and folder suggestion

**Important:** `user_intent: keep` removes the AI keep/discard vote only. The AI still runs all other filing intelligence — naming, summary, tags, folder suggestion. The user has said "I know this is worth keeping" not "I know what it should be called."

**UI:**
Small control in toolbar or right click on tab:
- Mark as Trash
- Mark as Keep
- Clear (back to null)

**Tab dot colours:**
- **Amber dot** — unfiled, AI will decide on close
- **Green dot** — filed
- **Red dot** — marked as Trash, will be dumped on close
- **Blue dot** — marked as Keep, will be filed on close, AI names and tags
- **No dot** — empty buffer, nothing to evaluate

**Rules:**
- `user_intent` stored in meta — human readable and editable in raw markdown
- `user_intent: trash` on a filed note is valid — marks it for deletion on next explicit close
- AI never sets or overrides `user_intent` — this field belongs entirely to the user

---

## Autosave and Versioning

**Autosave debounce:**
- Write to disk 30 seconds after last keypress — increments version
- Write immediately on any planned close event — app close, tab close, Ctrl+S, Ctrl+Shift+Return
- Debounce interval configurable via `autosave_debounce` in settings.json
- On unplanned crash — up to one debounce interval of content may be lost. This is an accepted tradeoff.

**Version as importance signal:**
- Version increments only on debounced or explicit saves — not on every keypress
- Reflects meaningful editing sessions not individual keystrokes
- A focused 10 minute editing session produces version 3-4 not version 847
- Version never resets — cumulative history throughout the life of the buffer or note

**Combined importance signals passed to filing prompt:**

| Signal | Low value | High value |
|---|---|---|
| `version` | 1-2 — barely touched | 10+ — heavily curated |
| `focus_count` | 0-1 — glanced at | 4+ — repeatedly returned to |

---

## Buffer Lifecycle

A piece of content is always in exactly one place. No duplication, no sync between locations.

**State 1 — Unsaved scratch**
- Lives in `vault/{hostname}/buffers/`
- Named by creation timestamp — `buf-20260411-1023.md`
- Written to disk on debounce or explicit save event
- Version increments on each write
- Focus count increments each time tab holds focus for more than 2 minutes
- `status: unfiled`, `ai_eval: none`
- Stays open until explicitly closed by user or filed
- Restored on restart from session.json

**State 2 — Force saved by user (Ctrl+S or Ctrl+Shift+Return)**
- User explicitly saves regardless of AI opinion
- File moves immediately from buffers/ to vault/notes/ root with kebab fallback name
- Buffer assets promoted from buffers/assets/ to vault/assets/ with note filename prefix
- Markdown references in note updated to point at vault/assets/
- AI naming runs in background — suggests better filename, tags, summary, folder
- `ai_last_evaluated` written to meta on AI response
- Subtle notification with suggestion — accept or ignore, no pressure
- If accepted — file renamed and moved to suggested folder
- Tab remains open pointing at vault/notes/ file

**State 3 — AI filed on tab close**
- User closes an unfiled tab with `user_intent: null`
- AI evaluates with full meta context — one and done for keep/discard
- If `keep: true` — assets promoted, file moved to suggested folder, `ai_last_evaluated` written, subtle notification, tab closes
- If `keep: false` — buffer file deleted, buffer assets deleted, tab closes
- If ambiguous or unparseable — treated as timeout, popup shown, data never silently lost

**State 4 — User intent close**
- `user_intent: trash` — buffer deleted silently on close, no AI, no popup
- `user_intent: keep` — AI runs fully for naming/tagging/summary/folder, files silently, `ai_last_evaluated` written, tab closes

**State 5 — Opened from vault**
- User opens existing note via Ctrl+P or sidebar
- Tab points directly at vault/notes/ file
- Edits write directly to file in place
- No buffer copy created
- Tab, scroll position, and view mode remembered in session.json

**Re-evaluation of filed notes (Ctrl+Shift+E):**
- AI re-runs filing prompt silently
- Updates `summary`, `tags`, `ai_folder_suggestion`, `ai_last_evaluated` in meta
- Never touches filename or file location — permanently the user's domain after initial filing
- No notification, no popup — completely silent
- Passive metadata (`version`, `focus_count`, `modified`) continues accumulating regardless

**The rules:**
- `buffers/` contains only unfiled scratch — host-local, ephemeral
- `notes/` files edited in place once they exist — shared, permanent
- Block IDs only need to be unique within a single buffer
- AI folder suggestion updated in meta on re-evaluation but file never moved automatically
- Filename and file location permanent after initial filing — AI never changes them
- User moving a note after filing is canonical

---

## Asset Promotion

When a buffer is filed its assets are promoted from host-local to shared.

**Promotion flow:**
1. Buffer filed — destination note filename known
2. Stash scans note content for asset references in buffers/assets/
3. For each asset — copy to vault/assets/ prefixed with note filename
   - `buffers/assets/blk-a3f9.png` → `vault/assets/k8s-ingress-fix-blk-a3f9.png`
4. Update all markdown references in note to point at vault/assets/
5. Delete originals from buffers/assets/

**On buffer discard:**
- All assets in buffers/assets/ referenced by that buffer deleted silently

**Naming collision defence:**
- Note filename prefix makes vault/assets/ collisions practically impossible
- If collision occurs — append short random suffix

---

## Editor Surface

**General**
- Tabbed interface — multiple buffers and notes open simultaneously
- WYSIWYG markdown rendering — headers, bold, italic, links, images render inline
- Raw markdown always accessible per tab — Ctrl+Shift+M toggles current tab
- No system prompts ever except the AI timeout popup
- No are-you-sure prompts ever
- Save dialogs only when explicitly initiated by user action

**Per-tab view mode:**
- Each tab independently in WYSIWYG or raw markdown mode
- Mode persisted in session.json per tab
- Toggle with Ctrl+Shift+M
- Small `M` badge on tab header when in raw markdown mode

**Tab indicators:**
- **Amber dot** — unfiled, AI will decide on close
- **Green dot** — filed, living in notes/
- **Red dot** — marked as Trash, will be dumped on close
- **Blue dot** — marked as Keep, will be filed on close
- **No dot** — empty buffer, nothing to evaluate
- **M badge** — tab currently in raw markdown mode

---

## Close All Operations

Two distinct bulk close operations available via menu or keyboard shortcut.

**Close all buffers** — closes only unfiled scratch tabs, leaves open filed notes untouched.

**Close all tabs** — closes everything including open filed notes.

**In dumb mode:**
- All unfiled tabs discarded silently — user accepted this tradeoff
- No prompts, no AI, instant

**In Smart Mode:**
- All unfiled tabs evaluated in parallel — simultaneous AI calls, not sequential
- Non-modal progress indicator appears — "Evaluating N buffers..."
- As each decision returns — toast notification fires:
  - Keep: "Saved as `k8s-ingress-fix.md`"
  - Discard: silent, no notification
- If any individual buffer times out — that buffer's timeout popup fires as normal
- User can keep working during evaluation — non-blocking throughout
- `user_intent: trash` buffers close immediately without AI evaluation
- `user_intent: keep` buffers file immediately with AI naming running in background

---

## Sidebar

Displays filed notes and prompt management only. Buffers never appear — they exist only as tabs.

**Structure:**
```
📁 kubernetes
    k8s-ingress-fix.md
    k8s-cert-manager-setup.md
📁 home-assistant
    lawn-mowing-automation.md
📄 Unclassified
    random-thought.md
─────────────────────
📁 Prompts              ← only visible if CLI configured
    file.md
    explain.md
    ask.md
```

**Behaviour:**
- Collapsible folders
- Click note to open in new tab or focus existing tab
- Stash watches vault/notes/ for filesystem changes — sidebar updates automatically
- Assets not shown — use OS file explorer

**Right click menu on any item:**
- Show in Finder / Show in Files — opens OS file explorer at that location
- Standard file operations delegated to OS

**Prompt entries:**
- Always show all three prompts if CLI configured
- Default prompts shown as virtual entries — no file on disk
- Edited prompts shown as real file entries
- Each prompt entry has Edit button
- Overridden prompts additionally have Restore to Default button
- Restore to Default deletes file from prompts/ and removes entry from settings.json

---

## Search

**In-buffer search — Ctrl+F**
Standard find behaviour within the current tab. CodeMirror handles this natively.

**Vault-wide search — Ctrl+Shift+F**
Searches across all content in vault/notes/. Results panel opens in sidebar.

**Search sources:**
- Full text of all markdown files in notes/
- `tags` field in meta of all notes
- `summary` field in meta of all notes

**Result display:**
```
🔍 "websocket"

kubernetes/k8s-ingress-fix.md          [tag] [text]
home-assistant/lawn-mowing.md          [text]
go-http-middleware-pattern.md          [tag]
```

- `[tag]` — matched in AI generated tags — stronger semantic signal
- `[text]` — matched in note body
- `[summary]` — matched in AI generated summary

**Tags as semantic search index:**
The filing prompt instructs generous semantic tagging — related concepts, technologies, and topics, not just literal terms. Tags are generated at filing time and updated on re-evaluation. They are the search index — no additional token cost at search time.

**In dumb mode:**
- Ctrl+F works — CodeMirror native
- Ctrl+Shift+F — full text only, no tag or summary search

---

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| New tab | Ctrl+N |
| Close tab | Ctrl+W |
| Force save | Ctrl+S |
| File this now | Ctrl+Shift+Return |
| Quick switcher | Ctrl+P |
| Open vault file | Ctrl+O |
| In-buffer search | Ctrl+F |
| Vault search | Ctrl+Shift+F |
| Toggle sidebar | Ctrl+\ |
| Toggle raw markdown | Ctrl+Shift+M |
| Explain | Ctrl+E |
| Ask | Ctrl+Shift+A |
| Re-evaluate AI | Ctrl+Shift+E |
| Send in ask popup | Enter |
| New line in ask popup | Shift+Enter |

All gestures also available as buttons in the UI. No capability is keyboard-only. Shortcuts remappable in a future version.

---

## Block ID System

Every discrete content block assigned a unique ID at creation. The ID is the async contract allowing background CLI processes to locate and update the correct block after the fact. Block IDs only need to be unique within a single buffer — not globally.

**Text block format:**
```markdown
```yaml id="blk-a3f9" detect="heuristic"
apiVersion: v1
```
```

**Highlighted text actioned via explain or ask:**
When a text selection is actioned it is immediately wrapped in a block and assigned an ID before the CLI call fires.

```markdown
<span id="blk-x7k2">this was the highlighted text</span>
```

**Image block format — in buffer:**
```markdown
![blk-a3f9](../../buffers/assets/blk-a3f9.png){id="blk-a3f9" detect="pending"}
```

**Image block format — after filing:**
```markdown
![description](../../assets/k8s-ingress-fix-blk-a3f9.png){id="blk-a3f9" detect="cli"}
```

**Detection states:**
- `detect="heuristic"` — local pattern matching, instant, CLI refinement pending
- `detect="cli"` — CLI confirmed or corrected
- `detect="user"` — explicit user override, **never touched again under any circumstance**
- `detect="pending"` — image awaiting CLI description

**Rules:**
- IDs assigned at creation, never changed
- Present in dumb mode — zero cost, future compatible
- WYSIWYG hides ID and detect attributes
- AI response blocks carry `ref` pointing back to source block ID
- If referenced block no longer exists — response appended at end of buffer

---

## Paste Intelligence

Always instant, always local. CLI never in the critical path of a paste event.

**Four tier text detection:**
1. **High confidence** — Python, Shell, SQL, YAML, JSON, XML, Kubernetes manifests
2. **Best guess** — Java, JavaScript, Go, C, TypeScript snippets without file-level signals
3. **Uncertain but clearly code** — generic code block, no language tag
4. **Plain text** — flows as paragraph

**Text paste flow:**
1. Paste fires
2. Local heuristic runs synchronously — microseconds
3. Block ID assigned, language tier selected, fenced block inserted with `detect="heuristic"`
4. WYSIWYG renders immediately
5. Debounce timer reset
6. If Tier 2+ — background CLI call fires to refine language detection — configurable timeout

**Image paste flow:**
1. Image blob detected
2. Saved immediately to `{hostname}/buffers/assets/blk-{id}.png`
3. Markdown reference inserted with `detect="pending"`
4. WYSIWYG renders inline immediately
5. Debounce timer reset
6. If Tier 2+ — background CLI call fires to describe and suggest filename — configurable timeout

**Background CLI language refinement (Tier 2+ only):**
1. CLI called with block content via temp file
2. App looks up block by ID on response
3. If `detect="user"` — discard response entirely
4. If `detect="heuristic"` — silently update language tag, set `detect="cli"`, re-render
5. If timeout — keep heuristic result, move on silently

---

## CLI Strategy Pattern

Stash uses a strategy pattern for CLI integration. Each supported CLI has a concrete implementation encapsulating all CLI-specific invocation details — args, flags, file handling, multi-file passing, response parsing. The core app never deals with CLI specifics.

**The interface:**

```go
type AiCLI interface {
    File(content string, images []string, prompt string) (string, error)
    Explain(content string, images []string, prompt string) (string, error)
    Ask(content string, images []string, history string, question string) (string, error)
    DetectLanguage(content string) (string, error)
    DescribeImage(imagePath string) (string, error)
}
```

**Concrete implementations:**
- `ClaudeCLI` — handles claude CLI invocation specifics
- `GeminiCLI` — handles gemini CLI invocation specifics
- `CopilotCLI` — handles copilot CLI invocation specifics
- `CustomCLI` — template-based fallback for unsupported CLIs

**settings.json — simple:**
```json
{
  "cli": "claude"
}
```

Stash instantiates the correct strategy at startup based on this single string. Baked-in implementations for known CLIs — user just sets the name and it works.

**Custom CLI fallback:**
```json
{
  "cli": "custom",
  "cli_command": "mycli --prompt '{prompt}' {files}"
}
```

`CustomCLI` implements the interface using the template. Covers any CLI not natively supported without requiring a code change.

**Temp file handling:**
- Stash writes buffer content and images to temp files in `{hostname}/buffers/` before every CLI call
- Temp files named `{buffer-id}-content.md`, `{buffer-id}-{block-id}.png` with `.tmp` extension
- All temp files cleaned up immediately after CLI response
- Orphaned `.tmp` files cleaned up on startup

**Multi-file passing:**
Each CLI implementation handles its own multi-file convention — positional args, repeated flags, or stdin piping. The interface abstracts this entirely from the core app. The `images []string` parameter is a list of temp file paths passed to the implementation to handle as appropriate.

**Note:** Exact CLI flags and invocation patterns require verification against each CLI's current documentation before v1 ships. The strategy pattern means corrections are isolated to individual implementations.

---

## Filing Intelligence

**Triggered only by events that would cause data loss:**
- User closes an unfiled tab with `user_intent: null` — AI evaluates silently
- User closes an unfiled tab with `user_intent: keep` — AI names, tags, summarises, suggests folder
- User force saves with Ctrl+S or Ctrl+Shift+Return — AI names, tags, summarises, suggests folder

**Never triggered on:**
- App close — buffers safe in buffers/, restored next open
- Timer or debounce

**One and done on initial filing** — AI evaluates each buffer exactly once for keep/discard. `ai_eval: complete` and `ai_last_evaluated` written to meta.

**The AI decision matrix:**

| Scenario | Keep/Discard | Name, Tags, Summary, Folder |
|---|---|---|
| `user_intent: trash`, tab close | Always discard, no AI | N/A |
| `user_intent: keep`, tab close | Always file, no AI vote | AI runs fully |
| AI evaluates on close, keep | Auto-files silently | AI generates |
| AI evaluates on close, discard | Deleted silently | N/A |
| AI evaluates on close, ambiguous | Timeout popup | Human decides |
| User force saves Ctrl+S | Always saved, AI has no vote | AI suggests silently |
| AI timeout on close | Timeout popup | Human decides |
| Re-evaluation Ctrl+Shift+E on filed note | No keep/discard | AI updates meta silently |

---

## AI Timeout Popup

The only system-initiated popup in Stash. Appears only when a CLI is configured, the CLI timed out or returned an ambiguous response, and a human decision is needed to avoid data loss.

**Contents:**
- Brief message — "AI naming timed out"
- Text input pre-filled with — in priority order:
  1. `user_suggested_name` from meta if present
  2. Kebab from first plain text line, capped around 20 characters on space boundary
- Four buttons:

| Button | Behaviour |
|---|---|
| **Accept** | Save with name in input, promote assets, close buffer |
| **Retry** | Try CLI again, spinner, same timeout, popup returns on second timeout |
| **Delete** | Discard buffer and buffer assets — explicit human decision |
| **Cancel** | Abort close entirely, buffer stays open — data safe, decide later |

**On retry:**
- User-edited name in input persists — never reset
- `user_suggested_name` written to meta before retry fires
- If retry succeeds — AI names it, `ai_last_evaluated` written, popup closes, files normally
- If retry times out again — popup returns with input intact

**Data safety during popup:**
- Buffer file remains safely in buffers/ for entire duration
- No data at risk regardless of how long the user takes to decide

---

## Folder Intelligence

Notes filed into subfolders of vault/notes/. Folders created organically — none imposed at start.

**AI folder selection:**
- Filing prompt includes list of existing folders
- AI first tries to match existing folder
- Only proposes new folder if content is strongly directional and nothing existing fits
- High bar for new folder creation — default to existing or root
- Root level displayed as Unclassified in sidebar

**Folder rules:**
- `ai_folder_suggestion` updated in meta on re-evaluation — never acted on automatically after initial filing
- User moving note after filing is canonical — AI never moves a filed note
- Folders are plain subfolders in vault/notes/ — no magic, no database

---

## Explain Gesture (Ctrl+E)

Fire-and-forget. Asks CLI to explain selected content or whole buffer. Response appended inline.

**Scope:**
- No selection → whole buffer
- Text selected → selection wrapped in block with ID, then explained
- Code block selected → what does this code do
- Log content selected → what do these errors mean
- YAML selected → validate and explain
- Image selected → describe the image

**AI working state:**
- Placeholder callout block appears immediately at response location
- Spinner inside placeholder
- Replaced by actual response on completion
- `ai_last_evaluated` written to meta on response
- On timeout — placeholder replaced with subtle retry message

**Response format:**
```markdown
> [!ai] id="ai-r9x1" ref="blk-a3f9"
> This is a Kubernetes ingress manifest configuring websocket
> support via the nginx.ingress.kubernetes.io annotation...
```

Plain markdown. Keep it, delete it, ignore it. No special state.

**In dumb mode:** Unavailable. Button hidden, shortcut inactive.

---

## Ask Gesture (Ctrl+Shift+A)

Conversational. Opens a multi-line prompt popup, fires user question with content as context, appends response inline.

**Flow:**
1. Gesture on selection or buffer
2. If text selected — wrapped in block with ID before popup opens
3. Multi-line text input popup — not modal, not blocking
4. Enter to send, Shift+Enter for new line
5. Placeholder callout block appears immediately at response location
6. Spinner inside placeholder
7. CLI called with content plus question — configurable timeout
8. Placeholder replaced by response on completion
9. `ai_last_evaluated` written to meta on response
10. On timeout — placeholder replaced with subtle retry message

**Threading:**
Select an existing AI response block and fire ask gesture. CLI receives original source block, previous AI response, and new question via ref chain.

```markdown
```go id="blk-f7c2" detect="cli"
func fetchUser(id int) User {
```

> [!ai] id="ai-r9x1" ref="blk-f7c2"
> To add pagination introduce a page and pageSize parameter...

> [!ai] id="ai-s2t4" ref="blk-f7c2,ai-r9x1"
> Building on the above, error handling should wrap the
> database call and return a typed error...
```

**CLI transparency:**
Any MCP servers, agents, global prompts, or tools in the user's CLI are automatically available. Passed through without modification. Inherited for free, not built by Stash.

**In dumb mode:** Unavailable. Button hidden, shortcut inactive.

---

## Image Handling

**Buffer paste flow:**
1. Image blob detected
2. Saved immediately to `{hostname}/buffers/assets/blk-{id}.png` — safe before anything else
3. Markdown reference inserted with `detect="pending"`
4. WYSIWYG renders inline immediately
5. If Tier 2+ — background CLI call via DescribeImage — configurable timeout
6. On response — file renamed in buffers/assets/, reference and alt text updated, `detect="cli"`, `ai_last_evaluated` written
7. On timeout — stays as block ID filename, `detect="heuristic"`

**On filing:**
- Assets promoted from buffers/assets/ to vault/assets/ with note filename prefix
- Markdown references updated in note
- Originals deleted from buffers/assets/

**On discard:**
- Assets in buffers/assets/ referenced by buffer deleted silently

**In dumb mode:**
- Saved as block ID filename in buffers/assets/, no rename, renders inline

---

## Prompt Management

**Prompts only visible in sidebar if CLI configured.**

**Default prompts** baked into binary. Always available as virtual sidebar entries with no file on disk.

**Editing a default prompt:**
1. User clicks Edit on virtual prompt entry
2. Default content opens in editor tab — editable
3. On Ctrl+S — file materialises in `{hostname}/prompts/`, entry added to settings.json
4. Sidebar entry changes from virtual to real file

**Restoring to default:**
1. User clicks Restore to Default
2. File deleted from `{hostname}/prompts/`
3. Entry removed from settings.json
4. Sidebar entry reverts to virtual

**Defensive rules:**
- If settings.json points to missing prompt file — use baked-in default silently
- If prompt file unparseable — use baked-in default silently
- Stash never fails due to prompt misconfiguration

---

## Prompt Design

All prompts baked into binary as defaults. Any prompt overridable via settings.json. Prompts are plain text — editable in Stash or any editor.

**Filing prompt:**
```
Given the following content, decide if it is worth keeping
as a permanent note.

Existing folders: {folder_list}
Only suggest a new folder if content strongly belongs to a
topic not represented above. Otherwise use closest existing
folder. If nothing fits well — leave folder empty for root.

Importance signals:
- version: {version} — higher means more curation by user
- focus_count: {focus_count} — higher means repeatedly returned to
- v1 with focus_count 0 is almost certainly throwaway
- v10+ with focus_count 4+ is almost certainly worth keeping

Generate rich semantic tags — not just literal terms but related
concepts, technologies, and topics that would help find this note
later. Err on the side of more tags rather than fewer.

Respond ONLY with valid JSON. No preamble. No markdown fences.

{
  "keep": true or false,
  "filename": "meaningful-kebab-case-name.md",
  "folder": "folder-name or empty string for root",
  "new_folder": true or false,
  "type": "detected language or content type",
  "summary": "one line description",
  "tags": ["tag1", "tag2", "tag3"]
}

Content:
{content}
```

**Explain prompt:**
```
Explain the following content clearly and concisely.
Respond in plain markdown suitable for inline display.
Do not repeat the content. Just explain it.

Content type: {type}
Content:
{content}
```

**Ask prompt:**
```
Given the following content and conversation history,
answer the user's question clearly and concisely.
Respond in plain markdown suitable for inline display.

Content type: {type}
Content:
{content}

Conversation history:
{history}

User question:
{question}
```

**Image filing prompt:**
```
Describe this image briefly and suggest a short meaningful
kebab-case filename without extension.

Respond ONLY with valid JSON. No preamble.

{
  "filename": "suggested-filename",
  "description": "brief description for alt text"
}
```

---

## Debug Meta Panel

Available in v1 as a development and debugging tool. Enabled via `"debug": true` in settings.json.

**When enabled:**
- Toggleable panel
- Shows raw JSON dump of current buffer or note meta
- Shows list of all block IDs in current buffer with detect states
- Shows CLI call log — last N calls, prompts sent, temp files used, responses received, timeouts
- Updates live as meta changes

**Not exposed in normal UI** — debug flag must be explicitly set in settings.json.

**Future version:** Polished read-only meta inspector panel available to all users without debug flag. See future enhancements appendix.

---

## Fallback Summary

| Feature | Dumb Mode | Smart Mode |
|---|---|---|
| WYSIWYG markdown editing | ✓ | ✓ |
| Raw markdown mode per tab | ✓ | ✓ |
| Tabbed buffers and notes | ✓ | ✓ |
| Debounced autosave to host buffers/ | ✓ | ✓ |
| Version incrementing on debounced saves | ✓ | ✓ |
| Focus count tracking | ✓ | ✓ |
| Full session restore on crash or restart | ✓ | ✓ |
| Heuristic paste detection | ✓ | ✓ |
| Block IDs assigned on paste | ✓ | ✓ |
| Image paste saved to host buffers/assets/ | ✓ | ✓ |
| Asset promotion on filing | ✓ | ✓ |
| user_intent trash and keep | ✓ | ✓ |
| No system prompts except timeout popup | ✓ | ✓ |
| No are-you-sure prompts ever | ✓ | ✓ |
| Close all buffers / close all tabs | ✓ | ✓ |
| Sidebar showing filed notes | ✓ | ✓ |
| Right click Show in Finder / Files | ✓ | ✓ |
| Ctrl+S / Ctrl+Shift+Return force save | ✓ | ✓ |
| Ctrl+P quick switcher | ✓ | ✓ |
| Ctrl+F in-buffer search | ✓ | ✓ |
| Ctrl+Shift+F vault search — full text | ✓ | ✓ |
| All shortcuts available | ✓ | ✓ |
| Defensive settings and session handling | ✓ | ✓ |
| Per-host configuration and buffers | ✓ | ✓ |
| Shared notes across all hosts | ✓ | ✓ |
| CLI launch with path argument or PWD | ✓ | ✓ |
| Debug meta panel via settings flag | ✓ | ✓ |
| Core data safety principle enforced | ✗ | ✓ |
| CLI strategy pattern — claude/gemini/copilot | ✗ | ✓ |
| CLI language refinement on paste | ✗ | ✓ |
| AI filing decision on tab close | ✗ | ✓ |
| AI naming/tagging on force save | ✗ | ✓ |
| AI folder suggestion | ✗ | ✓ |
| Ctrl+Shift+F vault search — tags and summary | ✗ | ✓ |
| Explain gesture Ctrl+E | ✗ | ✓ |
| Ask gesture Ctrl+Shift+A with threading | ✗ | ✓ |
| Image description and rename | ✗ | ✓ |
| AI timeout popup with retry | ✗ | ✓ |
| Re-evaluation Ctrl+Shift+E on filed notes | ✗ | ✓ |
| Prompt management in sidebar | ✗ | ✓ |
| Close all — parallel AI evaluation with toasts | ✗ | ✓ |
| MCP / agent / tool inheritance | ✗ | ✓ if configured |

---

## What Stash Is Not
- Not a sync tool — vault is a folder, sync is the user's problem
- Not an AI product — CLI tools own auth, keys, models, and integrations
- Not a knowledge base — no hierarchy, no database, no forced structure
- Not a chat app — the note is the conversation, not a sidebar
- Not a file manager — standard file operations delegated to the OS
- Not an editor — Tiptap is the editor, Stash is the shell around it

---

## Known Limitations
- On an unplanned crash (OOM, force kill), up to one autosave debounce interval of content may be lost. Default is 30 seconds. Planned close events always write immediately. This is an accepted tradeoff.
- Sync conflict on session.json is theoretically possible if the same vault is open on two machines simultaneously and both write session.json at the same moment — last write wins, some tab state may be lost. Note content is never affected. Mitigated by per-host subdirectory structure making this practically impossible in normal use.
- Exact CLI flags and invocation patterns for ClaudeCLI, GeminiCLI, and CopilotCLI require verification against current CLI documentation before v1 ships.

---

## Future Enhancements

Features deliberately deferred from v1. Considered and designed around but not blocking initial release.

| Feature | Notes |
|---|---|
| Drag and drop folder organisation in sidebar | Quality of life — OS file explorer covers this for now |
| GUI vault folder picker on launch | v1 is CLI only — folder picker for non-CLI launch deferred |
| Recent vaults list | Useful once multiple vaults exist |
| Shortcut remapping | Shortcuts hardcoded in v1 — remapping via settings.json in future |
| AI-powered semantic search | Tags and summary search covers most cases — full AI semantic search deferred |
| Web clipper / browser extension | Different surface, different complexity — v2 |
| Mobile | Different product entirely |
| Margin paradigm — full implementation | See Appendix B — structurally ready from v1 via block IDs, UI deferred |

---

## Tech Stack

**Status: Decided.**

**Wails + Go + Tiptap + TypeScript + React + shadcn/ui**

---

### Decision

The editor is the product. The editor technology determines the stack.

**Tiptap** is the editor. It is the industry standard for custom WYSIWYG markdown editor implementations — built on ProseMirror, used by Confluence, Notion, Linear, and most serious editor implementations. It is headless, framework-agnostic, reads and writes markdown natively, has first-class code block syntax highlighting, paste interception hooks, and custom node attributes. Approximately 2,200 lines of custom TypeScript required — the rest comes from Tiptap's extension ecosystem.

**Wails** is the native shell. It wraps the Tiptap webview in a native desktop window, compiles to a single binary, targets Mac and Linux, and auto-generates TypeScript bindings from Go functions. There is no seam — the entire visible UI is rendered by the same webview engine, making the Sublime aesthetic achievable consistently throughout.

**Go** is the backend. File operations, CLI strategy pattern, concurrent process spawning with timeouts, session management, settings. Go's concurrency model — goroutines, channels, context with timeout — is the right tool for the async CLI orchestration that is the hardest part of the backend. Go is also a deliberate learning goal for the developer and the project serves as a real-world introduction to the language.

**TypeScript + React + shadcn/ui** is the frontend layer. Claude Code owns this entirely. shadcn/ui is extensively represented in Claude Code's training data, provides the tab bar, sidebar, toast notifications, toolbar, and all UI chrome in a consistent design system. The developer does not need to write TypeScript.

---

### Why not the alternatives

**Flutter + WebView** — Flutter's native UI and the webview editor run in different rendering engines. The seam is architectural and cannot be solved. Font rendering, hover states, scrollbar styles will never be consistent. The Sublime aesthetic requires one rendering engine throughout.

**Electron + Node** — Valid option. Rejected because Go is preferred for the backend and Wails eliminates the need for Electron. Wails produces a smaller binary, no bundled Chromium, cleaner IPC via auto-generated bindings.

**Tauri + Rust** — Rust's async model (Tokio) is genuinely complex. The developer has no Rust experience and the learning curve outweighs the benefits over Go.

**appflowy_editor** — Flutter-native editor. Does not match the quality of Tiptap. Markdown round-trip reliability is not production grade. Rejected.

---

### The Wails Bridge

Wails auto-generates TypeScript bindings from Go struct methods. The developer writes Go functions. Wails exposes them to TypeScript as typed async functions. No manual HTTP endpoints, no WebSocket setup, no message serialisation.

```go
// Go — define backend functions
func (a *App) SaveBuffer(path string, content string) error {
    return os.WriteFile(path, []byte(content), 0644)
}

func (a *App) LoadBuffer(path string) (string, error) {
    bytes, err := os.ReadFile(path)
    return string(bytes), err
}
```

```typescript
// TypeScript — auto-generated, just call it
import { SaveBuffer, LoadBuffer } from '../wailsjs/go/main/App'

const content = await LoadBuffer(bufferPath)
editor.commands.setContent(content)
await SaveBuffer(currentPath, markdown)
```

Events from Go back to TypeScript use the Wails runtime event system:

```go
// Go — emit event when CLI responds
runtime.EventsEmit(a.ctx, "cli:response", payload)
```

```typescript
// TypeScript — listen
import { EventsOn } from '../wailsjs/runtime'
EventsOn('cli:response', (payload) => updateBlock(payload))
```

---

### Responsibility split

| Layer | Technology | Owner |
|---|---|---|
| Native shell | Wails | Wails handles |
| Editor | Tiptap | Claude Code configures |
| UI chrome | React + shadcn/ui | Claude Code owns entirely |
| Frontend logic | TypeScript | Claude Code owns entirely |
| File operations | Go | Claude Code + developer |
| CLI orchestration | Go | Claude Code + developer |
| Session + settings | Go | Claude Code + developer |

---

### Walking skeleton — first milestone

Before any feature work, validate the architecture end to end:

1. Wails project scaffold
2. Two Go functions — `LoadBuffer` and `SaveBuffer`
3. Tiptap in the webview loading and saving one markdown file
4. Nothing else

If a markdown file on disk loads into Tiptap, edits, and saves back correctly — the architecture is proven and everything else builds on top of it. This is a half day of work.

---

## Appendix A — Design Aesthetic

**Reference:** Sublime Text. At minimum VS Code. The editor aesthetic is well understood and non-negotiable.

**Defining characteristics:**
- Dark charcoal background — Sublime's warm dark grey, not pure black
- Compact tab bar with status dots — already matches the spec
- Left sidebar — minimal folder tree, no decoration, muted label
- Line numbers in slightly lighter grey
- Monospace font throughout the entire UI — not just the editor
- No gradients, no shadows, no decorative elements
- Muted colour palette with purposeful accent colours only
- Status indicators use the spec dot colours — amber, green, red, blue
- Right panel replaces the minimap

**Colour brief:**
Use an existing VS Code or Sublime theme as the explicit colour palette. Hand the theme's colour tokens to the implementation and use them throughout with zero deviation. Recommended candidates: Sublime Monokai, VS Code Dark+, Dracula, Tokyo Night. Pick one and lock it. No aesthetic decisions during development.

**Reference screenshot:**
The target aesthetic is captured in the developer's own Sublime Text setup — dark charcoal background, compact tabs with status dots, minimal sidebar folder tree, dense monospace content, right panel replacing the minimap.

---

## Appendix B — The Margin Paradigm (v2)

The right panel in v1 displays meta. In v2 it becomes a full margin — a parallel annotation layer anchored to the primary document via block IDs. This is a structurally significant design decision that must be understood before v1 is built, even though implementation is deferred.

### The Core Concept

Every buffer and note has a sibling file:

```
vault/notes/kubernetes/k8s-ingress-fix.md       ← primary content, pure markdown
vault/notes/kubernetes/k8s-ingress-fix._margin  ← all annotations
```

The `_margin` file contains structured annotations anchored to block IDs in the primary file. Block IDs are the join key. The primary file is unaffected — it remains pure markdown with no AI noise, no annotation markers, no embedded metadata beyond the meta frontmatter.

### The Rendering Model

The editor renders two panes side by side. They scroll in sync. The right pane floats annotation cards at the vertical position of their referenced block. Where no annotation exists the right pane is empty whitespace — the whitespace is meaningful, it reinforces the spatial association.

```
┌─────────────────────────┬──────────────────────┐
│ primary content         │ margin               │
├─────────────────────────┼──────────────────────┤
│                         │                      │
│ ## Ingress Config       │                      │
│                         │                      │
│ ```yaml id="blk-a3f9"  │ ┌──────────────────┐ │
│ apiVersion: v1          │ │ 🤖 explain       │ │
│ kind: Ingress           │ │ This configures  │ │
│ ...                     │ │ websocket support│ │
│ ```                     │ └──────────────────┘ │
│                         │                      │
│ Some notes about        │                      │
│ the annotation...       │                      │
│                         │                      │
│ ```go id="blk-f7c2"    │ ┌──────────────────┐ │
│ func fetchUser(         │ │ 💬 ask           │ │
│   id int) User {        │ │ Q: pagination?   │ │
│ ```                     │ │ A: Add page +    │ │
│                         │ │ pageSize params  │ │
│                         │ └──────────────────┘ │
│                         │                      │
│ More content here       │ ┌──────────────────┐ │
│                         │ │ 📝 Note          │ │
│                         │ │ check prod       │ │
│                         │ │ cluster config   │ │
│                         │ └──────────────────┘ │
└─────────────────────────┴──────────────────────┘
```

### The Mental Model

This is the margin of a physical document — where you scribble notes, questions, annotations, references. Most editors conflate primary content and margin thinking. Stash separates them structurally.

The analogy that captures it best is a GitHub PR review — comments anchored to specific lines, appearing alongside the diff, scrolling in sync. A mental model developers immediately understand.

### Annotation Types

The margin supports multiple annotation types, all stored in the same `_margin` file, typed by a field:

| Type | Icon | Description |
|---|---|---|
| `ai_explain` | 🤖 | AI explain response |
| `ai_ask` | 💬 | AI ask exchange — question and response |
| `note` | 📝 | Human written margin note |
| `todo` | ⚠️ | Action item anchored to specific content |
| `reference` | 🔗 | Link to another note, external URL, or block in another file |

### The `_margin` File Format

```json
{
  "annotations": [
    {
      "id": "ann-r9x1",
      "ref": "blk-a3f9",
      "type": "ai_explain",
      "response": "This is a Kubernetes ingress manifest...",
      "timestamp": "2026-04-11T11:23:00",
      "cli": "claude"
    },
    {
      "id": "ann-s2t4",
      "ref": "blk-f7c2",
      "type": "ai_ask",
      "question": "How would I expand this for pagination?",
      "response": "You could add a page parameter...",
      "timestamp": "2026-04-11T11:45:00",
      "cli": "claude",
      "thread": ["ann-t3u5"]
    },
    {
      "id": "ann-v4w6",
      "ref": "blk-f7c2",
      "type": "note",
      "content": "check prod cluster config before deploying",
      "timestamp": "2026-04-11T12:00:00"
    }
  ]
}
```

### Threading

AI ask exchanges can thread. The `thread` field on an annotation points to follow-up annotation IDs. The margin renders threads as visually nested or connected cards — the spatial association between question and follow-up is preserved.

```
┌──────────────────────────────┐
│ 💬 ask                       │
│ Q: pagination?               │
│ A: Add page + pageSize...    │
│                              │
│  └─ 💬 follow up             │
│     Q: error handling?       │
│     A: wrap in typed error...│
└──────────────────────────────┘
```

### Relationship to v1

The margin paradigm is structurally ready from v1 because block IDs are assigned and written to disk from the first version. No migration is needed. Adding the margin in v2 means:

- Writing the `_margin` file format and writer
- Building the dual pane sync scroll renderer
- Adding the note/todo/reference annotation types
- Optionally migrating existing inline `[!ai]` callout blocks from primary notes into `_margin` files

The v1 inline `[!ai]` callout blocks remain valid. Users can choose to promote a margin annotation into primary content — making it part of the note itself — as an explicit action. The two models coexist.

### Why This Must Be Understood Before v1

The right panel must be the correct width and positioned correctly from day one. The layout — primary pane left, margin pane right — is the v2 structure. In v1 the right panel shows meta. In v2 it shows the margin. The transition is filling in the panel, not restructuring the layout.

If v1 is built without this understanding the panel may be sized, positioned, or structured in a way that makes the v2 transition painful. Build the correct layout from day one. Leave the panel empty or showing meta. Fill it in v2.

### The Generalised Vision

The margin is not just an AI panel. It is a general purpose annotation layer that separates primary content from thinking about that content. This is a genuinely novel UI pattern for a developer tool. The right panel starts as meta, becomes the margin, and the margin becomes the paradigm.
