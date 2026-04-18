# App.tsx Refactor — Progress Tracker

Branch: `feature/js_tsx_refactor`
Plan: [refactor-app-tsx.md](refactor-app-tsx.md)
Started: 2026-04-18

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete (committed)

---

## Task List

| # | Task | File | Status | Commit |
|---|---|---|---|---|
| G | Image utils dedup | `lib/imageUtils.ts` | `[x]` | `refactor: extract mdSrcToStoreRelPath into lib/imageUtils` |
| B | AI context builder | `lib/aiContextBuilder.ts` | `[ ]` | — |
| F | Settings hook | `hooks/useSettings.ts` | `[ ]` | — |
| D | Persistence hook | `hooks/usePersistence.ts` | `[ ]` | — |
| C | Tabs hook | `hooks/useTabs.ts` | `[ ]` | — |
| A | AI orchestration hook | `hooks/useAiOrchestration.ts` | `[ ]` | — |
| E | Keyboard router hook | `hooks/useKeyboardRouter.ts` | `[ ]` | — |

---

## Task G — `lib/imageUtils.ts`

**Status:** `[x]` Complete

**Correction from initial plan:** The shared utility is `mdSrcToStoreRelPath(src, tabPath)` (lines 2056–2066),
not a `file://` stripper. It resolves markdown-relative image src values to store-relative paths,
filtering out `http`, `blob:`, and `data:` URLs. Used in 4 call sites — 3 inside
`collectChainImagePaths` (lines 2078, 2090, 2098) and 1 inline in `buildAiContext` (line 2316).
`buildAiContext` is also far more sophisticated than the initial partial-read analysis described —
it handles threading, conversation history chains, and block ref tagging.

**What to do:**
1. Create `frontend/src/lib/imageUtils.ts` exporting `mdSrcToStoreRelPath(src, tabPath)`
2. Import it in App.tsx; remove the inline function definition (lines 2054–2066)
3. Verify app builds

**Acceptance criteria:**
- `mdSrcToStoreRelPath` defined once in `lib/imageUtils.ts`
- All 4 call sites in App.tsx use the import
- App builds cleanly

---

## Task B — `lib/aiContextBuilder.ts`

**Status:** `[ ]` Not started

**What to do:**
1. Read App.tsx lines 903–1040 carefully
2. Create `frontend/src/lib/aiContextBuilder.ts`
3. Move `buildAiContext` as exported pure function; take `doc`, `triggerPos`, `mode`, `userPrompt`, `frontmatter` as params
4. Fix bug: image dedup — use `resolveLocalImagePath` from Task G
5. Fix bug: `orderedList` prefix should be `1.`, `2.` not `- `
6. Fix bug: replace `doc.forEach` with `doc.nodesBetween` and pos guard
7. Fix bug: `user_intent` appears twice in ask prompt — remove the duplicate
8. Replace `buildAiContext` call in App.tsx with import
9. Verify Ask and Explain gestures still work end-to-end

**Acceptance criteria:**
- All 5 bugs listed in plan are fixed
- Ask and Explain produce correct output
- No `buildAiContext` code remains in App.tsx

---

## Task F — `hooks/useSettings.ts`

**Status:** `[ ]` Not started

**What to do:**
1. Create `frontend/src/hooks/` directory
2. Identify all settings state and handlers in App.tsx
3. Create `hooks/useSettings.ts`
4. Move: `settings` state, `loadSettings`, `applySettings`, `toggleTheme`, font side effects
5. Wire return values back into App.tsx
6. Verify theme toggle and settings modal still work

**Acceptance criteria:**
- Settings state fully encapsulated in hook
- App.tsx imports and calls `useSettings()`, uses returned values

---

## Task D — `hooks/usePersistence.ts`

**Status:** `[ ]` Not started

**What to do:**
1. Identify save/autosave code in App.tsx
2. Create `hooks/usePersistence.ts`
3. Move: `saveCurrentNote`, debounce ref, 30s autosave effect, `lastSaved` state, frontmatter re-attachment
4. Accept `editor`, `activeTab`, `frontmatter` as params; return `{ lastSaved, saveNow, saveDebounced }`
5. Wire into App.tsx; confirm `useTabs` will receive `saveNow` as its `onBeforeClose` callback (Task C)
6. Verify autosave fires and dirty indicator clears

**Acceptance criteria:**
- Save/autosave fully in hook
- App.tsx has no save logic inline

---

## Task C — `hooks/useTabs.ts`

**Status:** `[ ]` Not started

**What to do:**
1. Identify all tab state and operations in App.tsx
2. Create `hooks/useTabs.ts`
3. Move: `tabs`, `activeIdx`, refs, all CRUD operations
4. Inject `onBeforeClose` callback (receives `saveNow` from `usePersistence`)
5. Wire return values into App.tsx
6. Test: open note, create note, close tab, duplicate tab, reorder tabs, dirty tracking

**Acceptance criteria:**
- All tab state in hook
- `closeTab` calls `onBeforeClose` before removing tab
- No tab management code inline in App.tsx

---

## Task A — `hooks/useAiOrchestration.ts`

**Status:** `[ ]` Not started

**What to do:**
1. Identify all AI runner code in App.tsx
2. Create `hooks/useAiOrchestration.ts`
3. Move: `runAsk`, `runExplain`, `runInlineEdit`, `pasteAiResult`, `streamingAiBlock` state
4. Import `buildAiContext` from Task B
5. Accept `editor`, `settings` as params; return `{ streamingAiBlock, runAsk, runExplain, runInlineEdit }`
6. Wire `streamingAiBlock` back into JSX conditional rendering
7. Test Ask and Explain end-to-end

**Acceptance criteria:**
- All AI runner logic in hook
- `streamingAiBlock` still drives loading UI correctly

---

## Task E — `hooks/useKeyboardRouter.ts`

**Status:** `[ ]` Not started

**What to do:**
1. Read `handleKeyDown` fully — list every action it dispatches
2. Define `KeyboardActions` interface with all action callbacks
3. Create `hooks/useKeyboardRouter.ts`
4. Move `handleKeyDown` and its `useEffect` registration
5. Wire all callbacks from other hooks (save, tabs, AI, settings, modals)
6. Test all keyboard shortcuts listed in HelpModal

**Acceptance criteria:**
- `handleKeyDown` fully in hook
- All shortcuts verified against HelpModal shortcut list
- No keyboard handler code inline in App.tsx

---

## Notes / Blockers

_(add session notes here as work progresses)_
