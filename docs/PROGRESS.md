# Stash — Implementation Progress Report

Generated: 2026-04-11  
**Honest status: Milestones 1–4 solid. Milestones 5 and 6 partially complete. Do not skip ahead to CLI/AI work until the gaps below are closed.**

---

## Architecture

Stack: **Wails v2 + Go + Tiptap + React + TypeScript + Tailwind (shadcn/ui)**  
Platform: Linux (WebKitGTK). Also targets macOS/Windows.  
Store path: `STASH_STORE` env var (reliable in `wails dev`) or CLI arg or PWD fallback.

Dev server: `STASH_STORE=tmp/test-store wails dev`  
Test store: `tmp/test-store/` — 3 buffers in `dash/buffers/`, 1 filed note in `notes/`

---

## Milestone Scorecard

### Milestone 1 — Walking Skeleton ✓ Complete
- Wails scaffold, Go `App` struct, `LoadBuffer` / `SaveBuffer`
- Tiptap + `tiptap-markdown` for markdown ↔ ProseMirror round-trip
- `CodeBlockWithAttrs` extension: `id=` and `detect=` attrs on fenced code blocks survive round-trip
- `BlockIdMark` extension: inline `<span id="blk-xxx">` anchors survive round-trip
- Tables, syntax highlighting via `lowlight`

---

### Milestone 2 — Session & Tabs ✓ Complete
- Multi-tab UI (`TabBar` component)
- Session persisted to `store/{hostname}/session.json` on every tab change, open, close, scroll, mode toggle
- Scroll position saved and restored per tab
- Tab dot indicators: amber = unfiled, green = filed, blue = keep, red = trash, none = empty
- `M` badge on tab when in raw markdown mode

---

### Milestone 3 — Store & Settings ✓ Complete
- `store/store.go`: `Open`, hostname detection, directory creation
- `store/settings.go`: `Settings` struct, `autosave_debounce`, `debug`, `tier` (dumb/smart)
- `store/buffer.go`: `NewBuffer` creates `buf-YYYYMMDD-HHMM.md` with full 14-field YAML frontmatter
- `StoreInfo` exposed to frontend

---

### Milestone 4 — Autosave & Versioning ✓ Complete
- Debounced autosave (30s default, configurable via `autosave_debounce` in settings)
- `bumpFm`: every WYSIWYG save increments `version` and updates `modified` timestamp
- Immediate flush on tab switch, tab close, Ctrl+S, app close
- `SaveBuffer` Go guard: rejects any write missing `---\n` frontmatter (defence-in-depth)
- Frontend fmCache guard: skips save if `fmCache[path] === undefined` (loadTab race prevention)

---

### Milestone 5 — Sidebar ⚠️ Partially Complete

