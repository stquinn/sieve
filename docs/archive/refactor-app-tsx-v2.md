# App.tsx Refactor Plan — v2

**Based on:** complete read of all 2,946 lines of `frontend/src/App.tsx`
**Branch:** `feature/js_tsx_refactor`
**Written:** 2026-04-18

> NOTE: An earlier draft of this file was written by an agent that had not fully read the
> file. That draft's line ranges and structure were wrong. This version is authoritative.

---

## Already Complete (pre-v2)

| Task | File | LOC moved | Commit |
|---|---|---|---|
| G | `lib/imageUtils.ts` — `mdSrcToStoreRelPath` | ~20 | `2f5dca6` |
| B | `lib/aiContextBuilder.ts` + `lib/markdown.ts` | ~290 | `48dfdc4` |

---

## File Map (actual structure after prior extractions)

| Lines | Content |
|---|---|
| 1–43 | Imports |
| 44–150 | Module-level pure util functions (`assetMarkdownPath`, `getLocalISOString`, `versionFromFm`, `bumpFm`, `bumpFocusCount`, `parseMeta`, `applyFilingRec`, `setYamlField`, `getAncestorPaths`) |
| 152–185 | `EditorStats` mini-component |
| 187–285 | `App()` component body — state + ref declarations (~30 useState, ~20 useRef) |
| 286–398 | Computed values, bare ref sync, inline utils (`extractSuggestedName`, `finishCloseTab`), `H` ref init |
| 399–770 | `useEditor` setup + `handlePaste` (autosave timer, drag/drop, code paste) |
| 776–846 | `loadTab` useCallback |
| 850–910 | Bootstrap `useEffect` (`GetStoreInfo → GetSession → loadTab`) |
| 911–975 | `persistSession` + reactive effects (auto-expand folders, scroll restore) |
| 977–1067 | `saveBufferSafe`, `savePromptSafe`, `flush` |
| 1068–1295 | Tab operations (`currentScroll`, `selectTab`, `newTab`, `closeTab`, `reorderTab`, `setTabIntent`, `closeTabsBulk`, `closeAllTabs`, `closeAllBuffers`) |
| 1296–1490 | `runBackgroundEval`, `smartSave`, `forceFile` |
| 1492–1634 | `toggleMode`, sidebar/meta resize handlers |
| 1635–1923 | Note/folder operations (`openNote`, `handleDeleteNote`, `handleMoveNote`, `handleSmartFile`, `handleSmartMetadata`, `handleSetIntentByPath`, `handleCreateFolder`, `handleDeleteFolder`, `handleRename`, `onEditPrompt`, `onRestorePrompt`) |
| 1925–2203 | AI gestures (`insertAiPlaceholder`, `replaceAiPlaceholder`, `resolvePathByUuid`, `applyAiResponseInBackground`, `touchAiLastEvaluated`, `explainGesture`, `askGesture`, `handleAskSend`) |
| 2205–2232 | `useLayoutEffect` — update `H.current` every render |
| 2234–2304 | Keyboard listener `useEffect` |
| 2305–2438 | WebKitGTK blob image MutationObserver |
| 2441–2506 | App `closing` event handler |
| 2508–2557 | Focus count tracking (30s visit + 5min dwell) |
| 2559–2596 | AI tick, scroll tracking, saveTimer cleanup |
| 2598–2946 | JSX render tree (bootstrap screen + main layout) |

---

## What Can and Cannot Be Extracted

### CANNOT be safely extracted (stay in App.tsx)

These sections are tightly coupled to each other via shared state, caches, and refs.
Extracting them would require threading 15–25 parameters and produce a worse result.

- **State/ref declarations** (187–285) — the raw fabric of the component
- **Bare ref sync** (280–285) — `tabsRef.current = tabs` etc. are plain assignments in the component body, intentionally not in effects; must stay in component body
- **Inner utilities** (286–398) — `extractSuggestedName`, `finishCloseTab` close over caches/refs directly
- **`useEditor` + `handlePaste`** (399–770) — autosave timer, drag/drop, paste pipelines; all close over `fmCache`, `savedBodyCache`, `tabsRef`, `activeTabRef`, `setRawMd`, editor
- **`loadTab`** (776–846) — closes over `editor`, `fmCache`, `mdCache`, `savedBodyCache`, `setYamlField`, `parseMeta`, `uuidToPath`
- **Bootstrap `useEffect`** (850–910) — sequential data dependency (`GetStoreInfo → GetSession → loadTab`); cannot be split
- **Reactive effects** (911–975) — `persistSession`, folder auto-expand, scroll restore; read multiple pieces of state
- **`saveBufferSafe`, `savePromptSafe`, `flush`** (977–1067) — used in 20+ places; extracting requires passing entire cache/ref bag
- **Tab operations** (1068–1295) — close over `tabs`, `activeIdx`, all caches
- **`runBackgroundEval`, `smartSave`, `forceFile`, `toggleMode`** (1296–1634) — deeply coupled to tabs, caches, Wails bindings
- **`H.current` + keyboard listener** (2205–2304) — must stay adjacent to the functions it aggregates
- **JSX render tree** (2598–2946) — prop-drilling to all handlers; extracting just moves complexity

