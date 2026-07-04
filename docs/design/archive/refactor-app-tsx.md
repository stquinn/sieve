# App.tsx Refactor Plan

## Problem

`frontend/src/App.tsx` is 3,237 lines. It owns eight distinct concerns with no encapsulation
boundaries, causing whack-a-mole bugs where every change ripples unpredictably.

`buildAiContext()` (~lines 903–1040) is the most acute hotspot: 130 lines, cyclomatic
complexity ~18, five active bugs, and three copies of the same image-path logic.

## Goal

Shrink App.tsx to ~700–900 lines of pure orchestration (JSX layout + hook wiring).
Extract all logic into focused, independently testable modules.

---

## Extraction Map

### New directories to create
- `frontend/src/hooks/` — React hooks (does not yet exist)
- `frontend/src/lib/` — already exists; add new pure modules here

---

## Task G — `lib/imageUtils.ts`

**What:** Extract the repeated `resolveLocalImagePath` logic into a single utility.

**Why first:** The image path guard (`src.startsWith("data:")` / `GetImagePath` call) appears
in at least three places — inside `buildAiContext`, inside the image drop handler, and inside
the paste handler. All subsequent extractions reference this utility rather than re-copying.

**Interface:**
```ts
// frontend/src/lib/imageUtils.ts
export async function resolveLocalImagePath(src: string): Promise<string | null>
```

**LOC removed from App.tsx:** ~30 (deduplication)
**Risk:** Very low — pure extraction, no behavior change.

---

## Task B — `lib/aiContextBuilder.ts`

**What:** Extract `buildAiContext` as a pure function that takes ProseMirror doc + metadata,
returns `{ prompt, imagePaths }`. No React, no editor ref, no async beyond the image callback.

**Bugs to fix during extraction:**
1. Image extraction duplicated — replace with `resolveLocalImagePath` from Task G
2. `orderedList` uses `- ` prefix (should be `1.`, `2.` etc.)
3. `doc.forEach` `return false` does nothing — switch to `nodesBetween` with pos guard
4. `user_intent` appears twice in ask prompt
5. Function is `async` only because of deep image call — keep async but make it explicit

**Interface:**
```ts
// frontend/src/lib/aiContextBuilder.ts
import type { Node as PmNode } from "@tiptap/pm/model";

export async function buildAiContext(
  doc: PmNode,
  triggerPos: number,
  mode: "ask" | "explain" | "inlineEdit",
  userPrompt: string,
  frontmatter: Record<string, unknown>
): Promise<{ prompt: string; imagePaths: string[] }>

// internal helper — not exported
function serializeNode(node: PmNode, depth?: number): string
```

**LOC removed from App.tsx:** ~130
**Risk:** Low — pure function, no React. Easy to verify by running Ask/Explain after extraction.

---

## Task F — `hooks/useSettings.ts`

**What:** Extract `settings` state, `loadSettings`, `applySettings`, `toggleTheme`,
font-size/family CSS side effects.

**Interface:**
```ts
export function useSettings(): {
  settings: Settings;
  toggleTheme: () => void;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}
```

**LOC removed from App.tsx:** ~90
**Risk:** Low — settings are read-only from most other hooks; only coupling is DOM class manipulation.

---

## Task D — `hooks/usePersistence.ts`

**What:** Extract `saveCurrentNote` (debounced + immediate), 30s autosave effect,
`lastSaved` state, frontmatter re-attachment on save.

**Interface:**
```ts
export function usePersistence(
  editor: Editor | null,
  activeTab: Tab | null,
  frontmatter: string
): {
  lastSaved: Date | null;
  saveNow: () => Promise<void>;
  saveDebounced: () => void;
}
```

**LOC removed from App.tsx:** ~80
**Risk:** Low — no external dependencies beyond the Wails `SaveNote` binding.

---

## Task C — `hooks/useTabs.ts`

**What:** Extract `tabs`, `activeIdx`, all tab CRUD (`openFile`, `createNewNote`,
`deleteNote`, `duplicateTab`, `closeTab`, `reorderTabs`, `ensureUniqueTitle`,
`updateTabTitle`), and the `tabsRef`/`activeIdxRef` ref-sync pattern.

**Note:** `closeTab` currently calls `saveCurrentNote` before closing. Inject a `save`
callback parameter to avoid circular dependency with `usePersistence`.

**Interface:**
```ts
export function useTabs(
  initialNotes: NoteFile[],
  onBeforeClose: (idx: number) => Promise<void>
): {
  tabs: Tab[];
  activeIdx: number;
  activeTab: Tab | null;
  openFile: (note: NoteFile) => void;
  createNewNote: () => Promise<void>;
  deleteNote: (id: string) => void;
  duplicateTab: (idx: number) => void;
  closeTab: (idx: number) => void;
  reorderTabs: (from: number, to: number) => void;
  updateTabTitle: (id: string, title: string) => void;
  tabsRef: React.MutableRefObject<Tab[]>;
  activeIdxRef: React.MutableRefObject<number>;
}
```

**LOC removed from App.tsx:** ~200
**Risk:** Medium — most entangled concern. Validate autosave, dirty tracking, tab switching,
and initial load end-to-end after extraction.

---

## Task A — `hooks/useAiOrchestration.ts`

**What:** Extract `runAsk`, `runExplain`, `runInlineEdit`, `pasteAiResult`,
`streamingAiBlock` state, retry/timeout wiring. Calls `buildAiContext` from Task B.

**Interface:**
```ts
export function useAiOrchestration(
  editor: Editor | null,
  settings: Settings
): {
  streamingAiBlock: string | null;
  runAsk: (prompt: string) => Promise<void>;
  runExplain: () => Promise<void>;
  runInlineEdit: (prompt: string) => Promise<void>;
}
```

**LOC removed from App.tsx:** ~230
**Risk:** Medium — reads editor state and calls editor commands. `streamingAiBlock` state
drives conditional rendering in JSX; must be returned and wired back.

---

## Task E — `hooks/useKeyboardRouter.ts`

**What:** Extract the entire `handleKeyDown` function (~300+ lines) and its `useEffect`
registration. All actions become injected callbacks.

**Interface:**
```ts
export function useKeyboardRouter(actions: KeyboardActions): void

interface KeyboardActions {
  saveNow: () => void;
  runAsk: (prompt: string) => void;
  runExplain: () => void;
  openSettings: () => void;
  openHelp: () => void;
  newNote: () => void;
  closeTab: () => void;
  nextTab: () => void;
  prevTab: () => void;
  // ... full list to be finalised during extraction
}
```

**LOC removed from App.tsx:** ~280
**Risk:** Medium — `handleKeyDown` reads many state flags directly (modal open/close,
`isRenaming`, editor focus). Extract to a hook in the same file first, then move to
separate file once the interface stabilises.

---

## End State

After all seven tasks:

| File | Before | After |
|---|---|---|
| `App.tsx` | 3,237 lines | ~700–900 lines |
| `lib/imageUtils.ts` | — | new |
| `lib/aiContextBuilder.ts` | — | new |
| `hooks/useSettings.ts` | — | new |
| `hooks/usePersistence.ts` | — | new |
| `hooks/useTabs.ts` | — | new |
| `hooks/useAiOrchestration.ts` | — | new |
| `hooks/useKeyboardRouter.ts` | — | new |

App.tsx becomes a composition root: instantiate hooks, wire their outputs together, render.
