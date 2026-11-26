# The frontend's JS packages

What each package under `frontend/src/static/` holds and what it may import. How the JS inside
them is written is `docs/how-to-idiomatic-js.md`; why the packages are cut this way is
`docs/design/specs/2026-07-08-workspace-editor-component-model.md`.

## 1. The DAG

Five packages behind one firewall:

```
contract ← {renderers, container, lens, shell}
renderers ← lens
{container, lens} ← shell
```

- `contract/` is the leaf both sides import: the Lens↔Host wall.
- `container/` is the host data plane.
- `renderers/` is PM-free block look-and-feel.
- `lens/` holds the views.
- `shell/` is the composition root that mounts them.

A mount is a HOST verb: `MountBinding` binds one uuid, hands the lens a provider reading that
container's model, and the lens reads-and-paints on `onChanged` — so the ORIGIN of a mutation (a
lens verb, a menu, an AI job, the watcher) is indistinguishable by construction.

Lenses are transport-blind: no `fetch` or WebSocket outside `container/` and the `shell/` services
that own protocol traffic.

## 2. `contract/` — the Lens↔Host wall

- The provider hierarchy: `ContainerProvider` → `BlockContainerProvider` / `WholeContentProvider` /
  `InkContainerProvider` (`ink-container-provider.js`: `loadPage` and the ink feed's event
  typedefs).
- `ContainerUpdateListener`.
- `ContainerFeedListener` (`container-feed-listener.js`): host → lens, what happens to a container
  that is not its state.
- `SelectionListener`, the typed `SieveBlock`, and `ContractViolation`.

It is a LEAF: it imports nothing, pinned by `frontend/test/contract-purity.test.js`.

## 3. `container/` — the host data plane

- `ContainerTransport` owns the DOCUMENT wire: channel-per-uuid, opId ack correlation. Transport
  and NOTHING else — it spells no frame and holds no view of what a document contains.
- `BlockChannel` / `WsDial`.
- `DocumentService` is THE document vocabulary: every frame shape, ack/reply pattern, timeout and
  both HTTP halves, uuid-addressed and stateless. A wire change is `sieve/protocol/` + this file.
- `ContainerModel` is the client's ONE follower of a container.
- `ContainerModelFeed` / `ProviderAdapter` / `BlockProviderAdapter` / `WholeContentAdapter` /
  `InkProviderAdapter` are the wall: guards and ack settling over (model, `DocumentService`),
  computing nothing. `ProviderAdapter` delivers every container's feed, and a kind's adapter
  decides which of its frames become events.

## 4. `lens/` — a container's views

A lens takes ONE business dependency — a provider — and may import only `contract/` +
`renderers/`. This is pinned TRANSITIVELY by `frontend/test/lens-isolation.test.js`, whose
quarantine list names the couplings still to be removed.

### The root

`lens/` itself holds only:

- `lens.js` — the `Lens` base: provider, mount/unmount + subscription, the `onChanged` → `paint`
  dispatch, the presence seam, and `reveal(leaf)`.
- `abstract-editor.js` — `AbstractEditor`.
- `abstract-surface.js` — the surface contract every editor's surfaces implement.
- `extensions.js` — custom TipTap extensions (vanilla JS, not in the vendor bundle). Imported by
  `lens/document-editor/note-editor.js`, `lens/document-editor/context-menu.js` and
  `lens/document-editor/surfaces/wysiwyg-surface.js`.

`reveal(leaf)` brings the leaf an address names into view; it is a no-op unless a lens overrides
it. `Workspace.openAddress` hands it `OpenTarget.blockId` at the activation its open causes, before
the lens is presented again. `DigitalNoteLens` reveals a page in either mode, asked before its
pages are known or after.

### The editor hierarchy

`Lens` → `AbstractEditor` → `ProseMirrorEditor` → `NoteEditor` / `ComposerEditor`. `PromptEditor`
extends `AbstractEditor` directly.

- `AbstractEditor` (`abstract-editor.js`): the surface slot; a mode repertoire declared by the
  subclass; dirty/save/selection. Its seedless modes, which need no content seed, flip without the
  `blocks` capability. It names no mode and imports no ProseMirror, pinned by
  `lens-isolation.test.js`.
- `ProseMirrorEditor` (`lens/document-editor/prosemirror-editor.js`): the TipTap handle and the
  caret-anchor family.

Both editors mount at `#tiptap-mount`.

### One subdirectory per concrete lens

A new lens lands beside the editor, not inside it.

| Directory | Holds |
|---|---|
| `lens/document-editor/` | `ProseMirrorEditor` + `NoteEditor` + the entire PM world: `editor-shell.js` (the back-compat `window.SieveEditor` alias), `interaction-policy.js` (`DEFAULT_POLICY`, see `docs/editor-interaction-contract.md`), `context-menu.js` and `surfaces/` |
| `lens/document-editor/surfaces/` | THE PM package, the quarantine: wysiwyg/markdown surfaces, `node-views/`, `sieve-block-extension.js`, prose machinery, `code-format-action.js` |
| `lens/document-editor/composer/` | `ComposerEditor` |
| `lens/prompt/` | `PromptEditor` |
| `lens/outline/` | `OutlineLens` |
| `lens/block/` | `BlockLens`: the read-only fallback a block container gets when its kind has no lens of its own |
| `lens/ink/` | `DigitalNoteLens`, `LiveInkLens` (below) |

### ProseMirror enters in `surfaces/` only

- `lens/document-editor/surfaces/tiptap-vendor.js` is the TipTap/PM vendor seam: the ONLY PM read
  point. The pre-built core bundle it reads is `vendor/tiptap.js`.
- `lens/document-editor/surfaces/node-views/*-node-view.js` are the NodeView PM adapters: thin,
  composition over a renderer.
