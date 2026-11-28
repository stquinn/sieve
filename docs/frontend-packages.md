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
  typedefs) / `ChatContainerProvider` (`chat-container-provider.js`: `getExchanges`, `requestAsk`,
  `requestRetry`).
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
  `InkProviderAdapter` / `ChatProviderAdapter` are the wall: guards and ack settling over (model, `DocumentService`),
  computing nothing. `ProviderAdapter` delivers every container's feed, and a kind's adapter
  decides which of its frames become events.

## 4. `lens/` — a container's views

A lens takes ONE business dependency — a provider — and may import only `contract/` +
`renderers/`. This is pinned TRANSITIVELY by `frontend/test/lens-isolation.test.js`, whose
quarantine list names the couplings still to be removed.

### The root

`lens/` itself holds only:

- `lens.js` — the `Lens` base: provider, mount/unmount + subscription, the `onChanged` → `paint`
  dispatch, the presence seam, and `reveal(leaf, seek)`.
- `abstract-editor.js` — `AbstractEditor`.
- `abstract-surface.js` — the surface contract every editor's surfaces implement.
- `extensions.js` — custom TipTap extensions (vanilla JS, not in the vendor bundle). Imported by
  `lens/document-editor/note-editor.js`, `lens/document-editor/context-menu.js` and
  `lens/document-editor/surfaces/wysiwyg-surface.js`.

