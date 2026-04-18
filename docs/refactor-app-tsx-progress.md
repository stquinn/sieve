# App.tsx Refactor — Progress Tracker

Branch: `feature/js_tsx_refactor`
Plan: [refactor-app-tsx-v2.md](refactor-app-tsx-v2.md)
Previous plan: [refactor-app-tsx.md](refactor-app-tsx.md) — abandoned (based on partial file read)
Started: 2026-04-18

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete (committed)
- `[!]` Blocked

---

## Already Done (pre-v2 plan)

| Task | File | Status | Commit |
|---|---|---|---|
| G | `lib/imageUtils.ts` — `mdSrcToStoreRelPath` | `[x]` | `2f5dca6` |
| B | `lib/aiContextBuilder.ts` + `lib/markdown.ts` | `[x]` | `48dfdc4` |

---

## Task List (v2 — full-file plan)

| # | Task | Target | LOC | Risk | Status | Commit |
|---|---|---|---|---|---|---|
| 1 | Types | `lib/appTypes.ts` | ~88 | Low | `[ ]` | — |
| 2 | Constants | `lib/appConstants.ts` | ~83 | Low | `[ ]` | — |
| 3 | Settings hook | `hooks/useSettings.ts` | ~160 | Low | `[ ]` | — |
| 4 | Tier hook | `hooks/useTier.ts` | ~160 | Low | `[ ]` | — |
| 5 | Image handler hook | `hooks/useImageHandler.ts` | ~170 | Med | `[ ]` | — |
| 6 | AI operations hook | `hooks/useAiOperations.ts` | ~150 | Med | `[ ]` | — |
| 7 | Tab manager hook | `hooks/useTabManager.ts` | ~150 | Med | `[ ]` | — |
| 8 | Autosave hook | `hooks/useAutosave.ts` | ~210 | HIGH | `[ ]` | — |
| 9 | Keyboard handler hook | `hooks/useKeyboardHandler.ts` | ~430 | HIGH | `[ ]` | — |
| 10 | FileTree component | `components/FileTree.tsx` | ~180 | Med | `[ ]` | — |
| 11 | TabBar component | `components/TabBar.tsx` | ~130 | Low | `[ ]` | — |
| 12 | EditorToolbar component | `components/EditorToolbar.tsx` | ~250 | Low | `[ ]` | — |
| 13 | AppModals component | `components/AppModals.tsx` | ~290 | Low | `[ ]` | — |

**Projected total LOC removed from App.tsx: ~2,451**
**Projected final App.tsx size: 350–420 lines**

---

## Phase Ordering

```
Phase 1 (foundations, do first):     Tasks 1, 2
Phase 2 (low-risk hooks):            Tasks 3, 4
Phase 3 (medium-risk hooks):         Tasks 5, 6, 7
Phase 4 (UI components, parallel):   Tasks 10, 11, 12, 13
Phase 5 (HIGH-risk, do last):        Tasks 8, 9
```

---

## Task Detail

### Task 1 — `lib/appTypes.ts`
**Status:** `[ ]`
**Lines:** 98–185
**Do:** Extract all TypeScript type/interface declarations to a shared lib file.
Import them back in App.tsx.
**Accept when:** `tsc --noEmit` passes, App.tsx imports all types from `lib/appTypes.ts`.

---

### Task 2 — `lib/appConstants.ts`
**Status:** `[ ]`
**Lines:** 186–268
**Do:** Extract `DEFAULT_SETTINGS`, `SHORTCUTS`, `makeTab`, `makeTabId`.
**Accept when:** `tsc --noEmit` passes, no inline constant definitions remain at those lines.

---

### Task 3 — `hooks/useSettings.ts`
**Status:** `[ ]`
**Lines:** 1431–1590
**Do:** Extract `loadSettings`, `saveSettings`, `handleSettingsChange` and their local state.
Accept `setStatusMsg` as callback param; use `DEFAULT_SETTINGS` from Task 2.
**Accept when:** Settings modal still works end-to-end.

---

### Task 4 — `hooks/useTier.ts`
**Status:** `[ ]`
**Lines:** 1591–1750
**Do:** Extract `checkTier`, `handleBuyPremium`, `handleRestorePurchase`, `handleTierModalClose`
and their state. Pass `tierRef` as a ref object (not a value).
**Accept when:** Tier modal opens/closes; purchase/restore flows compile.

