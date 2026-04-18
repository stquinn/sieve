# App.tsx Refactor Plan — v2

Based on a complete read of all 3,237 lines. Supersedes refactor-app-tsx.md.

Branch: `feature/js_tsx_refactor`
Analysis date: 2026-04-18

---

## Already Done (pre-existing on this branch)

| File | What | Commit |
|---|---|---|
| `lib/imageUtils.ts` | `mdSrcToStoreRelPath` — deduped path resolver | `2f5dca6` |
| `lib/aiContextBuilder.ts` | `buildAiContext`, `collectChainImagePaths` | `48dfdc4` |
| `lib/markdown.ts` | `splitFrontmatter`, `getCleanMarkdown` | `48dfdc4` |

---

## File Map (what actually lives where in App.tsx)

| Lines | Content |
|---|---|
| 1–97 | Imports |
| 98–185 | Type definitions: `Tab`, `Handlers`, `FileEntry`, `SearchResult`, `AiModel`, `TierInfo`, `Settings` |
| 186–268 | Module-level constants and helpers: `DEFAULT_SETTINGS`, `SHORTCUTS`, `makeTab`, `makeTabId` |
| 269–358 | `useState` declarations |
| 359–430 | `useRef` declarations (`H`, `tabsRef`, `activeIdxRef`, `tierRef`, `autosaveIntervalRef`, etc.) |
| 431–518 | `useLayoutEffect` — ref sync block (syncs all refs + assigns `H.current`) |
| 519–654 | Bootstrap `useEffect`: `GetStoreInfo → GetSession → loadTab` |
| 655–745 | Tab I/O: `loadTab`, `saveCurrentTab` |
| 746–850 | File ops: `handleNewNote`, `handleOpenFile`, `handleRenameFile`, `handleDeleteFile` |
| 851–1000 | Tab ops: `handleCloseTab`, `handleTabClick`, `handleTabReorder`, `handleMoveTabLeft/Right` |
| 1001–1110 | Search: `handleSearch`, `openOrFocusTab`, `handleSearchSelect` |
| 1111–1280 | Image I/O: `handleImageDrop`, `handleImagePaste`, `handleImageUpload`, `insertImageIntoEditor` |
| 1281–1430 | AI: `runAskAi`, `runExplainAi`, `buildPrompt`, `insertAiResult` |
| 1431–1590 | Settings: `loadSettings`, `saveSettings`, `handleSettingsChange` |
| 1591–1750 | Tier/billing: `checkTier`, `handleBuyPremium`, `handleRestorePurchase`, `handleTierModalClose` |
| 1751–1960 | Autosave: `startAutosave`, `stopAutosave`, lifecycle `useEffect` |
| 1961–2390 | Keyboard: `handleKeyDown` + `useEffect` registration + Wails event listeners |
| 2391–2570 | JSX: editor area, toolbar, status bar, tab bar |
| 2571–2820 | JSX: `SearchDialog`, `HelpModal`, `SettingsModal` |
| 2821–3050 | JSX: `TierModal`, `ConfirmDialog`, AI result rendering |
| 3051–3237 | JSX: `CommandPalette`, remaining dialogs, `export default App` |

---

## Extractions (13 total)

### Task 1 — `lib/appTypes.ts`
**Lines moved:** 98–185
**What it owns:** All shared TypeScript types (`Tab`, `Handlers`, `FileEntry`, `SearchResult`, `AiModel`, `TierInfo`, `Settings`)
**Dependencies:** None — pure type declarations
**Interface:** Named exports, imported by App.tsx and all new hooks
**LOC moved:** ~88
**Risk:** Low — no runtime code, zero behavior change possible
**Pre-conditions:** None. Do this first — it unblocks every other extraction.

---

### Task 2 — `lib/appConstants.ts`
**Lines moved:** 186–268
**What it owns:** Module-level constants and pure factory functions: `DEFAULT_SETTINGS`, `SHORTCUTS`, `makeTab`, `makeTabId`
**Dependencies:** Types from Task 1
**Interface:** Named exports
**LOC moved:** ~83
**Risk:** Low — pure constants and functions, no state or side effects
**Pre-conditions:** Task 1

---

### Task 3 — `hooks/useSettings.ts`
**Lines moved:** 1431–1590
**What it owns:** Settings load/save lifecycle and `handleSettingsChange`
**Dependencies:**
- `settings` state + `setSettings`
- `setStatusMsg`
- Wails: `LoadSettings`, `SaveSettings`
- `DEFAULT_SETTINGS` from Task 2
**Interface:** `{ settings, loadSettings, saveSettings, handleSettingsChange }`
**LOC moved:** ~160
**Risk:** Low — no ref dependencies, no async closure complexity, no H.current usage
**Pre-conditions:** Tasks 1, 2

