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

## Task List (v2 — based on complete 2,946-line read)

| # | Task | Target | LOC | Risk | Status | Commit |
|---|---|---|---|---|---|---|
| 1 | FM utils | `lib/fmUtils.ts` | ~110 | Low | `[x]` | `f76fd78` |
| 2 | EditorStats component | `components/EditorStats.tsx` | ~34 | Low | `[x]` | `54b9bf0` |
| 3 | Note operations hook | `hooks/useNoteOperations.ts` | ~290 | Med | `[x]` | `3a4055e` |
| 4 | AI gestures hook | `hooks/useAiGestures.ts` | ~280 | Med | `[x]` | `57f3f0b` |
| 5 | Blob image observer hook | `hooks/useBlobImageObserver.ts` | ~135 | Low-Med | `[x]` | `58dfc25` |
| 6 | App lifecycle hook | `hooks/useAppLifecycle.ts` | ~120 | Low-Med | `[x]` | `4dfe9ef` |

**Actual LOC removed from App.tsx: ~913 (2,946 → 2,033)**

---

## Phase Ordering

```
Phase 1 (foundations, do first):  Tasks 1, 2
Phase 2 (hooks, any order):       Tasks 3, 4, 5, 6
```

---

## Task Detail

### Task 1 — `lib/fmUtils.ts`
**Status:** `[ ]`
**Lines:** 44–150
**Do:** Extract nine pure util functions: `assetMarkdownPath`, `getLocalISOString`, `versionFromFm`, `bumpFm`, `bumpFocusCount`, `parseMeta`, `applyFilingRec`, `setYamlField`, `getAncestorPaths`.
**Accept when:** `tsc --noEmit` passes; App.tsx imports all from `lib/fmUtils.ts`.

---

### Task 2 — `components/EditorStats.tsx`
**Status:** `[ ]`
**Lines:** 152–185
**Do:** Move `EditorStats` component to its own file. Import back in App.tsx.
**Accept when:** `tsc --noEmit` passes; stats display correctly in both modes.

---

### Task 3 — `hooks/useNoteOperations.ts`
**Status:** `[ ]`
**Lines:** 1635–1923
**Do:** Extract all note/folder CRUD handlers. Pass confirm/prompt modal setters, `flush`, `runBackgroundEval`, `selectTab`, and `H` ref as params. See v2 plan for full param signature.
**Accept when:** Open/delete/move/rename/folder ops all work via sidebar.

---

### Task 4 — `hooks/useAiGestures.ts`
**Status:** `[ ]`
**Lines:** 1925–2203
**Do:** Extract AI gesture handlers. Wire returned `explainGesture`/`askGesture` into `H.current` useLayoutEffect.
**⚠ Extra review:** After extraction, grep for `user_intent` in the new hook — must be zero write sites.
**Accept when:** Explain and Ask gestures produce correct AI responses; background apply works on tab-switch.

---

### Task 5 — `hooks/useBlobImageObserver.ts`
**Status:** `[ ]`
**Lines:** 2305–2438
**Do:** Extract WebKitGTK blob/data image observer. Hook imports `assetMarkdownPath` from `lib/fmUtils` directly.
**Accept when:** Pasting an image saves to disk and renders with markdown-relative path.

---

### Task 6 — `hooks/useAppLifecycle.ts`
**Status:** `[ ]`
**Lines:** 2441–2557
**Do:** Extract app closing handler + focus count tracking. Pass `flushRef` (the ref object), NOT `flush` (the closure). Import `bumpFocusCount` from `lib/fmUtils` directly.
**Accept when:** App close saves all tabs; focus_count increments after 30s.

---

## Notes

**Session 1 (2026-04-18):**
- Completed G and B (pre-v2 plan tasks)
- v1 plan abandoned — was based on ~380-line partial read
- First v2 draft also wrong — written by agent that hallucinated line ranges and structure
- This tracker updated after full 2,946-line read by Claude Code directly

**Session 2 (2026-04-18):**
- All 6 v2 tasks complete — App.tsx reduced from 2,946 → 2,033 lines (~31%)
- New files: lib/fmUtils.ts, components/EditorStats.tsx, hooks/useNoteOperations.ts,
  hooks/useAiGestures.ts, hooks/useBlobImageObserver.ts, hooks/useAppLifecycle.ts
- Remaining ~2,033 lines are load-bearing state machine (tab lifecycle, useEditor, bootstrap,
  flush/save machinery) — resist extraction without context-object rearchitecture
- Next step: context-object rearchitecture on a new branch (TabContext, EditorContext, etc.)
  to eliminate the long parameter lists that resulted from flat state in a monolithic component

**Key invariants (see v2 plan for full detail):**
- `H.current` pattern — update via `useLayoutEffect` (no dep array), read-only in keydown
- `tabsRef`/`activeIdxRef`/`tierRef` bare ref sync in component body — never move to effects
- `queueMicrotask` on all `editor.commands.insertContent` calls
- Bootstrap sequence (`GetStoreInfo → GetSession → loadTab`) stays in App.tsx unchanged
- Pass `flushRef` not `flush` to lifecycle hook
- `user_intent` must never be written by AI gesture code