---

### Task 5 — `hooks/useImageHandler.ts`
**Status:** `[ ]`
**Lines:** 1111–1280
**Do:** Extract image I/O functions. Expose `insertImageIntoEditor` in return so App.tsx can
assign it to `H.current`. Preserve `queueMicrotask` wrapping on all `insertContent` calls.
**Accept when:** Image drag-drop and paste still save to disk and render correctly.

---

### Task 6 — `hooks/useAiOperations.ts`
**Status:** `[ ]`
**Lines:** 1281–1430
**Do:** Extract `runAskAi`, `runExplainAi`. Expose in return for `H.current` assignment.
Verify `user_intent` is never written.
**Accept when:** Ask and Explain gestures produce correct AI responses.

---

### Task 7 — `hooks/useTabManager.ts`
**Status:** `[ ]`
**Lines:** 851–1000
**Do:** Extract tab lifecycle functions. Pass `tabsRef`/`activeIdxRef` as ref objects.
Pass `loadTab`/`saveCurrentTab` as callbacks. Pass confirm-dialog state as params.
**Accept when:** Close tab, reorder, move left/right all work correctly.

---

### Task 8 — `hooks/useAutosave.ts` — HIGH RISK
**Status:** `[ ]`
**Lines:** 1751–1960
**Do:** Extract autosave timer. Hold `saveCurrentTab` in an internal `useRef` updated each
render — NEVER pass it directly to `setInterval` (stale closure hazard).
**Accept when:** Notes save automatically at configured interval; dirty indicator clears.
**⚠ Extra review:** After extraction, deliberately edit a note, wait for autosave, verify
content persists to disk.

---

### Task 9 — `hooks/useKeyboardHandler.ts` — HIGH RISK
**Status:** `[ ]`
**Lines:** 431–518 (useLayoutEffect ref sync) + 1961–2390 (handleKeyDown + effects)
**Do:** Extract `H.current` ref, `useLayoutEffect` sync, `handleKeyDown`, DOM listener,
Wails `EventsOn` file-open listener. Accept all handler callbacks as params.
`useLayoutEffect` must remain (not converted to `useEffect`).
**Accept when:** All keyboard shortcuts in HelpModal work correctly.
**⚠ Extra review:** Test every shortcut listed in `HelpModal.tsx` SHORTCUTS constant.

---

### Task 10 — `components/FileTree.tsx`
**Status:** `[ ]`
**Lines:** 2391–2570
**Do:** Extract file list sidebar JSX. Decide whether drag state stays in App.tsx (prop-drilled)
or moves into the component.
**Accept when:** File list renders, open/rename/delete work, drag reorder works.

---

### Task 11 — `components/TabBar.tsx`
**Status:** `[ ]`
**Lines:** 2820–2950
**Do:** Extract tab strip JSX.
**Accept when:** Tabs render, clicking switches tabs, close button works, new tab button works.

---

### Task 12 — `components/EditorToolbar.tsx`
**Status:** `[ ]`
**Lines:** 2571–2820
**Do:** Extract toolbar JSX. Pass editor, handler callbacks, and state as props.
**Accept when:** All toolbar buttons function correctly.

---

### Task 13 — `components/AppModals.tsx`
**Status:** `[ ]`
**Lines:** 2950–3237
**Do:** Extract all modal/dialog JSX into a single modal layer component.
**Accept when:** All modals open/close correctly; settings save; purchase flow compiles.

---

## Notes

**Session 1 (2026-04-18):**
- Completed G and B (pre-v2 plan tasks)
- v1 plan abandoned — was based on ~380-line partial read
- v2 plan written from complete 3,237-line read
- `hooks/` directory does not yet exist — create it for Tasks 3–9

**Key invariants (see v2 plan for full detail):**
- `H.current` pattern — update via `useLayoutEffect`, read-only in keydown
- `tabsRef`/`activeIdxRef` in async callbacks — always use refs, not state values
- `queueMicrotask` on all `editor.commands.insertContent` calls
- Bootstrap sequence (`GetStoreInfo → GetSession → loadTab`) stays in App.tsx unchanged
- Autosave `saveCurrentTab` must be held in a ref inside useAutosave, not closed over
- Frontmatter strip (`loadTab`) and prepend (`saveCurrentTab`) are a pair — extract together
