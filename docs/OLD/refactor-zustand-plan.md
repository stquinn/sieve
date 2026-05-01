# Zustand Store Migration Plan

Branch: `feature/zustand-stores` (off `feature/js_tsx_refactor`)
Prerequisite: All 6 v2 refactor tasks complete (App.tsx at ~2,033 lines)

## Motivation

App.tsx manages state through ~35 `useState`/`useRef` declarations, with many refs serving as
"shadow copies" of state values to prevent stale closures in async callbacks. This forces every
extracted hook to accept 15-22 parameters. Zustand's `getState()` always returns current state —
no shadow refs needed, no stale closures, no long parameter lists.

---

## Three Stores

### `stores/tabStore.ts` — Document identity and content

```typescript
interface TabStore {
  // React state (drives re-renders)
  tabs: TabState[]
  activeIdx: number

  // Caches (no re-renders — mutate directly via getState())
  fmCache: Record<string, string>        // frontmatter per uuid
  mdCache: Record<string, string>        // raw markdown per uuid (markdown mode only)
  savedBodyCache: Record<string, string> // clean WYSIWYG body per uuid
  uuidToPath: Map<string, string>        // permanent uuid → current file path

  // Actions
  setTabs: (tabs: TabState[] | ((prev: TabState[]) => TabState[])) => void
  setActiveIdx: (idx: number) => void
}
```

**Eliminates:** `tabs`, `setTabs`, `activeIdx`, `setActiveIdx`, `tabsRef`, `activeIdxRef`,
`fmCache`, `mdCache`, `savedBodyCache`, `uuidToPath` + 4 shadow-ref sync effects.

**Key insight:** `tabStore.getState().tabs` is always current — async callbacks call `getState()`
instead of reading a ref. Shadow refs (`tabsRef`, `activeIdxRef`) become unnecessary.

---

### `stores/uiStore.ts` — Layout and UI toggles

```typescript
interface UIStore {
  // Panel toggles
  showHelp: boolean
  showSidebar: boolean
  showMeta: boolean
  showPrompts: boolean
  showSearch: boolean
  showQuickSwitch: boolean
  showAskPopup: boolean
  pendingClose: boolean
  ready: boolean

  // Sidebar / content
  sidebarMode: 'files' | 'search'
  notes: NoteEntry[]
  prompts: PromptEntry[]
  openFolders: Set<string>
  storeInfo: { root: string; themeName: string } | null
  timeoutPopup: { path: string; suggestedName: string } | null
  confirmModal: ConfirmModalState | null
  promptModal: PromptModalState | null

  // Editor
  rawMd: string
  linkUrl: string
  searchTerm: string
  searchResults: { from: number; to: number }[]
  searchIndex: number

  // Layout dimensions (numbers only — no shadow refs needed)
  sidebarWidth: number
  metaWidth: number
  promptsHeight: number
  isDragging: boolean
  isMetaDragging: boolean

  // Settings (previously refs — no re-renders needed, read via getState())
  autosaveMs: number
  cliTimeoutLongMs: number

  // Actions (setters omitted for brevity — one per field above)
  setShowHelp: (v: boolean) => void
  setShowSidebar: (v: boolean) => void
  // ... etc
}
```

**Eliminates:** `showSidebar`/`showMeta`/`showPrompts` state + matching `showSidebarRef` /
`showMetaRef` / `showPromptsRef` + 3 sync effects. `sidebarWidthRef`/`metaWidthRef`/
`promptsHeightRef` also removed — mouseup handlers call `getState()` instead. `autosaveMs` and
`cliTimeoutLongMs` move from `useRef` to plain store fields (no re-renders, just `getState()` reads).

---

### `stores/aiStore.ts` — AI job tracking

```typescript
interface AIStore {
  tier: 'dumb' | 'smart'
  aiTick: number  // increments every second while jobs run — drives tab bar spinner

  // Mutable job state (no re-renders — mutate via getState())
  evaluatingUuids: Set<string>
  pendingAiCount: number
  evalStartTimes: Record<string, number>
  askContext: AiContext | null

  // Actions
  setTier: (t: 'dumb' | 'smart') => void
  setAiTick: (v: number | ((prev: number) => number)) => void
}
```

**Eliminates:** `tier`/`tierRef`, `evaluatingUuids`, `pendingAiCount`, `evalStartTimes`,
`askContextRef`, `aiTick`. The `tierRef` shadow ref and async callbacks that read it are
replaced by `aiStore.getState().tier`.