`reveal(leaf, seek)` brings the leaf an address names into view; it is a no-op unless a lens
overrides it. `Workspace.openAddress(uri, seek)` hands it `OpenTarget.blockId` at the activation its
open causes, before the lens is presented again. `seek`, optional, is the text the opener is looking
for at the leaf (a quote's text), passed from the opener to the lens unread; a lens may use it to
choose what at the leaf to bring into view, and may ignore it. `DigitalNoteLens` reveals a page in
either mode, asked before its pages are known or after, and ignores `seek`. `ChatLens` reveals an
exchange (below).

### The editor hierarchy

`Lens` → `AbstractEditor` → `ProseMirrorEditor` → `NoteEditor` / `ComposerEditor`. `PromptEditor`
extends `AbstractEditor` directly.

- `AbstractEditor` (`abstract-editor.js`): the surface slot; a mode repertoire declared by the
  subclass; dirty/save/selection. Its seedless modes, which need no content seed, flip without the
  `blocks` capability. It derives the published capabilities (`contract/lens-capabilities.js`):
  `ask` is published by a lens that has `askAi` over a container that can hold the exchange — one
  it mints blocks in (`NoteEditor`) or one that takes a question as an exchange (`ChatLens`, through
  `requestAsk`). A lens that can be asked may also offer `questionsAsked()`, what was asked of it
  before, oldest first, each as the element list `askAi` takes (`QuestionList.written` of each
  question: the targets an ask adds from the selection left out); `NoteEditor` reads it from its
  ai-blocks and `ChatLens` from its exchanges. It names no mode and imports no ProseMirror, pinned by
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
| `lens/chat/` | `ChatLens` + `ChatThreadSurface`: a chat's exchanges as a conversation, two `ChatMessage`s per exchange, read-only (below) |

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

### `lens/chat/`

`ChatLens` is mounted over a `ChatContainerProvider` and has one mode, `chat`, drawn by
`ChatThreadSurface`: each exchange as two `ChatMessage`s, the question then the answer, in the
chat's order, newest at the bottom, in a scroller of its own that keeps the newest in view while
the reader is at it. While the reader is scrolled away from the newest, Jump to latest
(`chat-thread__jump`, a 28px bordered button at the thread's foot, sticky) is shown; it carries a
dot, and says "new messages" in its name and tooltip, once something has arrived since they left,
and pressing it returns there, which resumes following. Whether it is shown, and whether something
has arrived, are the surface's own view state (`jumpShown`, `arrivedSince`). The surface keeps the two messages of each exchange id across repaints and
redraws only the exchanges a change names. Before the first message of each calendar day it draws
a day separator (`chat-thread__day`); the label of each separator and the time under each message
come from one `ThreadTime`, and the surface's own clock (`CLOCK_MS`, started on mount and stopped on
unmount) rewrites them without redrawing a message. While any answer is being written
(`ChatMessage.answering`) a second timer, `PENDING_TICK_MS` (one second), tells each such answer
the time (`showElapsed(now)`) so its pending slot counts; it runs only while one is (`ticking`), is
started and stopped as a repaint finds one or none, and stops on unmount. It tells the last exchange's answer it is the
latest. A message's Retry reaches `requestRetry`; its Copy is written to the clipboard by the lens.
Its scroll joins the session scroll every tab keeps, through the surface's `feedScroll` /
`applyScroll`: the value is the distance in px UP FROM THE NEWEST message, 0 within the follow
slack, so the host's 0 for a never-seen tab opens a chat at the newest and a reader who left it
there returns to following. It reports `scroll-changed` after every repaint and once scrolling has
been still for `SCROLL_SETTLE_MS`; the workspace persists and restores it as it does a note's.
It claims no key. Its stats carry a readout, `chat · N exchanges`,
which the status bar shows in place of characters and lines, and it reports `doc-projected` when
the count changes. The spacing between messages is the surface's: `--thread-turn-gap` before a
question, `--thread-reply-gap` before its answer. The thread's column is `--thread-measure` /
`--thread-gutter`; `--thread-measure` is the Chat width setting (`--theme-chatMeasure`, else
`100ch`), registered as a length in `editor.css` so it is computed once at `:root`. The Ask panel
does not read it.

It takes part in the Ask panel as every lens does, and knows no panel:

- **Selection.** The surface feeds the selection model the chat (`docUuid`) and one exchange of it
  (`selectionType: 'block'`, `blockId`/`blockIds`/`ref` the exchange): always the last exchange,
  quoting nothing. An empty chat feeds `selectionType: 'none'`. Either way its `target` has an
  empty label: a question in a chat is about nothing it points at, so the chat puts no target
  forward and the Ask panel, which draws the target a lens gives it, draws none. The surface holds no
  quote, and a quote neither changes the selection nor reports a selection change.
- **Quote.** Quote on a message reports `{exchangeId, side, text}`, and the surface raises the
  `quote` intent (`SurfaceIntent.QUOTE`, `lens/abstract-surface.js`) carrying `blockId` (the
  exchange) and `text`, on every press. The workspace answers it with
  `AskPanel.insertQuote(container, blockId, text)`, `container` the uuid of the active tab's
  container, which mints the quote (`QuestionList.quotation`) and hands it to
  `ComposerMount.insert`, which puts it into the draft after the caret's block; the panel leaves
  the context it last rendered as it was. The lens names no panel and the panel no kind.
- **Ask.** It publishes `ask` alone. `askAi({type: 'ask', question})` calls
  `requestAsk(question)` verbatim: a quote is a block of the question it was put into. An explain
  asks nothing. `questionsAsked()` is each exchange's `question`, in order, which is what the Ask
  panel's Up recalls.
- **Open.** An attachment chip, and a double-click on a reference in either message, raise
  `open-container` with the address it was handed (`uri`) and, for a quote, the text it quotes
  (`seek`); the workspace passes both to `openAddress`. The open-container payload is documented
  once, on `SurfaceIntent` (`lens/abstract-surface.js`).
- **Reveal.** `ChatLens.reveal(leaf, seek)` asks `ChatThreadSurface.reveal`, now and for the thread
  presented next within `REVEAL_OWED_MS`. With a `seek`, the message that holds it
  (`ChatMessage.holds`), the question when both do, has its top put at the top of the thread and is
  marked (`ChatMessage.reveal(true)`, `chat-message--revealed`); when neither does, or there is no
  `seek`, the question is put at the top and nothing is marked. Once the reader was taken to an
  exchange, `applyScroll` leaves the thread where it is.

- **Toolbar.** What acts on the whole chat is in the workspace toolbar, at the end of the strip
  (`ChatLens._toolbarGroups`): what came of the last of it (an `ActionStatus`), then **Name now**,
  which calls the provider's `nameNow()`, and **Rename…**, which puts a `ToolbarField` holding the
  chat's name (`getName()`) with a Rename and a Cancel in their place; Enter or Rename calls
  `rename(name)` (blank hands naming back), Escape or Cancel leaves it. Both verbs are Promises the
  provider rejects with the host's words, which the status says. **New Chat is not offered**: the
  only way to make one is `POST /api/chat`, whose answer is the workspace's own tab strip and
  editor mount, which no provider verb can swap without the lens reaching the workspace. What acts
  on one message (Copy, Quote, Retry) stays on the message.
- **Provider verbs.** `ChatContainerProvider` (`contract/chat-container-provider.js`) is
  `getExchanges`, `requestAsk`, `requestRetry`, `nameNow` and `rename`. `ChatProviderAdapter`
  implements the last two over `DocumentService.chatDescribe` and `chatRename`, the HTTP calls to
  `POST /api/chat/{id}/describe` and `POST /api/chat/{id}/rename`; a chat's new name reaches its
  tab and the Chats item on the `chats` and `session` topics, not the lens.

The Ask panel is pinned open for it because its `Mounting` says `pinsAskPanel` (below).

## 5. `renderers/` — block look-and-feel, PM-free

### Renderer classes

- `BlockRenderer` base. Its `readOnly` option is the framework flag each kind honours by dropping
  its own editing/mutating affordances.
- `RendererStyleRegistry`, `StatusBadge`, `LineGutter`.
- `QuestionListView`: lens-agnostic drawing of a question's body slot — every element a whole
  block, read-only. A host hands it `QuestionList.drawn(question, container)`: the body slot and
  every reference that declares `displayAs` (a quote), in authored order.
- `ReferenceRenderer` draws a reference as its chip, or, when `displayAs` is
  `ReferenceRenderer.DisplayAs.QUOTE`, as a blockquote of its cached quote text
  (`cache[ReferenceRenderer.QUOTE_KEY]`, plain text) whose rule is doubled; where it is from is its
  tooltip. `QuestionList.quotation`
  is the one definition of a quote's shape.
- `ChatMessage` (`chat-message.js`): one message of a chat's thread, either side of an exchange
  (`new ChatMessage(side, container, intents)`, `side` `question` or `answer`). A question is drawn
  in the speaker surface with its attachments as chips; an answer open, its blocks read-only, each
  with its own Copy, and the pending slot or the failure and Retry under them. Under the message,
  in one row, its time (`showTime`, shown only while `at` is set: a question's `createdAt`, a
  completed answer's `completedAt`) and its actions, Copy and Quote, shown on hover or focus and
  kept shown by `setLatest`. A question draws its quotes in place among its blocks. Every intent is reported through a callback it is
  handed: `copy`, `quote` (`{exchangeId, side, text}`, the selection inside it or its opening),
  `retry`, and `open(uri, seek?)` for an attachment chip and any block whose renderer offers an open
  intent: `BlockRecordView` and `QuestionListView` take an optional `open` and forward a renderer's
  `onOpen` target to it as the address and, when the target carries one, its `seek`, naming no
  kind (`ReferenceRenderer`'s target carries a quote's text as `seek`). `holds(quoted)` says whether
  a text is one of the message's quotes: found, a trailing ellipsis left off and whitespace not
  compared, in the message as drawn or in its text with structure markers left out, the same text
  its opening is cut from. `reveal(marked)` puts the message's top at the top of its scroller and,
  marked, starts the stylesheet's one brief mark on its face, which no timer ends. It reads in the theme's UI face, which the
  answer's `.tiptap` typography inherits, and sets no margin of its own. `PendingSlot`
  (`pending-slot.js`) marks an answer still being written, and says how long it has been awaited
when its host calls `count(since, now)` (`PendingSlot.elapsed`: "12s" under a minute, then
"1m 05s"); it keeps no timer. A `ChatMessage` answer counts from its exchange's `createdAt`. Both draw from the `--utterance-*` /
  `--record-*` tokens at `editor.css`'s `:root`.
- `ThreadTime` (`thread-time.js`): how a time reads in a thread, given `now`: `ofMessage` ("a few
  seconds ago", "N minutes ago" up to five, then the time of day), `ofDay` ("Today", "Yesterday",
  else the weekday and date), `dayOf` (the calendar-day key), in the platform's locale. It keeps no
  timer.
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
`ToolbarLabel`, `ToolbarSelect`, `ToolbarField` (a line of text the reader types; Enter commits,
Escape cancels, and it takes the keyboard when first drawn), `ToolbarSeparator`, `ButtonGroup`.
`action-status.js` is `ActionStatus`, what came of a lens's last action, said briefly; the ink
lenses and the chat lens draw it in the toolbar.

## 6. `shell/` — the workspace wire and host chrome

`shell/` is the composition root and the only package that constructs lenses.

- `Workspace` / `Tab` / `MountBinding`.
- `LensTable` (`shell/lens-table.js`): which lens and provider a container gets, keyed by the kind
  the server states (`data-kind`), never read off a uuid. A `Mounting` with `pinsAskPanel` pins
  the Ask panel open, not dismissible, while its tab is active.
- `AskPanel` (`shell/ask-panel.js`): the workspace's ONE Ask panel, constructed once over
  `#ask-panel`. It reaches the active lens only through its selection context (the target chip and
  a command's context), its capabilities, and `askAi` on `Workspace.activeAskableLens()` (the
  active lens when it publishes `ask`); Explain goes to `activeBlockEditor()`. It has one
  presentation and two pins: the user's (`#session-layout[data-askpanel]`, the persisted View-menu
  toggle) and `pinFor(uuid)`, which `Workspace` sets on every active-tab change from the tab's
  `Mounting` (null releases it). Either pin marks the panel `is-pinned`, the one class the pinned
  rule in `shell.css` styles beside the user's pin; no rule styles a panel by what it is pinned
  for, so it keeps its handle, the user's height and its width. Pinned for a container it is open,
  focused then and after a send, and neither a close, a send nor Escape hides it or writes the
  user's pin; released, it is pinned if the user pins it, else open or closed as it was before.
  The uuid is also the draft's place, handed to its `ComposerMount` (`setPlace`): each place keeps
  its own draft, in memory, and otherwise the panel writes in the place `''`, the workspace's. What
  Up recalls the panel hands the mount as a source (`recallFrom`): `questionsAsked()` of
  `activeAskableLens()`, read at the key, so the panel keeps nothing of what it sent. Nothing tests a kind. `dropDraft(uuid)`, which `Workspace.closeTab` calls (a
  deletion closes the tab too), forgets a place.
- `ComposerMount` (`shell/composer-mount.js`): the host's arrangement for a draft: the in-memory
  container, the `ComposerEditor` presenting it, the harvest. A place's drafts are `DraftPlace`s,
  private to the module, each holding a draft and where a recall stands in it. It is the
  composer's `recall` host: in an empty draft a bare Up presents the last question its source
  answers in a fresh container and lens (`blocksOf`, the walk's inverse, writes a question's
  elements as draft blocks and leaves out a kind a draft cannot hold), Up again the one before,
  Down forward and past the newest an empty draft; emptiness and an edit are read from the
  container, not the surface.
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
