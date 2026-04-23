# Stash Architecture Review

Working document capturing findings and remediation plan as we refactor.

---

## 1. Go Layer: Business Logic Belongs in Services, Not the Bridge

### Finding: `evaluateDocument` lives in TypeScript, not Go

The TypeScript `AiService.evaluateDocument` orchestrates a multi-step workflow:
1. Save the document
2. Check if content is empty → discard
3. Check `userIntent` → conditionally discard
4. Call `EvaluateBuffer` (AI call, correctly in Go)
5. Apply filing recommendation to metadata (`applyFilingRecToMeta` in `fmUtils.ts`)
6. Decide whether to `refile` vs `save` + `file`

This entire sequence belongs as a single method on `BufferService`, e.g.:

```go
func (bs *BufferService) EvaluateAndFile(b *Buffer, settings Settings, promptTmpl string, allowDiscard bool) (*Note, bool, error)
// returns: resulting note (if filed), discarded (bool), error
```

The bridge function `EvaluateBuffer` in `app.go` should call that service method. The frontend becomes a single bridge call.

### Finding: `applyFilingRecToMeta` lives in TypeScript

`frontend/src/lib/fmUtils.ts` contains `applyFilingRecToMeta` — a function that maps a `FilingRecommendation` onto document metadata. This is pure domain logic with zero UI dependency. It belongs as a method on `FilingRecommendation` or `Buffer` in Go.

### Finding: Buffer/Note kind is inferred by the frontend

`StorableDataService.load()` inspects `meta.status === 'filed'` to decide whether to construct a `NoteDTO` or `BufferDTO`. The discrimination belongs in the Go bridge.

**Options:**
- Add a `kind` field to both DTOs (`"buffer"` | `"note"`), set in Go at serialization time.
- Or unify behind a single `DocumentDTO` with the kind field explicit.
- Downstream: the frontend should stop using `instanceof main.NoteDTO` / `instanceof main.BufferDTO` checks.

---

## 2. Frontend Hooks: Not Idiomatic React

### Finding: `useNoteOperations` is not a hook

`frontend/src/hooks/useNoteOperations.ts` takes 15 parameters, uses no React primitives internally, and returns plain async functions. It is a function factory, not a hook. The `use` prefix is misleading.

### Finding: `useAppLifecycle` is a side-effect module disguised as a hook

Returns nothing, takes 11 parameters including service instances and mutable refs. The `useEffect` wrapper adds noise without adding value. This is a procedure, not a hook.

### Recommendation

- `useUiState` — keep as-is, it's idiomatic.
- `useAppLifecycle` — keep the `useEffect` wrappers but accept that it's a "grab bag" effect module. Rename to clarify intent if desired.
- `useNoteOperations` — either delete it and keep those functions in `App.tsx` (they belong there), or move the ones that are truly business logic into the Go service layer (see section 1).

---

## 3. Frontend Components: Logic Duplication

### Finding: Rename/Delete/SmartFile handlers duplicated in 3 places

The same operation logic appears in:
- `Sidebar.tsx` — `handleDelete`, `handleRename`, `handleSmartFile`, `handleSmartMetadata`, `onSetIntent`, `onCreateFolder`, `onMove`
- `TabBar.tsx` — inline `onDelete` and `onRename` anonymous handlers (lines 149–176)
- `useNoteOperations.ts` — `handleDeleteNote`, `handleRename`, `handleSmartFile`, etc.

The rename handler in particular (parent path extraction, `.md` suffix logic) is copy-pasted across all three locations. A bug fix must be applied in three places.

**Remediation:** Centralise all file operations into a single location (either a service or a context). Components should call the operation and receive the result — not re-implement it.

### Finding: `Sidebar` is doing too much

`Sidebar.tsx` contains a full set of CRUD operations as local functions before its render section. The sidebar component should receive pre-bound callbacks from its parent and focus on display. The logic currently in `handleDelete`, `handleRename`, etc. should be lifted up.

### Finding: `dataService: any` in TabItem

`TabItem` (TabBar.tsx:314) types its `dataService` prop as `any`. Same issue in the `tabDot` and `tabLabel` helper functions. These should use `StorableDataService`.

### Finding: Incomplete `handleDelete` in Sidebar

`Sidebar.tsx` lines 113–117 have a comment `// For now, we assume it might be open` with no fallback implementation when the document is not in the registry. The delete silently does nothing if the note is not currently open.

---

## 4. Frontend Components: Styling Inconsistency

The codebase has a split personality:
- `Sidebar.tsx`, `TabBar.tsx`, `NoteContextMenu.tsx`, `Modal.tsx` — Tailwind with `cn()`
- `MetaPanel.tsx` — BEM-style CSS class names (`.meta-panel__header`, `.meta-panel__tab`)
- `App.css` — custom CSS variables and utility classes

This makes global styling changes require knowledge of which system each component uses.

**Recommendation:** Commit to Tailwind + `cn()` as the single system. Migrate `MetaPanel.tsx` and any remaining BEM classes. Keep CSS variables for theme tokens only.

---

## 5. Modal Pattern: Prop Drilling

`setConfirmModal` and `setPromptModal` are threaded as props from `App` → `TabBar` → inline handlers → `TabItem`, and `App` → `Sidebar` → local handlers → `NoteContextMenu`. Every intermediate component must accept and forward these props even if it doesn't use them directly.

A React context for modals (`useConfirmModal()`, `usePromptModal()`) would eliminate the drilling. This is a moderate refactor but makes the component signatures significantly cleaner.

---

## 6. NoteContextMenu: Two Components in One

`NoteContextMenu.tsx` has an early return for prompts that renders a completely different UI. It also conditionally shows tab-specific actions (`onCloseTab`, `onCloseAllTabs`). The `isPrompt` branch should be a `PromptContextMenu` component; the tab-action props suggest a `TabContextMenu` variant.

The context menu also has no viewport bounds checking — it renders at `{ top: y, left: x }` with no clamping, so it can render off-screen near screen edges.

---

## Summary: Priority Order

| Priority | Item | Effort |
|---|---|---|
| 1 | Move `evaluateDocument` + `applyFilingRecToMeta` to Go | Medium |
| 2 | Fix Buffer/Note kind discrimination in bridge | Small |
| 3 | Eliminate rename/delete duplication across Sidebar, TabBar, useNoteOperations | Medium |
| 4 | Replace `dataService: any` with proper type in TabItem/helpers | Small |
| 5 | Fix silent-fail on delete-by-path in Sidebar | Small |
| 6 | Modal context to eliminate prop drilling | Medium |
| 7 | Unify Tailwind vs BEM in MetaPanel | Small |
| 8 | Split NoteContextMenu into focused components | Small |
| 9 | Context menu viewport clamping | Small |