---

### Task 4 — `hooks/useTier.ts`
**Lines moved:** 1591–1750
**What it owns:** Tier/billing state — check, purchase, restore, modal close
**Dependencies:**
- `tierInfo` state + `setTierInfo`
- `tierRef` (passed as a ref object, not a value)
- `tierModalOpen` state + `setTierModalOpen`
- `setStatusMsg`
- Wails: `GetTierInfo`, `BuyPremium`, `RestorePurchase`
**Interface:** `{ tierInfo, tierModalOpen, setTierModalOpen, checkTier, handleBuyPremium, handleRestorePurchase, handleTierModalClose }`
**LOC moved:** ~160
**Risk:** Low — no complex async closure, tierRef is passed as a stable ref object
**Pre-conditions:** Task 1

---

### Task 5 — `hooks/useImageHandler.ts`
**Lines moved:** 1111–1280
**What it owns:** All image file I/O — drag-drop, clipboard paste, file-picker upload, editor insertion
**Dependencies:**
- `editor` ref (TipTap instance)
- `tabsRef` / `activeIdxRef`
- `tierRef`
- `setTierModalOpen`
- `setStatusMsg`
- Wails: `SaveImageToNote`, `GetImageAsBase64`
- `mdSrcToStoreRelPath` from `lib/imageUtils.ts`
**Interface:** `{ handleImageDrop, handleImagePaste, handleImageUpload, insertImageIntoEditor }`
**LOC moved:** ~170
**Risk:** Medium — `insertImageIntoEditor` is wired into `H.current`; the hook return value must be assigned in the `useLayoutEffect` ref sync block. Uses `queueMicrotask` — must be preserved.
**Pre-conditions:** Tasks 1, 2, 4

---

### Task 6 — `hooks/useAiOperations.ts`
**Lines moved:** 1281–1430
**What it owns:** AI ask/explain operations — prompt construction, CLI invocation, result insertion
**Dependencies:**
- `editor` ref
- `tabsRef` / `activeIdxRef`
- `tierRef`
- `setTierModalOpen`
- `setStatusMsg`
- `setAiRunning`
- Wails: `RunCLI` or `RunCLIWithImages`
- `buildAiContext`, `collectChainImagePaths` from `lib/aiContextBuilder.ts`
- `getCleanMarkdown` from `lib/markdown.ts`
**Interface:** `{ runAskAi, runExplainAi }`
**LOC moved:** ~150
**Risk:** Medium — `runAskAi`/`runExplainAi` wired into `H.current`; same constraint as Task 5
**Pre-conditions:** Tasks 1, 2, 4. `aiContextBuilder.ts` and `markdown.ts` already done.

---

### Task 7 — `hooks/useTabManager.ts`
**Lines moved:** 851–1000
**What it owns:** Tab lifecycle — close, click-to-focus, reorder, move left/right
**Dependencies:**
- `tabs` state + `setTabs`
- `activeIdx` state + `setActiveIdx`
- `tabsRef` / `activeIdxRef` (passed as refs, not values)
- `loadTab` callback
- `saveCurrentTab` callback
- Wails: `DeleteNote`
- Confirm dialog state: `confirmOpen`/`setConfirmOpen`, `confirmMsg`/`setConfirmMsg`, `confirmAction`/`setConfirmAction`
**Interface:** `{ handleCloseTab, handleTabClick, handleTabReorder, handleMoveTabLeft, handleMoveTabRight }`
**LOC moved:** ~150
**Risk:** Medium — reads `tabsRef`/`activeIdxRef` directly in async closures; refs must be passed as ref objects, not values. Confirm-dialog state coupling adds surface area.
**Pre-conditions:** Tasks 1, 2

---

### Task 8 — `hooks/useAutosave.ts`
**Lines moved:** 1751–1960
**What it owns:** Autosave timer — start, stop, and lifecycle tied to settings interval
**Dependencies:**
- `autosaveIntervalRef`
- `saveCurrentTab` callback (held in a ref inside the hook — same pattern as `H.current`)
- `settings.autosave_interval`
- `editorRef` (checks editor readiness before saving)
**Interface:** `{ startAutosave, stopAutosave }` — lifecycle `useEffect` internal to hook
**LOC moved:** ~210
**Risk:** HIGH — core reliability mechanism. If `saveCurrentTab` reference goes stale inside the interval, notes silently fail to save. The hook MUST hold `saveCurrentTab` in a `useRef` updated each render, not close over it. Do not extract until Tasks 3–7 are complete and `saveCurrentTab` is stable.
**Pre-conditions:** Tasks 1–7. `saveCurrentTab` must be finalized first.