---

## Migration Table

| useState / useRef | Store | Notes |
|---|---|---|
| `tabs` / `setTabs` | tabStore | |
| `activeIdx` / `setActiveIdx` | tabStore | |
| `tabsRef` | tabStore | getState() replaces it |
| `activeIdxRef` | tabStore | getState() replaces it |
| `fmCache` | tabStore | mutate directly, no setters |
| `mdCache` | tabStore | mutate directly |
| `savedBodyCache` | tabStore | mutate directly |
| `uuidToPath` | tabStore | mutate directly |
| `tier` / `setTier` | aiStore | |
| `tierRef` | aiStore | getState() replaces it |
| `evaluatingUuids` | aiStore | mutate directly |
| `pendingAiCount` | aiStore | mutate directly |
| `evalStartTimes` | aiStore | mutate directly |
| `askContextRef` | aiStore | becomes `askContext` field |
| `aiTick` / `setAiTick` | aiStore | |
| `showHelp` / `showSidebar` / `showMeta` / `showPrompts` | uiStore | |
| `showSidebarRef` / `showMetaRef` / `showPromptsRef` | uiStore | getState() replaces them |
| `sidebarWidth` / `metaWidth` / `promptsHeight` | uiStore | |
| `sidebarWidthRef` / `metaWidthRef` / `promptsHeightRef` | uiStore | getState() replaces them |
| `isDragging` / `isMetaDragging` | uiStore | |
| `showSearch` / `showQuickSwitch` / `showAskPopup` | uiStore | |
| `pendingClose` | uiStore | |
| `sidebarMode` | uiStore | |
| `confirmModal` / `promptModal` | uiStore | |
| `searchTerm` / `searchResults` / `searchIndex` | uiStore | |
| `notes` / `prompts` | uiStore | |
| `openFolders` / `openFoldersRef` | uiStore | |
| `timeoutPopup` | uiStore | |
| `storeInfo` | uiStore | |
| `rawMd` / `linkUrl` | uiStore | |
| `autosaveMs` / `cliTimeoutLongMs` | uiStore | was useRef, stays non-rendering |
| `ready` | uiStore | |

**Stays in App.tsx (not migrated):**
| Item | Reason |
|---|---|
| `lastSavedSessionRef` | App-local, only used in persistSession |
| `saveTimer` | App-local debounce handle |
| `focusTimer` | Passed to useAppLifecycle |
| `flushRef` | Must stay in App — `flushRef.current = flush` each render |
| `H` | Stable handler ref — must stay in App for useLayoutEffect wiring |
| `activeTabRef` | Derive: `tabStore.getState().tabs[tabStore.getState().activeIdx]` |
| `editor` | Tiptap instance — not serialisable |

---

## Hook Parameter Reduction

| Hook | Before | After | Removed params |
|---|---|---|---|
| `useNoteOperations` | 22 | 6 | tabs, tabsRef, activeTabRef, activeIdxRef, fmCache, savedBodyCache, mdCache, uuidToPath, tier, setTabs, setActiveIdx, setNotes, setOpenFolders, setConfirmModal, setPromptModal, setTimeoutPopup |
| `useAiGestures` | 15 | 2 | editor, rawMd, tier, activeTabRef, tabsRef, uuidToPath, fmCache, savedBodyCache, pendingAiCount, evalStartTimes, askContextRef, setTabs, setRawMd, setShowAskPopup |
| `useBlobImageObserver` | 4 | 1 | activeTabRef, tierRef, pendingAiCount |
| `useAppLifecycle` | 17 | 4 | tabsRef, activeTabRef, activeIdxRef, fmCache, savedBodyCache, mdCache, evaluatingUuids, pendingAiCount, cliTimeoutLongMs, focusTimer, saveBufferSafe, setPendingClose |

After params remaining per hook:
- `useNoteOperations(flush, runBackgroundEval, selectTab, editor, H, storeSearch?)` — ~6
- `useAiGestures(editor, isMarkdownMode)` — 2
- `useBlobImageObserver(editor)` — 1
- `useAppLifecycle(activeIdx, flushRef, focusTimer, persistSession)` — 4

---

## 11-Step Migration Plan

Each step is independently committable. Steps build on the previous.

### Step 0 — Install Zustand
```
nix-shell --run "cd frontend && npm install zustand"
```
**Commit:** `chore: install zustand`
**Risk:** None.