### CAN be extracted (6 tasks)

---

## Task List

| # | Task | Target | Lines | LOC | Risk | Status | Commit |
|---|---|---|---|---|---|---|---|
| 1 | FM utils | `lib/fmUtils.ts` | 44–150 | ~110 | Low | `[ ]` | — |
| 2 | EditorStats | `components/EditorStats.tsx` | 152–185 | ~34 | Low | `[ ]` | — |
| 3 | Note operations | `hooks/useNoteOperations.ts` | 1635–1923 | ~290 | Med | `[ ]` | — |
| 4 | AI gestures | `hooks/useAiGestures.ts` | 1925–2203 | ~280 | Med | `[ ]` | — |
| 5 | Blob image observer | `hooks/useBlobImageObserver.ts` | 2305–2438 | ~135 | Low-Med | `[ ]` | — |
| 6 | App lifecycle | `hooks/useAppLifecycle.ts` | 2441–2557 | ~120 | Low-Med | `[ ]` | — |

**Projected total LOC removed from App.tsx: ~969**
**Projected final App.tsx size: ~1,950–1,980 lines**

The remaining ~1,977 lines are load-bearing state machine code that resists further
extraction without making things worse.

---

## Phase Ordering

```
Phase 1 (foundations, do first):     Tasks 1, 2
Phase 2 (hooks, any order):          Tasks 3, 4, 5, 6
```

Task 1 must precede Tasks 3–6 because hooks use `parseMeta`, `setYamlField`, `bumpFocusCount`, `getLocalISOString`, `assetMarkdownPath` from fmUtils.
Tasks 3–6 are independent of each other.

---

## Task Detail

---

### Task 1 — `lib/fmUtils.ts`

**Status:** `[ ]`
**Lines in App.tsx:** 44–150
**LOC:** ~110
**Risk:** Low — pure functions, no React, no side effects

**What it owns:** All frontmatter/YAML manipulation utilities and the `assetMarkdownPath` helper.

**Functions to move:**
- `assetMarkdownPath(tabPath, assetStorePath): string`
- `getLocalISOString(d?): string`
- `versionFromFm(fm): string`
- `bumpFm(fm): string`
- `bumpFocusCount(fm): string`
- `parseMeta(fm, body): ParsedMeta`
- `applyFilingRec(fm, rec, cli): string`
- `setYamlField(yaml, key, val): string`
- `getAncestorPaths(path): string[]`

**Dependencies:**
- `stash.FilingRecommendation` from `../wailsjs/go/models` (for `applyFilingRec`)
- `TabState` type from `./types` (for `parseMeta` return)
- No React deps

**Pre-conditions:** None.

**Accept when:** `tsc --noEmit` passes; App.tsx imports all nine functions from `lib/fmUtils.ts`; lines 44–150 in App.tsx are replaced with the import statement.

---

### Task 2 — `components/EditorStats.tsx`

**Status:** `[ ]`
**Lines in App.tsx:** 152–185
**LOC:** ~34
**Risk:** Low — self-contained; no shared state; props-only interface

**What it owns:** Word/line count display widget in the status bar.

**Props:**
```typescript
interface EditorStatsProps {
  editor: Editor | null
  isMarkdownMode: boolean
  rawMd: string
}
```

**Dependencies:**
- `Editor` from `@tiptap/react`
- `splitFrontmatter` from `./lib/markdown` (already extracted)
- React (`useState`, `useEffect`)

**Pre-conditions:** Task 1 not required (only uses `splitFrontmatter` which is already in `lib/markdown`).

**Accept when:** `tsc --noEmit` passes; stats display correctly in both modes.

---

### Task 3 — `hooks/useNoteOperations.ts`

**Status:** `[ ]`
**Lines in App.tsx:** 1635–1923
**LOC:** ~290
**Risk:** Medium — references confirm/prompt modal state, calls flush, mutates tabs

**What it owns:** All note and folder CRUD operations invoked from the sidebar.

**Functions to move:**
- `openNote(path)`
- `handleDeleteNote(path)`
- `handleMoveNote(oldPath, newPath)`
- `handleSmartFile(path)`
- `handleSmartMetadata(path)`
- `handleSetIntentByPath(path, intent)`
- `handleCreateFolder(parentPath)`
- `handleDeleteFolder(path)`
- `handleRename(path, currentName, isDir)`
- `onEditPrompt(name)`
- `onRestorePrompt(name)`