---

### Task 9 — `hooks/useKeyboardHandler.ts`
**Lines moved:** 431–518 (useLayoutEffect ref sync) + 1961–2390 (handleKeyDown + useEffect)
**What it owns:** The stable keyboard dispatch system — `H.current` ref, `useLayoutEffect` sync, `handleKeyDown`, DOM event listener lifecycle, Wails `EventsOn` file-open listener
**Dependencies (everything that goes into H.current):**
- `loadTab`, `saveCurrentTab`
- `handleNewNote`, `handleCloseTab`, `handleTabClick`
- `handleMoveTabLeft`, `handleMoveTabRight`
- `runAskAi`, `runExplainAi`
- `insertImageIntoEditor`
- `handleSearch`
- `setHelpOpen`, `setSettingsOpen`, `setCommandPaletteOpen`
- `editor` ref
- `tabs`, `activeIdx`, `tabsRef`, `activeIdxRef`, `tierRef`
- All modal open/close state flags
**Interface:** `{ H }` — the stable handler ref. All `useLayoutEffect` and `useEffect` blocks are internal.
**LOC moved:** ~430
**Risk:** HIGH — most coupled piece in the file. `H.current` must be updated via `useLayoutEffect` (not `useEffect`) every render. `handleKeyDown` reads only through `H.current`. `EventsOn` cleanup must be returned from the internal `useEffect`. See invariants section.
**Pre-conditions:** ALL of Tasks 1–8. This is the aggregation point for every extracted handler.

---

### Task 10 — `components/FileTree.tsx`
**Lines moved:** 2391–2570
**What it owns:** Sidebar file list UI — renders `fileEntries` with drag handles, rename, delete icons
**Dependencies (as props):**
- `fileEntries`, `activeIdx`, `tabs`
- `handleOpenFile`, `handleRenameFile`, `handleDeleteFile`, `handleTabClick`
- `dragOver`/`setDragOver`, `draggingIdx`/`setDraggingIdx`, `onDragStart`, `onDrop`
**LOC moved:** ~180
**Risk:** Medium — drag state (`dragOver`, `draggingIdx`) currently lives in App.tsx; either stays there and is prop-drilled, or moves into the component. No async risk.
**Pre-conditions:** Tasks 1, 2, 7

---

### Task 11 — `components/TabBar.tsx`
**Lines moved:** 2820–2950
**What it owns:** Horizontal tab strip UI
**Dependencies (as props):**
- `tabs`, `activeIdx`
- `handleTabClick`, `handleCloseTab`, `handleNewNote`, `handleTabReorder`
**LOC moved:** ~130
**Risk:** Low — pure UI, no async code
**Pre-conditions:** Tasks 1, 7

---

### Task 12 — `components/EditorToolbar.tsx`
**Lines moved:** 2571–2820
**What it owns:** Formatting toolbar UI above the editor
**Dependencies (as props):**
- `editor`
- `handleImageUpload`, `runAskAi`, `runExplainAi`
- `aiRunning`, `selectedModel`/`setSelectedModel`
- `tierRef`, `settings`
**LOC moved:** ~250
**Risk:** Low — purely presentational, no async complexity, no ref invariants
**Pre-conditions:** Tasks 1, 5, 6

---

### Task 13 — `components/AppModals.tsx`
**Lines moved:** 2950–3237
**What it owns:** All modal/dialog overlays: `SearchDialog`, `HelpModal`, `SettingsModal`, `TierModal`, `ConfirmDialog`, `CommandPalette`
**Dependencies (as props):**
- All modal open/close flags and setters
- `handleSearchSelect`, `handleSettingsChange`
- `handleBuyPremium`, `handleRestorePurchase`, `handleTierModalClose`
- `confirmMsg`, `confirmAction`
- `settings`, `tierInfo`, `tabs`
**LOC moved:** ~290
**Risk:** Low — pure JSX rendering, no lifecycle or async risk
**Pre-conditions:** Tasks 3, 4

---

## Sequenced Task List

