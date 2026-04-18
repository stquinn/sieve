# App.tsx Refactor — Progress Tracker

Branch: `feature/js_tsx_refactor`
Plan: [refactor-app-tsx.md](refactor-app-tsx.md) — **ABANDONED** (based on partial file read)
New plan: [refactor-app-tsx-v2.md](refactor-app-tsx-v2.md) — full-file analysis, in progress
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
| B | AI context builder | `lib/aiContextBuilder.ts` | `[x]` | `refactor: extract buildAiContext and markdown utils into lib/` |
| F | Settings hook | `hooks/useSettings.ts` | `[!]` | — |
| D | Persistence hook | `hooks/usePersistence.ts` | `[!]` | — |
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

**Status:** `[x]` Complete — also extracted `splitFrontmatter`/`getCleanMarkdown` into `lib/markdown.ts`

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

**Status:** `[!]` Blocked — re-assess before starting

**Note from code review:** The bootstrap `useEffect` (lines ~850–910) chains `GetStoreInfo` →
`GetSession` → `loadTab` sequentially. Session restore includes tab state and active index —
not just settings. Extracting "settings" without breaking tab restore requires carefully
threading the `loadTab` callback into the hook. Risk is **Medium-High**, not Low as initially
estimated. Recommend tackling after Task C (useTabs) when the tab-restore boundary is clear.

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

**Status:** `[!]` Blocked — re-assess before starting

**Note from code review:** `SaveBuffer` is called from 20+ locations throughout App.tsx —
AI response handlers, filing flows, meta updates, rename callbacks, etc. The `saveBufferSafe`
wrapper is the ambient save path, but the many direct `SaveBuffer` calls are in domain-specific
flows that would each need to import the hook. Risk is **Medium-High**. Recommend tackling
after Task C when tab state boundaries are clearer.

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

**Status:** `[ ]` Not started — revised scope needed

**Note from code review:** `explainGesture`, `askGesture`, `handleAskSend` are ~90 lines, but
depend on `insertAiPlaceholder`, `replaceAiPlaceholder`, `applyAiResponseInBackground`,
`touchAiLastEvaluated` — each of which uses deep editor + React state. Extracting cleanly
requires either:
- A grouped params interface (2 objects: `AiGestureContext` + `AiGestureCallbacks`)
- Or first moving `insertAiPlaceholder`/`replaceAiPlaceholder` to `AiBlock.addCommands()`
  (already noted in MEMORY.md — do this first)

**Recommended pre-step:** Move `insertAiPlaceholder`/`replaceAiPlaceholder` into `AiBlock.tsx`
`addCommands()`. Then the gesture functions only need `editor`, `tier`, and a few refs.

**What to do:**
1. Move `insertAiPlaceholder`/`replaceAiPlaceholder` to `AiBlock.addCommands()` — but note
   `insertAiPlaceholder` uses `isMarkdownMode`, `fmCache`, `activeTabRef`, `setRawMd` which
   are React state. The markdown-mode update portion must stay in the gesture caller.
2. Design `AiGestureContext` and `AiGestureCallbacks` interfaces
3. Create `hooks/useAiOrchestration.ts`
4. Wire back into App.tsx

---

## Task E — `hooks/useKeyboardRouter.ts`

**Status:** `[ ]` Not started — low priority, low value

**Note from code review:** The keyboard handler (lines ~2236–2270) is already only ~30 lines.
It fully delegates to `H.current` (for tab/AI actions) or calls `setState` setters directly
(for modal toggles). The `H.current` ref pattern already provides the decoupling that a
`useKeyboardRouter` hook would provide. This task delivers minimal LOC reduction.

**Recommendation:** Skip or defer. Revisit only if the keyboard handler grows significantly.

---

## Notes / Blockers

**Session 1 (2026-04-18):** Completed G and B. F and D are harder than the initial plan
estimated (based on a partial file read of only ~380 lines out of 3,237). The real code has:
- Settings/session bootstrap chains `GetStoreInfo → GetSession → loadTab` sequentially
- `SaveBuffer` called from 20+ locations — not a single centralised persistence path
- Keyboard handler already clean via `H.current` delegation
- AI gestures need `insertAiPlaceholder`/`replaceAiPlaceholder` moved to AiBlock first

**Next session entry point:** Start with Task A pre-step — move `insertAiPlaceholder` and
`replaceAiPlaceholder` into `AiBlock.addCommands()` (per existing MEMORY.md note). Then
reassess Task A extraction with the simpler dependencies.