**Params to hook:**
```typescript
{
  tabs: TabState[]
  activeIdx: number
  isMarkdownMode: boolean
  editor: Editor | null
  tabsRef: React.MutableRefObject<TabState[]>
  fmCache: React.MutableRefObject<Record<string, string>>
  mdCache: React.MutableRefObject<Record<string, string>>
  savedBodyCache: React.MutableRefObject<Record<string, string>>
  uuidToPath: React.MutableRefObject<Map<string, string>>
  setTabs: React.Dispatch<React.SetStateAction<TabState[]>>
  setActiveIdx: React.Dispatch<React.SetStateAction<number>>
  setNotes: React.Dispatch<React.SetStateAction<NoteEntry[]>>
  setConfirmModal: (val: ConfirmModal | null) => void
  setPromptModal: (val: PromptModal | null) => void
  selectTab: (idx: number) => void
  flush: () => Promise<void>
  runBackgroundEval: (uuid: string, path: string, fileAfter: boolean) => Promise<void>
  H: React.MutableRefObject<{ loadTab: (tab: TabState) => void }>
}
```

**Return:**
```typescript
{ openNote, handleDeleteNote, handleMoveNote, handleSmartFile, handleSmartMetadata,
  handleSetIntentByPath, handleCreateFolder, handleDeleteFolder, handleRename,
  onEditPrompt, onRestorePrompt }
```

**Pre-conditions:** Task 1 complete (uses `parseMeta`, `setYamlField` from fmUtils).

**Accept when:** Open/delete/move/rename/folder ops all work via sidebar; AI filing triggers correctly.

---

### Task 4 — `hooks/useAiGestures.ts`

**Status:** `[ ]`
**Lines in App.tsx:** 1925–2203
**LOC:** ~280
**Risk:** Medium — closes over `editor`, `isMarkdownMode`, `activeTabRef`, `fmCache`, `setRawMd`

**What it owns:** Explain/Ask gesture handlers; AI block insertion/replacement; UUID path resolution; background AI response application.

**Functions to move:**
- `insertAiPlaceholder(aiId, blockRef, question?)`
- `replaceAiPlaceholder(aiId, responseText)`
- `resolvePathByUuid(uuid): string | undefined`
- `applyAiResponseInBackground(uuid, aiId, responseText)`
- `touchAiLastEvaluated()`
- `explainGesture()`
- `askGesture()`
- `handleAskSend(question)`

**Params to hook:**
```typescript
{
  editor: Editor | null
  isMarkdownMode: boolean
  rawMd: string
  activeTabRef: React.MutableRefObject<TabState | undefined>
  tabsRef: React.MutableRefObject<TabState[]>
  activeIdxRef: React.MutableRefObject<number>
  uuidToPath: React.MutableRefObject<Map<string, string>>
  fmCache: React.MutableRefObject<Record<string, string>>
  savedBodyCache: React.MutableRefObject<Record<string, string>>
  mdCache: React.MutableRefObject<Record<string, string>>
  tierRef: React.MutableRefObject<'dumb' | 'smart'>
  askContextRef: React.MutableRefObject<AiContext | null>
  pendingAiCount: React.MutableRefObject<number>
  cliTimeoutLongMs: React.MutableRefObject<number>
  setTabs: React.Dispatch<React.SetStateAction<TabState[]>>
  setRawMd: React.Dispatch<React.SetStateAction<string>>
  setShowAskPopup: React.Dispatch<React.SetStateAction<boolean>>
  setAiTick: React.Dispatch<React.SetStateAction<number>>
  setTimeoutPopup: (val: { path: string; suggestedName: string } | null) => void
  flush: () => Promise<void>
  saveBufferSafe: (uuid: string, content: string) => void
}
```

**Return:**
```typescript
{ insertAiPlaceholder, replaceAiPlaceholder, resolvePathByUuid,
  applyAiResponseInBackground, touchAiLastEvaluated, explainGesture, askGesture, handleAskSend }
```

**Pre-conditions:** Tasks 1 and 2 complete. `lib/aiContextBuilder.ts` already done (Task B).

**⚠ Invariant:** Verify with `grep 'user_intent'` after extraction — `user_intent` must never be written by AI gesture code.

**Accept when:** Explain + Ask gestures produce correct AI responses; background application lands correctly when user has switched tabs during flight.

---

### Task 5 — `hooks/useBlobImageObserver.ts`