```
Phase 1 — Zero-risk foundations
  Task 1   lib/appTypes.ts          88 LOC   Risk: Low    Pre: none
  Task 2   lib/appConstants.ts      83 LOC   Risk: Low    Pre: 1

Phase 2 — Low-risk hooks (can be done in any order after Phase 1)
  Task 3   hooks/useSettings.ts    160 LOC   Risk: Low    Pre: 1,2
  Task 4   hooks/useTier.ts        160 LOC   Risk: Low    Pre: 1

Phase 3 — Medium-risk hooks
  Task 5   hooks/useImageHandler   170 LOC   Risk: Med    Pre: 1,2,4
  Task 6   hooks/useAiOperations   150 LOC   Risk: Med    Pre: 1,2,4
  Task 7   hooks/useTabManager     150 LOC   Risk: Med    Pre: 1,2

Phase 4 — UI components (can run in parallel with Phase 3)
  Task 10  components/FileTree     180 LOC   Risk: Med    Pre: 1,2,7
  Task 11  components/TabBar       130 LOC   Risk: Low    Pre: 1,7
  Task 12  components/EditorToolbar 250 LOC  Risk: Low    Pre: 1,5,6
  Task 13  components/AppModals    290 LOC   Risk: Low    Pre: 3,4

Phase 5 — HIGH-risk, do last
  Task 8   hooks/useAutosave       210 LOC   Risk: HIGH   Pre: 1-7
  Task 9   hooks/useKeyboardHandler 430 LOC  Risk: HIGH   Pre: 1-8
```

---

## End-State Estimate

| Category | LOC removed |
|---|---|
| Types + constants (Tasks 1–2) | ~171 |
| Hooks (Tasks 3–9) | ~1,430 |
| UI components (Tasks 10–13) | ~850 |
| **Total removed** | **~2,451** |

**Projected App.tsx after all extractions: 350–420 lines**
(~80 imports, ~90 shared state/ref declarations, ~80 hook calls, ~100 JSX glue)

---

## Invariants the Next Engineer Must Preserve

**1. `H.current` ref — CRITICAL**
`H` is declared as `useRef<Handlers>`. Every handler is assigned to `H.current` inside a
`useLayoutEffect` with no dependency array (runs every render). `handleKeyDown` reads all
handlers through `H.current` only — never closing over them directly. When extracting hooks,
expose handler return values so `useLayoutEffect` can assign them into `H.current`. This
invariant is what prevents stale-closure bugs in the keyboard handler.

**2. `useLayoutEffect` for ref sync, never `useEffect`**
The sync at lines 431–518 uses `useLayoutEffect`. This is synchronous before paint —
guaranteeing the keyboard handler sees current state before any user input. Changing to
`useEffect` introduces a one-frame stale window.

**3. Refs for async callbacks, not state values**
`tabsRef`, `activeIdxRef`, `tierRef` are always current. Any async callback (Wails calls,
setTimeout, EventsOn) must read from `xyzRef.current`, not closed-over state values. Pass
these as ref objects to extracted hooks.

**4. `queueMicrotask` for TipTap content insertion**
`editor.commands.insertContent(...)` must be deferred via `queueMicrotask` to avoid the
React `flushSync` warning. Preserve this in any hook that calls insertContent.

**5. Bootstrap sequence is immutable**
`GetStoreInfo → GetSession → loadTab` at lines 519–654 has data dependencies and must stay
in App.tsx. Do not attempt to extract it.

**6. Autosave stale-closure — use a ref**
`startAutosave` sets `setInterval` calling `saveCurrentTab`. When extracted to a hook,
hold `saveCurrentTab` in a `useRef` inside the hook updated each render — identical to the
`H.current` pattern. Never pass `saveCurrentTab` as a plain closure to `setInterval`.

**7. `user_intent` is never written by AI**
`runAskAi`/`runExplainAi` must never set `user_intent` in frontmatter. Already enforced in
`aiContextBuilder.ts`. Verify after Task 6 extraction.

**8. Frontmatter strip/prepend cycle**
`loadTab` strips frontmatter before passing to TipTap. `saveCurrentTab` re-prepends it.
These two must remain paired — extract them into the same hook (they are adjacent at lines
655–745 and should move together).

**9. Image src rewriting**
Inside `loadTab`, image `src` attrs are rewritten from store-relative paths to display URLs.
`saveCurrentTab` reverses this. Paired — must not be separated across extraction boundaries.

**10. Wails `EventsOn` cleanup**
`EventsOn` calls in lines 2300–2390 must have matching `EventsOff` in the `useEffect`
cleanup return. When extracted, the cleanup must be inside the hook's `useEffect` return.
