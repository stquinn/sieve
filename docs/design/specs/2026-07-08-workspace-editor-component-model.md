# The Workspace/Editor Component Model — encapsulated components, three public contracts

**Status:** Draft
**Tracked:** (Forgejo epic to be filed — tea login pending on this machine)
**Date:** 2026-07-08
**Companion:** `2026-07-08-selection-model-design.md` (the SelectionModel is a
facet of this object; this spec is its prerequisite). Backbone for tech-debt
**X-C** (global-bus coupling, `editor.js` god-module — user decision
2026-06-29 that the real fix is a separate epic: this is that epic).

## Problem

The frontend has no Editor. `editor.js` is a ~2143-line IIFE whose
module-scope globals (`currentEditor`, `currentUuid`, `currentMode`,
`tabModes` — ~174 references) collectively *are* the editor, and
`currentEditor` is literally the TipTap instance: the code conflates the
editor's IDENTITY with its current RENDERER. Consequences:

- The markdown toggle **tears down and rebuilds "the editor"** because there
  is no object whose attribute could simply flip; rendering mode is an event
  dance instead of state.
- Consumers reach into internals from anywhere: raw `window.getSelection()`
  peeks, `data-uuid` DOM fallbacks, direct PM `state.selection` reads,
  `window.TipTap.*` calls (~155 refs) — the X-C global bus.
- Nothing is swappable. TipTap cannot be replaced — or even meaningfully
  upgraded — because its instance IS the public surface.
- There is no consolidation point for per-tab state (document, meta, mode,
  selection), so each concern grows its own globals and listeners — the same
  disease the selection whack-a-mole record documents.

## Decision

> One **Editor object** per tab, stable across mode flips. The Editor owns
> a **root DIV**; the shell places that div in the tab's DOM and never looks
> inside it. The public surface is exactly **three contracts** — a JS API, a
> (minimal, outbound-only) JS event contract, and the WebSocket protocol.
> Everything inside — TipTap, the markdown textarea, mode surfaces, save
> debouncing, selection observation, all DOM below the root div — is the
> editor's private business.

**Full encapsulation:** no TipTap or ProseMirror TYPE ever crosses the
boundary — no PM nodes in SelectionContext, no editor instance on a global,
`window.TipTap` retired (X-C phase 4).

**Acceptance test:** TipTap could be removed and replaced by a hand-written
input surface without the app shell, the Go backend, or any other module
noticing.

## Architecture

### The object

```
AbstractEditor            // ALL mode-agnostic logic, written once:
  socket                  //   owns the WS channel: doc-update, block ops,
                          //   set-attr, save — identical code in any mode
  document: { uuid, body, dirty }   // + the autosave/save pipeline
  meta
  selection: SelectionModel         // companion spec; never null — surface-
                                    //   specific fields null per mode
Editor extends AbstractEditor       // one per tab; identity stable forever
  rootDiv                 // handed to the shell ONCE; all DOM below is private
  mode: 'wysiwyg' | 'markdown'      // setMode() mutates the subtree in place;
                                    //   the outside HTML is unaware
  #surface                // PRIVATE input surface, swapped by setMode:
                          //   TipTap island | textarea+gutter. An input
                          //   surface is only the way values get between
                          //   the user and the WS channel.
```

There is no public "renderer" concept. TipTap is an I/O adapter the Editor
privately owns — the mode-specific surfaces implement one small internal
interface (mount under rootDiv, unmount, apply server op, feed raw
selection/focus events to the model); everything else lives once in
AbstractEditor.

### The three public contracts

1. **JS API contract** — commands and state, called by whoever holds the
   object via the shell object model
   (`workspace.activeTab.editor` / `getCurrentTab().getEditor()`):
   getters (`uuid`, `mode`, `isDirty`, `getSelectionContext()`, `rootDiv`),
   commands (`setMode(m)`, `focus()`, `flushSave()`, `destroy()`).
   Commands are API CALLS, not events: a menu item's handler calls
   `getCurrentTab().getEditor().setMode('markdown')` and is done. The
   App-Level Chords ownership rule is unchanged — only the transport under
   it moves from CustomEvent dispatch to an API call. This implies a
   minimal **shell object model**, introduced alongside the shell:
   `Workspace` (permanent; owns Tabs, knows the active one, hosts the
   resident listener registry) → `Tab` (the Holder: creates its Editor,
   places its rootDiv, registers on it for the events it forwards, and is
   the client-side MANAGER of its session record — per-tab mode persistence
   (retiring the `tabModes` global), user_intent mutations, status/dirty
   conveyance, and the close-time keep/discard/file negotiation — always by
   asking Go and applying the answer, never deciding locally) →
   `Editor`.

   **The Workspace follows the same component model as the Editor** — it
   registers its own root DIV and everything beneath is its private
   business: the tab bar (its first rendering), the panel host, and the
   Tabs' editor mounts. This IS the house component contract: root DIV +
   JS API + registered listeners; Editor and Workspace are its first two
   instances.

   **The Workspace is NOT a source of truth.** Go session state owns which
   documents are open and which is active (Go-as-controller). The Workspace
   renders and reconciles on `session:changed` in ONE place: re-render the
   tab bar, create Tab+Editor on open, destroy on close, flip `activeTab`
   on switch (which synthesizes the selection update to listeners). It
   exists because Go cannot hold a TipTap island — a runtime conveyance of
   session state, never a second copy of it.

   **Ownership boundaries.** The Ask panel and meta panel are OWNED by the
   Workspace — they are expressions of working with documents, not shell;
   as owned children they are wired internally and need no public registry.
   The sidebar and the native menu are SIBLINGS that drive the Workspace
   through its API (`workspace.open(uuid)`,
   `workspace.activeTab.editor.setMode(…)`); the sidebar additionally
   registers on the public listener registry for what it observes (e.g.
   active-document changes). The public registry exists for external
   siblings; internal panels never use it.