---

### Step 1 — Create `stores/tabStore.ts`
Create the store with `tabs`, `activeIdx`, caches (`fmCache`, `mdCache`, `savedBodyCache`,
`uuidToPath`), and actions `setTabs` / `setActiveIdx`.

```typescript
import { create } from 'zustand'
import type { TabState } from '../types'

interface TabStore {
  tabs: TabState[]
  activeIdx: number
  fmCache: Record<string, string>
  mdCache: Record<string, string>
  savedBodyCache: Record<string, string>
  uuidToPath: Map<string, string>
  setTabs: (tabs: TabState[] | ((prev: TabState[]) => TabState[])) => void
  setActiveIdx: (idx: number) => void
}

export const useTabStore = create<TabStore>((set) => ({
  tabs: [],
  activeIdx: 0,
  fmCache: {},
  mdCache: {},
  savedBodyCache: {},
  uuidToPath: new Map(),
  setTabs: (tabs) => set(s => ({ tabs: typeof tabs === 'function' ? tabs(s.tabs) : tabs })),
  setActiveIdx: (activeIdx) => set({ activeIdx }),
}))

export const tabStore = useTabStore  // alias for getState() calls outside React
```

**Commit:** `refactor: add tabStore (Zustand) — Step 1`
**Risk:** Low — store exists but nothing reads it yet.

---

### Step 2 — Migrate tab/cache state in App.tsx to tabStore
- Remove `useState` for `tabs`, `activeIdx`; remove `useRef` for `tabsRef`, `activeIdxRef`,
  `fmCache`, `mdCache`, `savedBodyCache`, `uuidToPath`
- Replace with `const { tabs, activeIdx, setTabs, setActiveIdx } = useTabStore()`
- Replace every `tabsRef.current` / `activeIdxRef.current` read with `tabStore.getState().tabs`
  / `tabStore.getState().activeIdx` in async callbacks
- Remove the 2 shadow-ref sync effects for `tabsRef` / `activeIdxRef`
- `activeTabRef.current` becomes `tabStore.getState().tabs[tabStore.getState().activeIdx]`
  (keep deriving it at the top of App.tsx for convenience, no useRef needed)
- `tsc --noEmit` must pass; all tab switching/loading must work

**Commit:** `refactor: migrate tab/cache state to tabStore — Step 2`
**Risk:** Medium — core tab-switch path. Test: open 3 tabs, switch, load notes, close.

---

### Step 3 — Create `stores/aiStore.ts`
```typescript
import { create } from 'zustand'
import type { AiContext } from '../lib/aiContextBuilder'

interface AIStore {
  tier: 'dumb' | 'smart'
  aiTick: number
  evaluatingUuids: Set<string>
  pendingAiCount: number
  evalStartTimes: Record<string, number>
  askContext: AiContext | null
  setTier: (t: 'dumb' | 'smart') => void
  setAiTick: (v: number | ((prev: number) => number)) => void
}

export const useAIStore = create<AIStore>((set) => ({
  tier: 'dumb',
  aiTick: 0,
  evaluatingUuids: new Set(),
  pendingAiCount: 0,
  evalStartTimes: {},
  askContext: null,
  setTier: (tier) => set({ tier }),
  setAiTick: (v) => set(s => ({ aiTick: typeof v === 'function' ? v(s.aiTick) : v })),
}))

export const aiStore = useAIStore
```

**Commit:** `refactor: add aiStore (Zustand) — Step 3`
**Risk:** Low.

---

### Step 4 — Migrate AI tracking state in App.tsx to aiStore
- Remove `useState` for `tier`, `aiTick`; remove `useRef` for `tierRef`, `evaluatingUuids`,
  `pendingAiCount`, `evalStartTimes`, `askContextRef`