- `base/` holds only `icons.js` and `globals.js` (quarantined debt, TECH-DEBT X-C).

### `lens/ink/`

`DigitalNoteLens` has two modes; Mod+Enter switches.

- `page` = `PageSurface`: one page at a time as the tablet drew it, read-only. Ink arrives as it is
  written and nothing moves the reader.
- `transcript` = `TranscriptSurface`: the page as text and diagrams, drawn read-only through
  `QuestionListView`, with Transcribe this page and New document.

Both offer the workspace toolbar a `NotePager` and a `TabletOpener` (Open on device at the page
shown).

`LiveInkLens` + `LiveSurface` is the Live view: a strict mirror of the tablet's note, page and
window, with Open this note.

Both lenses draw through `InkSheet`: one page on a sheet — the SVG, committed strokes, the pen
live, a whiteboard's `PlaneWindow`. Its `SheetPolicy` says whether the view follows the tablet.

The Go side of all of this is `docs/how-ink-works.md`.

## 5. `renderers/` — block look-and-feel, PM-free

### Renderer classes

- `BlockRenderer` base. Its `readOnly` option is the framework flag each kind honours by dropping
  its own editing/mutating affordances.
- `RendererStyleRegistry`, `StatusBadge`, `LineGutter`.
- `QuestionListView`: lens-agnostic drawing of a question's body slot — every element a whole
  block, read-only.
- One concrete renderer + sibling `*.styles.js` per kind, prose included (`prose-renderer.js`).
- `block-renderers.js`: the manifest that imports all ten so the registry answers for every kind.

### The block vocabulary

`block-kinds.js`; `question-list.js` (the composer that mints a question's elements + the fold
that classifies them); `action-label.js`; `address-status.js`.

### Shared utilities

- `html-escape.js`, `job-status.js`, `sanctioned-markdown.js`, `highlighting.js`.
- `quote-anchor.js`: PM-free quote+occurrence text resolution — the marks anchor that
  `TextMarkDecorations` (the base under the spell and find decorations) resolves every pushed mark
  through.
- `vendor-libs.js`: the bundled non-PM lib seam.

### Ink

- `page-names.js` = `PageNames`: what a Digital Note's page is called — its name, a date name
  relative to today, its place in its run of equal names — and `PageNames.dateOf`, the one strict
  `YYYY-MM-DD` reading of a name.
- `page-heading.js` = `PageHeading`: the date printed on a diary page (contract §6).
  `textOf(noteProperties, name)` is the text, `at(template, text)` its place and size in page
  units, `of(page)` both from an export page.
- `ink-renderer.js` = `InkRenderer`: the Digital Note page → deterministic SVG per
  `docs/ink-contract.md`. A page's heading is drawn as the last child of its `ruling` group
  (`renderRuling(template, window, heading)`), so every view that draws the ruling draws it.
  perfect-freehand is read through the vendor seam. Pinned by the four fixtures' committed `.svg`
  snapshots under `docs/design/specs/assets/`.
- `syncing-panel.js` = `SyncingPanel`: what a view shows for a note with no published log.

### Code formatting

Formatting computes a string and never writes.

- `formatter.js`: the `Formatter` typedef (`format` / `supports` / `supportedLanguages`).
- `prettier-formatter.js` = `PrettierFormatter`: the per-language option table, lazy `import()` of
  `vendor/prettier.js`.
- `code-formatting-service.js` = `CodeFormattingService`: canonicalises the language and asks its
  ordered formatters; first wins. This is the seam a gofmt- or LLM-backed formatter joins on.

It is constructed in `Workspace` and handed to lenses through `AbstractEditor` options. The WRITE
is `lens/document-editor/surfaces/code-format-action.js` (`CodeFormatAction`): the Format menu
item both code menus offer, and its tracked `replaceWith` over the node's own range.

### Toolbar widgets

`toolbar-button.js` is the widget family a lens and the host both import: `ToolbarButton`,
`ToolbarLabel`, `ToolbarSeparator`, `ButtonGroup`.

## 6. `shell/` — the workspace wire and host chrome

`shell/` is the composition root and the only package that constructs lenses.

- `Workspace` / `Tab` / `MountBinding`.
- `LensTable` (`shell/lens-table.js`): which lens and provider a container gets, keyed by the kind
  the server states (`data-kind`), never read off a uuid.
- `WorkspaceService` owns the WORKSPACE wire, `GET /api/ws/workspace` — one socket, many tenants.
  Tenants claim inbound frame `type` words; unclaimed frames drop.
- `CommandService`, a TENANT of it: slash-command dispatch, correlation-id ack routing,
  cancellation.
- `MentionService`, another tenant: the `@` picker's `mention-query` / `mention-result` typeahead.
- `InvalidationService`, the push tenant: claims `invalidate` / `jobs-changed` /
  `container-deleted` and re-dispatches them as DOM events.
- `SpellControl`, a SENDER, not a tenant: outbound-only `spell-ignore` / `spell-learn` verbs plus
  the workspace-scoped `feature-control` toggle. It claims no inbound frame words.

### The workspace toolbar

`WorkspaceToolbar` (`shell/workspace-toolbar.js`) is constructed by `Workspace` over
`#editor-toolbar`. It draws the ACTIVE lens's `toolbarContents()`, asks again on the lens's
`toolbar-changed` event, and refreshes on every other event of its raw stream. It names no lens.

A lens answers with `AbstractEditor.toolbarContents()` = its surface's groups, then
`_toolbarGroups()`, which places the ONE `modeToggle()` (face per mode from `_modeToggleFace`).

## 7. Generated code

`frontend/src/static/generated/protocol.js` is generated from `sieve/protocol/`. JS speaks frame
types and topics only through it.