**Status:** `[ ]`
**Lines in App.tsx:** 2305–2438
**LOC:** ~135
**Risk:** Low-Medium — MutationObserver logic is self-contained; reads `activeTabRef` and `editor`

**What it owns:** WebKitGTK blob/data URL paste intercept — watches editor DOM for `<img>` elements with blob/data src, saves to disk via canvas, rewrites Tiptap node src to markdown-relative path.

**Params to hook:**
```typescript
{
  editor: Editor | null
  activeTabRef: React.MutableRefObject<TabState | undefined>
}
```

The hook imports `assetMarkdownPath` directly from `lib/fmUtils` — no need to pass it.

**Return:** `void` (hook is self-contained via internal `useEffect`)

**Pre-conditions:** Task 1 complete (imports `assetMarkdownPath` from `lib/fmUtils`).

**Accept when:** Pasting an image in WebKitGTK saves to disk and renders with markdown-relative path (not a blob: URL).

---

### Task 6 — `hooks/useAppLifecycle.ts`

**Status:** `[ ]`
**Lines in App.tsx:** 2441–2557
**LOC:** ~120
**Risk:** Low-Medium — close handler uses `flushRef` (not `flush`) to avoid stale closure

**What it owns:** Two self-contained lifecycle effects:
1. `app:closing` handler — flush all tabs, wait for AI jobs, then AppQuit
2. Focus count tracking — debounced 30s visit + 5min dwell interval

**Params to hook:**
```typescript
{
  activeIdx: number  // for focus count dep array
  tabs: TabState[]   // for focus count dep array
  tabsRef: React.MutableRefObject<TabState[]>
  activeTabRef: React.MutableRefObject<TabState | undefined>
  activeIdxRef: React.MutableRefObject<number>
  fmCache: React.MutableRefObject<Record<string, string>>
  savedBodyCache: React.MutableRefObject<Record<string, string>>
  mdCache: React.MutableRefObject<Record<string, string>>
  evaluatingUuids: React.MutableRefObject<Set<string>>
  pendingAiCount: React.MutableRefObject<number>
  cliTimeoutLongMs: React.MutableRefObject<number>
  flushRef: React.MutableRefObject<() => void>   // NOT flush directly — stale closure hazard
  focusTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
  saveBufferSafe: (uuid: string, content: string) => void
  persistSession: () => Promise<void>
  setPendingClose: React.Dispatch<React.SetStateAction<boolean>>
}
```

**⚠ Invariant:** The app:closing handler must use `flushRef.current()` not a closed-over `flush` — by the time the event fires, the closure would be stale.

**Return:** `void`

**Pre-conditions:** Task 1 complete (uses `bumpFocusCount` from fmUtils — imported directly in hook).

**Accept when:** Closing the app saves all tabs; AI jobs in-flight block quit and show dialog; focus count increments after 30s on a tab.

---

## Key Invariants

1. **`H.current` is always current** (line 2209) — `useLayoutEffect` with no dep array; runs every render. Keyboard handler reads ALL handlers through `H.current`, never closing over them. After hook extractions, assign returned handler functions into `H.current` in this useLayoutEffect.

2. **`useLayoutEffect`, not `useEffect`, for H.current** (line 2209) — synchronous before paint. Do not change.

3. **Bare ref sync in component body** (lines 280–285) — `tabsRef.current = tabs` etc. are plain assignments, not in effects. This is intentional. Do not move them.

4. **Pass refs as refs** — any extracted hook param that changes across renders must be passed as a `MutableRefObject`, not a plain value. Otherwise async callbacks get stale state.

5. **`queueMicrotask` on all `insertContent` calls** — all `editor.commands.insertContent` / `setContent` calls must be wrapped in `queueMicrotask`. Preserve in any hook that calls insertContent.

6. **Bootstrap sequence is immutable** (lines 850–910) — `GetStoreInfo → GetSession → loadTab` must stay sequential in App.tsx. Do not extract.

7. **`user_intent` is user-only** — AI gesture code must never write `user_intent`. Verify after Task 4: `grep "user_intent" frontend/src/hooks/useAiGestures.ts` must return 0 write sites.

8. **`flushRef` not `flush` in lifecycle** — The app:closing handler fires long after component render. Pass `flushRef` (the ref), not the `flush` closure.

---

## Hard Rules

1. Run `nix-shell --run "cd frontend && node_modules/.bin/tsc --noEmit"` after each task.
2. Commit after each task passes type-check — do not batch.
3. Do not push to origin.
4. Create `hooks/` directory when first needed (check if it exists first).
5. Import the extracted module back in App.tsx immediately — never leave dead code.
6. When wiring extracted handlers into `H.current`, update only the `useLayoutEffect` at line 2209 — do not create a second useLayoutEffect for this.