- Replace with `const { tier, aiTick, setTier, setAiTick } = useAIStore()`
- All async callbacks that mutate `pendingAiCount.current++` become
  `aiStore.getState().pendingAiCount++` (direct mutation of store field, no `set()` needed
  since these don't drive rendering)
- `tierRef.current` reads become `aiStore.getState().tier`
- `tsc --noEmit` must pass; Explain/Ask gestures must fire correctly

**Commit:** `refactor: migrate AI tracking state to aiStore — Step 4`
**Risk:** Medium — touches every AI call site. Test: Explain gesture, Ask gesture, image paste.

---

### Step 5 — Create `stores/uiStore.ts`
Large store — all UI toggles, layout dimensions, sidebar content, modals, search.
See full type signature in store definitions above.

Key implementation note: the `autosaveMs` and `cliTimeoutLongMs` fields replace `useRef` and
are read via `uiStore.getState()` in autosave logic — no renders triggered.

**Commit:** `refactor: add uiStore (Zustand) — Step 5`
**Risk:** Low — store exists but nothing reads it yet.

---

### Step 6 — Migrate UI state in App.tsx to uiStore
Remove all the corresponding `useState` / `useRef` declarations; replace with `useUIStore()`.
Remove the 3 shadow-ref sync effects for `showSidebarRef`, `showMetaRef`, `showPromptsRef`.
Remove `sidebarWidthRef`, `metaWidthRef`, `promptsHeightRef` — mouseup handlers call
`uiStore.getState()` instead.

**Commit:** `refactor: migrate UI state to uiStore — Step 6`
**Risk:** Medium — large number of call sites but all are straightforward substitutions.
Test: sidebar toggle, meta panel, drag-resize.

---

### Step 7 — Simplify `useNoteOperations` hook
Hook now calls `tabStore.getState()` / `uiStore.getState()` / `aiStore.getState()` directly
instead of accepting refs/setters as params. Reduce from ~22 params to ~6:

```typescript
export function useNoteOperations(
  flush: () => void,
  runBackgroundEval: (path: string) => void,
  selectTab: (path: string) => void,
  editor: Editor | null,
) { ... }
```

**Commit:** `refactor: simplify useNoteOperations — drop store params (Step 7)`
**Risk:** Med — validate all note/folder ops work (open, delete, move, rename, create folder).

---

### Step 8 — Simplify `useAiGestures` hook
```typescript
export function useAiGestures(
  editor: Editor | null,
  isMarkdownMode: boolean,
) { ... }
```
Hook reads `tabStore.getState()`, `aiStore.getState()`, `uiStore.getState()` internally.

**Commit:** `refactor: simplify useAiGestures — drop store params (Step 8)`
**Risk:** Med. Test: Explain + Ask gestures, background apply on tab-switch.

---

### Step 9 — Simplify `useBlobImageObserver` and `useAppLifecycle`
```typescript
export function useBlobImageObserver(editor: Editor | null) { ... }

export function useAppLifecycle(
  activeIdx: number,
  flushRef: React.MutableRefObject<() => void>,
  focusTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  persistSession: () => Promise<void>,
) { ... }
```

**Commit:** `refactor: simplify useBlobImageObserver + useAppLifecycle (Step 9)`
**Risk:** Low-Med. Test: image paste, app close, focus_count increment.

---

### Step 10 — Simplify H.current wiring
With stores, many handlers currently closed over 5-10 state values can now call `getState()`.
The `useLayoutEffect` that updates `H.current` will shrink significantly — most deps disappear.

**Commit:** `refactor: simplify H.current useLayoutEffect (Step 10)`
**Risk:** Low.

---

### Step 11 — Audit and clean up
- Run `tsc --noEmit` — must be clean
- Remove any remaining single-use shadow-ref sync effects
- Remove unused imports
- Update `docs/refactor-app-tsx-progress.md` and this document
- Target: App.tsx ~1,000-1,100 lines

**Commit:** `refactor: post-Zustand cleanup and type audit (Step 11)`

---

## Risk Areas and Mitigations

| Risk | Mitigation |
|---|---|
| Mutable cache fields (`fmCache` etc.) in Zustand — direct mutation bypasses subscribers | Intentional — these caches don't drive renders. Document clearly. |
| `evaluatingUuids`, `pendingAiCount` — direct mutation | Same as above — AI job counts don't drive renders, only `aiTick` does |
| Zustand devtools (Redux DevTools) | Optional — add `devtools()` middleware in dev build only |
| `tabStore.getState()` in render path | Avoid — use `useTabStore()` hook inside components for reactive reads |

---

## LOC Impact

| After step | App.tsx approx. LOC |
|---|---|
| Baseline (end of v2 refactor) | 2,033 |
| Step 2 (tab state migrated) | ~1,900 |
| Step 4 (AI state migrated) | ~1,820 |
| Step 6 (UI state migrated) | ~1,650 |
| Steps 7-9 (hooks simplified) | ~1,400 |
| Steps 10-11 (cleanup) | ~1,000-1,100 |

Hook files will each shrink by 30-60% as parameter plumbing is removed.