2. **JS event contract — registered listeners, not DOM events.** No
   `document.dispatchEvent`, no global CustomEvents — a DOM broadcast is
   still a global bus wearing event clothing. Instead, a two-tier observer
   registration:
   - The **Editor notifies only its Holder** (the Tab that created it) via
     typed callbacks it registered for: selection updates (frozen
     `SelectionContext`), dirty/saved.
   - **Residents** (Ask panel, chrome) register on the permanent
     **Workspace** object (`workspace.onSelectionUpdate(fn)`, …) — a DEFINED
     listener registry, enumerable and discoverable at call sites. The
     Workspace republishes the ACTIVE tab's stream and, on tab switch,
     pulls the newly-active editor's current context once and pushes it —
     tab switching is just another selection update to residents.
   - Lifecycle falls out: residents never hold an Editor reference, so a
     closed tab unsubscribes its editor and nothing dangles.
   The editor consumes NO events and never echoes a command back — the
   caller of `setMode` already knows the mode. A callback not in the
   registry is a private detail nobody may rely on.
3. **WebSocket contract** — owned exclusively by AbstractEditor; no other
   JS touches the editor socket. Deliberately mode-agnostic: update block
   content, set sieve-block attrs, save, block ops carry values, not
   renderer detail — which is what makes the base class own them once. The
   message set is frozen as-is first (documented), then evolved
   deliberately. Backend-is-source-of-truth rules (tracked transactions, no
   full reload for ops) are obligations of the surface-facing side,
   unchanged.

## Phases

1. **Shell + contract freeze.** Introduce the Editor class; per-tab instance
   in the tab DOM; the module globals become delegating accessors (zero
   behavior change). Enumerate and DOCUMENT the three contracts exactly as
   they exist today — the freeze is what makes later internal moves safe.
2. **Internalize.** Move the WS channel, save pipeline, and mode toggle
   into AbstractEditor; extract the private input-surface interface; TipTap
   teardown becomes surface-private; `setMode` mutates the subtree in place.
   Menu/chord handlers migrate from CustomEvent dispatch to
   `getCurrentTab().getEditor().*` API calls (contract-doc App-Level Chords
   table updated in the same change).
3. **SelectionModel facet.** Implement the companion spec inside the
   boundary (its Phase 1 = this phase): model, SelectionContext pull/push,
   stateless Ask panel, AI-target port.
4. **Bus retirement (X-C proper).** Migrate `window.TipTap` consumers onto
   the contracts; ES-module conversion proceeds incrementally with the
   import graph enforcing the boundary.

## Non-goals

- No input-surface rewrite: TipTap stays; the seam merely makes it
  replaceable and demotes it from public interface to private I/O adapter.
- No WS message-shape changes in phases 1–3 (freeze, then evolve).
- No Go changes; the backend already speaks the WS contract.
- The chrome policy (state → classes, declared per kind) is adjacent and
  separately specced when needed; it consumes this object's events.

## Rationale

- **Identity vs renderer** is the root fix: markdown mode stops destroying
  "the editor" the moment the editor is a thing that exists.
- **Three named contracts** turn X-C from "untangle 155 global refs" into
  "migrate consumers onto an enumerated surface" — mechanical, phaseable.
- Aligns with the Go-server / web-mobile direction already recorded on X-C:
  a global god-object won't survive a bundler/SSR boundary; an Editor with a
  socket protocol and an event surface will.
- The selection whack-a-mole record (see companion spec) shows what happens
  to every concern that lacks an owner; this object is the owner for all
  per-tab concerns that follow.