#### Done
- `store/notes.go`: `ScanNotes` recursive walk, `NoteEntry` tree struct
- `Sidebar` React component: collapsible folder tree
- Click note → open in new tab, or focus existing tab if already open
- `fsnotify` watcher (`watcher.go`): 350ms debounce, recursive, emits `notes:changed` → sidebar live-updates
- Resizable drag handle (160–520px), width persisted in `session.SidebarWidth`
- `Ctrl+\` toggles sidebar
- Assets not shown (correct per spec)

#### Not Done
- **Right-click → Show in Files** (OS file explorer at that location) — spec requires this on every sidebar item
- **Prompts section** — visible only when CLI configured; shows file.md, explain.md, ask.md with Edit and Restore to Default buttons. Deferred until CLI milestone.

#### Spec Discrepancy — Meta Panel
The `MetaPanel` component (`Ctrl+Shift+I`) we built is **not a spec feature for normal users**. The spec defines a "Debug Meta Panel" gated behind `debug: true` in settings.json — it shows raw JSON meta dump, block ID list with detect states, and CLI call log. Our panel shows parsed frontmatter fields in a styled UI, which is closer to a future-version "polished inspector" the spec mentions. Decision needed: either gate it behind `debug: true`, or accept it as a deliberate addition ahead of spec. Currently it is always-visible.

---

### Milestone 6 — Buffer Lifecycle ⚠️ Partially Complete

#### State 1 — Unsaved Scratch ✓ Done
- Lives in `buffers/`, named by timestamp
- Written on debounce and explicit save
- `version` increments on each write
- `focus_count` increments after 2-minute focus timer
- Restored from session.json on restart

#### State 2 — Force Save (Ctrl+S / Ctrl+Shift+Return) ⚠️ Partial
- ✓ File moves to `notes/` with kebab name (from `user_suggested_name` → first heading → timestamp)
- ✓ Tab stays open pointing at the new `notes/` path, status updates to `filed`
- ✗ **Asset promotion not implemented** — buffers/assets/ images are NOT copied to store/assets/, markdown refs NOT updated. Any buffer with pasted images will have broken image links after filing.
- ✗ AI naming / background suggestion — deferred to AI milestone
- ✗ Subtle notification UI — deferred to AI milestone

#### State 3 — AI Filed on Tab Close ✗ Deferred
- The entire AI evaluation path (`user_intent: null`, unfiled, tab close) is deferred.
- Currently: unfiled buffer with null intent just closes; buffer file stays on disk orphaned.
- This is the spec's primary filing path and must be implemented before v1.

#### State 4 — User Intent Close ⚠️ Partial
- ✓ `user_intent: trash` → `DiscardBuffer` (silent delete)
- ✓ `user_intent: keep` → save + `FileBuffer` (moves to notes/)
- ✗ Asset promotion on keep-filing — same gap as State 2
- ✗ AI naming/tagging/summary on keep-filing — deferred

#### State 5 — Opened from Store ✓ Done
- Open via sidebar click
- Direct edit in-place, no buffer copy
- Tab/scroll/mode persisted

#### Asset Promotion ✗ Not Done
This is a hard dependency for States 2 and 4. Without it, any buffer containing pasted images will lose those images when filed.

**Required implementation (Go `store/buffer.go` or new `store/assets.go`):**
1. After `FileBuffer` determines the destination note name, scan the note content for image refs matching `buffers/assets/`
2. For each ref: copy file from `{hostname}/buffers/assets/blk-xxx.png` → `assets/{note-name}-blk-xxx.png`
3. Update the markdown ref in the note content to point at `../../assets/` (relative path)
4. Delete originals from `buffers/assets/`
5. On `DiscardBuffer`: delete all `buffers/assets/` files referenced by that buffer

#### Close All Operations ✗ Not Done
Both required by spec (both dumb mode and smart mode variants):
- **Close all buffers** — closes only unfiled scratch tabs, leaves filed notes open
- **Close all tabs** — closes everything

In dumb mode: all unfiled tabs discarded silently (no prompts).
Needs keyboard shortcut and/or menu entry. Spec does not assign a default shortcut — needs decision.

---

### Missing Features — Dumb Mode Complete (no AI required)

These are all required for a complete dumb-mode v1 and have nothing built:

| Feature | Spec Section |
|---|---|
| **Ctrl+P quick switcher** — fuzzy search open tabs + all notes | §Keyboard Shortcuts |
| **Ctrl+F in-buffer search** — find within current tab | §Search |
| **Ctrl+Shift+F store search** — full text across notes/ | §Search |
| **Heuristic paste detection** — 4-tier local classification, instant | §Paste Intelligence |
| **Block IDs assigned on paste** — code blocks get `id=` + `detect="heuristic"` | §Paste Intelligence + §Block ID System |
| **Image paste** — save to `buffers/assets/`, insert markdown ref with `detect="pending"` | §Paste Intelligence |
| **Right-click Show in Files** on sidebar items | §Sidebar |
| **Close all buffers / Close all tabs** | §Close All Operations |
| **Asset promotion on filing** | §Asset Promotion |

---

### Smart Mode Features — Deferred (CLI + AI required)

Do not implement these until dumb mode is complete and the CLI strategy pattern is wired up.

| Feature | Notes |
|---|---|
| CLI strategy pattern (`cli/` package) | Go interface + Claude/Custom implementations |
| AI filing decision on tab close (State 3) | `user_intent: null` + unfiled → evaluate → keep/discard |
| AI naming/tagging/summary on force save | Background call after `FileBuffer` |
| AI language refinement on paste (Tier 2+) | Background CLI call after heuristic detection |
| AI timeout popup with retry | §AI Timeout Popup |
| Ctrl+E explain gesture | §Explain Gesture |
| Ctrl+Shift+A ask gesture with threading | §Ask Gesture |
| Ctrl+Shift+E re-evaluate filed note | §Buffer Lifecycle (Re-evaluation) |
| Image description + rename via AI | §Image Handling |
| Prompt management in sidebar | §Prompt Management |
| Close all — parallel AI evaluation with toasts | §Close All Operations (Smart Mode) |
| Ctrl+Shift+F store search — tags + summary | §Search (Smart Mode) |

---

## Recommended Build Order (before CLI/AI)

1. **Asset promotion** — unblocks correct filing for image-bearing buffers
2. **Paste intelligence** — heuristic detection + block ID assignment + image paste
3. **Close all buffers / Close all tabs** — required dumb-mode feature
4. **Ctrl+F in-buffer search** — basic editor feature, should have been in earlier
5. **Ctrl+P quick switcher** — high-value UX, pure frontend
6. **Ctrl+Shift+F store search (full text)** — Go-side ripgrep or walk + scan
7. **Right-click Show in Files** on sidebar
8. Then: CLI strategy pattern → AI integration

---

## File Map

### Go
| File | Purpose |
|---|---|
| `main.go` | Wails entry point, store path resolution |
| `app.go` | `App` struct, all Wails-bound methods: `GetStoreInfo`, `GetSession`, `SaveSession`, `GetNotes`, `LoadBuffer`, `SaveBuffer`, `NewBuffer`, `FileBuffer`, `DiscardBuffer`, `SaveSidebarWidth`, `SaveMetaWidth` |
| `watcher.go` | `notesWatcher` — fsnotify + 350ms debounce, recursive dir watching |
| `store/store.go` | `Store` struct, `Open`, path helpers, dir creation, `.tmp` cleanup |
| `store/buffer.go` | `NewBuffer`, `FileBuffer`, `DiscardBuffer`, kebab name helpers, `replaceFmField` |
| `store/notes.go` | `ScanNotes`, `NoteEntry` |
| `store/session.go` | `Session`, `Tab`, `Window` structs, JSON load/save |
| `store/settings.go` | `Settings`, `Tier` |
| `logger/logger.go` | Structured logger wrapping `log/slog` |

### Frontend
| File | Purpose |
|---|---|
| `frontend/src/App.tsx` | Root component — all state, tab lifecycle, keyboard shortcuts, resize logic |
| `frontend/src/App.css` | Layout (flex), sidebar/meta drag handles, gutter separator |
| `frontend/src/types.ts` | `TabState`, `BufferStatus`, `UserIntent`, `TabMode` |
| `frontend/src/main.tsx` | React entry point; global context-menu suppression |
| `frontend/src/components/TabBar.tsx` | Tab bar UI + dot/badge logic |
| `frontend/src/components/Sidebar.tsx` | Collapsible file tree |
| `frontend/src/components/MetaPanel.tsx` | Parsed frontmatter viewer (see spec discrepancy note above) |
| `frontend/src/components/HelpModal.tsx` | Keyboard shortcut + markdown cheatsheet |
| `frontend/src/extensions/CodeBlockWithAttrs.ts` | Tiptap: code blocks with `id`/`detect` attrs, markdown round-trip |
| `frontend/src/extensions/BlockIdMark.ts` | Tiptap: inline span block ID marks |
| `frontend/src/extensions/CodeBlockNodeView.tsx` | React node view for syntax-highlighted code blocks |
| `frontend/wailsjs/go/main/App.js` + `App.d.ts` | Wails bindings (auto-generated; keep in sync manually when adding Go methods) |

---

## Key Design Decisions

**Frontmatter never shown in WYSIWYG.** `splitFrontmatter()` strips it before `editor.setContent()`; `fmCache` holds it per-path; re-prepended on every save. In markdown mode the full file (fm + body) is shown in a raw textarea via `rawMd` state + `mdCache` ref.

**fmCache guard.** `onUpdate` and `flush()` skip saving if `fmCache.current[path] === undefined` — this means `loadTab` hasn't resolved yet. Prevents the race where a hot-reload triggers a save before the file has been read, wiping frontmatter.

**Go SaveBuffer guard.** Rejects any content not starting with `---\n`. Defence-in-depth — even if the frontend sends bad content, the file on disk is never overwritten.

**Session written eagerly.** `saveSession()` is called on every state-changing operation. No batching, no debounce. This is intentional — session loss on crash is worse than extra writes.

**tiptap-markdown parse.setup location.** The markdown-it fence renderer patch MUST go in `CodeBlockWithAttrs.addStorage().markdown.parse.setup`, NOT in `Markdown.configure()` options — the latter is silently ignored by tiptap-markdown.

**Tab key = 4 spaces.** Implemented via `editorProps.handleKeyDown` in `useEditor`. Uses `view.dispatch(view.state.tr.insertText('    '))` directly. Extension-based approaches did not work reliably in WebKitGTK.

**Shift+Tab known issue.** WebKit captures Shift+Tab for focus navigation before the editor gets it. `event.preventDefault()` in `handleKeyDown` works for Tab but not Shift+Tab in this WebKit version. Workaround attempted (document capture listener) broke Tab. Currently: Shift+Tab dedents the current line when focus stays in the editor, but WebKit sometimes steals it. Deferred.

---

## Known Issues

| Issue | Impact | Status |
|---|---|---|
| Shift+Tab browser capture | Minor UX — dedent works when editor keeps focus | Deferred |
| Meta panel not gated by `debug: true` | Spec discrepancy — panel is always visible | Decision needed |
| State 3 (null-intent close) leaves orphan buffers | Buffers with null intent just close, file stays on disk accumulating | Deferred until AI milestone |
| Asset promotion missing | Any buffer with pasted images loses those images on filing | Must fix before paste intelligence |
