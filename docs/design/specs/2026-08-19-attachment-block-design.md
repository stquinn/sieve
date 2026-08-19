# The attachment block — a chip that holds a file or points at a coordinate

**Status:** Designed
**Tracked:** #38 — ONE effort. The block, the `TriggerHost` refactor that gives it
`@` in the editor, and the chip extraction ship together; see *Scope* for why they
are not split.
**Date:** 2026-08-19

## Problem

Sieve has no way to put a *source* in a document. Two shapes of the same want:

- **Hold a file.** Embed a swagger spec, a PDF, a CSV — material the document is
  *about* but which nobody wants rendered inline. Today the only file a document
  can hold is an image (`smart-image`); everything else has nowhere to go.
- **Point at another Sieve thing.** Cite another document from this one, durably
  and clickably, so the reference survives being read months later.

#74 solved a *neighbouring* problem and it is important not to mistake one for
the other. The composer's `@` chips exist because **a textarea has nowhere to put
a block** — the ATTACHED DOCUMENTS manifest is compensation for the absence of a
document. A block in a container needs no compensation. This design borrows #74's
*coordinate system* and nothing else: no manifest, no `domain.Attachments`, no
`PromptSection`, no `StampAttrs`.

## Decision

**One new block kind, `attachment`, built from the two kinds that already do each
half of the job.**

- **Smart-card is the LIFECYCLE parent.** An address is resolved to a cached face
  — title, kind, summary — by a job, and the face refreshes on resolve.
- **Smart-image is the ASSET parent.** The block holds a `src` naming a file in the
  document directory; `AssetService` owns the bytes.
- **The attachment chip is the VISUAL parent.** Sieve already has a vocabulary for
  "this is an attachment"; the block wears it rather than inventing a card.

Exactly one of `src` / `uri` is set. That is the **only** discriminator in the
processor, and it forks in exactly one method — `DescribeJob`, choosing which
resolver populates the face. Every other method is uniform across both.

### Rejected: two kinds

An earlier pass proposed splitting `attachment` (holds) from `citation` (points),
on the argument that their lifecycles, creation paths and AI contributions all
diverge. The third of those is false, and it is the load-bearing one: a held
asset and a cited document both contribute *a name and a location* to
`BuildContext`, so the split would have bought one honest fork in `DescribeJob`
at the price of a dishonest one everywhere else.

### Rejected: an `asset:` address scheme

Considered so a held file could be addressed independently. Unnecessary: **the
block is the addressable thing**, exactly as `smart-image` is. A held asset is
reached as `block:{container}/{blockID}` by the ordinary block grammar, and needs
no scheme of its own — the same coordinate any other block has. (Resolving that
form is not part of this work: `Router.Resolve` answers for containers only, and
nothing here needs it to do more.)

### Rejected: minting a container per imported file

Considered because a `container:{uuid}` resolves through the Router and MCP for
free. It would dump every dragged PDF into the Library list, and it dissolves the
distinction between a *document* and *a file a document holds*.

## Architecture

### Attrs

| attr | parent | meaning |
|------|--------|---------|
| `src` | smart-image | asset filename in the document directory — the block **holds** a file |
| `uri` | new | `container:{uuid}` — the block **points** at another Sieve container |
| `title` | smart-card | the card's name |
| `targetKind` | smart-card `siteName` | `note` for a citation; the mime family for a file. NEVER `kind` — see below |
| `summary` | smart-card `description` | one line under the title |
| `bytes`, `mime` | new | so a held file's card reads "OpenAPI · 412 KB" |
| `status`, `error`, `createdAt`, `completedAt`, `supportsEmbedding` | both | standard block lifecycle |

**`targetKind`, never `kind`.** `kind` is RESERVED: `BASE_ATTRS`
(`sieve-block-extension.js`) declares it on every `sieve-*` node as the BLOCK's
kind. A processor attr of that name collides SILENTLY —
`WysiwygSurface#applyBlockAttrsUpdated` copies any wire key present in
`node.attrs`, so a completing job would retype the node. This spec first named the
attr `kind` and was wrong. Both halves are fixed: the attr is renamed, AND that
handler now refuses `kind` outright alongside `id`/`status`, since a block's kind
changes by `replace-block` and never by an attrs update. The rename fixes this
kind; the guard fixes the class.

`uri` holds `container:` addresses only. `block:` is legal grammar but
`Router.Resolve` answers for containers alone, and nothing here needs more.

### `DescribeJob` — the one fork

Both parents share a guard this kind inherits verbatim: **an empty address attr
returns `nil`, and the block is born `COMPLETE`.** Otherwise:

- **`src` set** → local job: read the bytes through `AssetService`, sniff mime,
  stamp `bytes`, extract text for `summary`. Shape of `SmartImageProcessor`'s
  describe job, without the CLI call.
- **`uri` set** → resolve job: `Router.Resolve(uri)` → `domain.Node` → stamp
  `title` / `targetKind` / `summary`. Shape of `SmartCardProcessor`'s OG fetch, with the
  Router in `LinkPreview`'s seat.

Unlike a composer chip — whose title is deliberately **frozen** at attach time,
because a turn is a historical record — a block is a **live** reference and its
face refreshes on resolve. That is smart-card's behaviour, and copying #74 here
would be wrong.

### `BuildContext` — no special case, no manifest

The block contributes to an AI call the same way every other block does: whatever
`BuildContext` returns, when the ask's context contains it. Nothing on the prompt
path branches, and the block is never assembled into a manifest.

Held file (`src`), mirroring `SmartImageProcessor`'s `Image: {filename}`:

```
Attachment: swagger.yml
  Type: OpenAPI · 412 KB
  Summary: Payments API, 47 endpoints
```

The bare filename is enough because **the CLI's cwd is the document directory**
(`cli.go`: *"pass the note/buffer's directory so relative asset paths in markdown
resolve correctly … the note directory is the cwd and needs no grant"*). This is
precisely how `AIService.DescribeImage` already reaches an image. No MCP verb, no
address, no containment change.

Citation (`uri`), mirroring `SmartCardProcessor`'s `Link: {href}`:

```
Attachment: Auth Design (note)
  Address: container:9f2b-…
  Summary: Token rotation and session binding
```

Smart-card does not instruct the model to fetch its `href`, and this does not
instruct it to call `get_by_uri`. The MCP verb is standing capability; the block
states facts. Its tool description is currently written *for the composer*
("Pass the uri exactly as it appears in an ATTACHED DOCUMENTS manifest") and
wants generalising so a block-borne address reads as legitimate — a one-line
change carried by this work.

### Creation

Four paths, all existing patterns:

| path | sets | mechanism |
|------|------|-----------|
| file drop / picker | `src` | #68's non-image case — image drop → `smart-image`, anything else → `attachment`; same `WysiwygSurface` drop handling, same `createBlock` seam |
| `@` in the editor | `uri` | the trigger-popover family, hosted in the editor — see below |
| paste a coordinate | `uri` | claimed as `ActionTransform` in `IsSupportedContent`, mirroring how web-clip claims a pasted link |
| slash command | either | the keyboard path |

**Where the block lands** is the rule every Sieve block already follows, so there
is nothing new for `docs/editor-interaction-contract.md` to learn: on an empty
line the block becomes that node in place; with text already on the line it is
inserted on the next one.

### The `@` gesture and its host

`@` today is a composer affordance. Putting it in the editor is the one piece of
this feature that is not a straight copy of an existing block, and it ships WITH
it: `@` is how a coordinate is chosen, so a block whose only creation paths are
paste and a slash command is the feature half-delivered.

**One popover, not two.** The composer's picker already splits correctly for
this: `MentionService` is a session-plane tenant rather than a composer object
(#74 P1), and `TriggerProvider`/`MentionProvider` are already generic in their
semantics. `TriggerPopover` is *also* already the shared half — it owns the token
scan, the keyboard model, the #63 scroll-into-view fix and blur dismissal. Those
four are the pieces with bugs already fixed in them, and a second popover starts
that debugging over while giving the interaction-policy precedence problem two
owners. #71's issue text documents that exact failure happening three times over
with the interaction policy; this would be the fourth.

**What is actually composer-specific** is four touchpoints in `trigger-popover.js`
— `#textarea.value`/`.selectionStart` (279), the input/keydown/blur listeners
(136–138), `provider.accept(candidate, token, this.#textarea)` (240), and
`#position()` (365–372). Only the last is visual, and what it encodes is the
*anchor*, not the styling.

**`TriggerHost` — the seam.** Named for its role in the family
(`TriggerPopover`/`TriggerProvider`/`TriggerToken`), NOT for its payload. A
`TextHost` name would prejudge the content, and the gesture is meant to be
ubiquitous: every surface, view and thing offering the same controls is what will
make "blocks all the way up" feel like one app rather than a set of them.

The interface splits required core from an optional typed slice, the same shape
#71 chose for `TextLens` + nullable `BlockHost`:

| | needs | implemented by |
|---|---|---|
| **core** | anchor rect, accept a candidate, subscribe to key/dismiss | every host |
| **typed slice** | token under the caret, replace a range | hosts that can be typed into |

A host that cannot be typed into — a toolbar button or `Mod+K` summoning the
picker with no token — implements the core only, and its provider is handed an
empty prefix. Only what the two real hosts (`TextareaHost`, `ProseMirrorHost`)
need gets built; the point of the split is that the seam does not lie when a
third arrives.

**`SelectionModel` supplies half the position.** It is explicitly a *document*
coordinate and never a PM node — "the PM/DOM split is insulated inside the
surface" — so it says which block and offset, not where in pixels. The rect comes
from the surface via `view.coordsAtPos()`, exactly as `block-chrome.js:67`
already places gutter chrome. The host is therefore implemented **by the
surface**, the only thing permitted to touch PM/DOM, and it hands the popover a
rect without the popover learning what ProseMirror is.

**Placement is a strategy, not a component.** A command palette and an inline
autocomplete are genuinely different experiences, but the variant tracks the
**host, not the trigger** — in a composer both `/` and `@` read as a palette; in
an editor both read as inline, the way Notion's `/` menu is caret-anchored:

- `PanelPlacement` — today's `#position()` verbatim: `closest('#ask-panel')`,
  full width, pinned above the top edge.
- `CaretPlacement` — `host.anchorRect()`, narrow, flipping up when there is no
  room below.

Plus a density class on the root for row terseness. Everything else is untouched.

#### Typing a literal `@`

A document is full of legitimate `@`s — email addresses, handles, `@Override`,
`@media`. The user must be able to write one without it becoming a chip, and
dismissing must STAY dismissed rather than reopening on the next keystroke.

**The mechanism already exists and is inherited free**, which is on its own a
strong argument against a second popover: #74 P5 built token abandonment.
Going dry, Escape, and acceptance each abandon the token under the caret;
`#abandoned` is keyed by `{start, prefix}`, so typing FORWARD from an abandoned
token stays closed while backspacing to a shorter prefix re-arms it. Acceptance is
always an explicit act — nothing auto-chips. And `acceptsBoundary` means a
mid-word `@` (`me@example`) never arms in the first place. Forking the popover
would mean reimplementing that state machine, and it took a dedicated phase to get
right.

Two things ARE different in a document and need deciding here:

- **The picker must not arm inside code or diagram blocks.** `@Override`,
  `@media` and `@Component` sit at a line start after whitespace, so they satisfy
  `acceptsBoundary` and would open the picker only to flash shut when the search
  returns dry. The composer has no such case.

  **Eligibility is an INTERACTION POLICY decision, not a host judgement.** A block
  declares that pickers do not arm in its text, and the popover never scans there
  — the same mechanism that already owns Tab, Enter, Home and the arrows per kind.
  A host that adjudicated this itself would be a second declaration mechanism
  beside `interactionPolicy`, which is exactly what that file's own header warns
  against.

  The flag follows the file's convention — default `false`, named for what it
  does, opted INTO by the kinds that restrict, like `caretStop` and
  `readOnlyText`:

  ```js
  suppressTriggers: false,  // `@`/`/` pickers never arm in this block's text
  ```

  It belongs in `CODE_TEXT_POLICY`, and that is the whole change: `code-node-view`
  declares `{ ...CODE_TEXT_POLICY }` and `diagram-node-view` declares
  `{ ...CODE_TEXT_POLICY, … }`, so **one line in the preset covers both kinds with
  no per-kind declaration**. Every future code-ish kind inherits it by spreading
  the preset, which is what the preset is for.

  The chip-like kinds need nothing: `ai-block`, `web-clip`, `smart-image` and
  `smart-card` are all `caretStop: true`, so no caret enters their text and no
  trigger can arm there in the first place.

  This also satisfies that file's standing rule — *"flags are born WITH their
  reader: never declare one here before something consumes it"* — because this
  change builds the reader.
- **`@`'s multi-word span is more aggressive in prose.** `acceptsPrefix` lets the
  token run across words because a document title is several — proportionate in a
  short message, less so in a paragraph, where it keeps a token live until it goes
  dry. Worth capping the span (a word count, or the first candidate-less word) and
  worth validating against real typing rather than reasoning.

#### Not built here, but it constrains one signature

The trigger family generalises past `@`. The obvious next provider is `{kind` —
Confluence's `{macro` gesture — as a keyboard shorthand for inserting any Sieve
block without the toolbar. It is NOT in scope, but it is recorded because it
decides how `accept` is typed in this change.

It needs no framework addition: `trigger` is `{`, `acceptsPrefix` takes `/`'s
restrictive single-token rule (kind names are one word), and `search` is a
SYNCHRONOUS boot-shipped array off the block registry — the command list's path,
not `@`'s round-trip. One provider class.

`{` is also the right character rather than a second meaning for `/`: Sieve
already spends `/` on commands, and keeping kinds on `{` keeps two namespaces
distinct. It does not fight `PAIRS` either — `autoClosePairs` defaults false and
prose does not spread `CODE_TEXT_POLICY`, so `{` never auto-closes in prose; where
it does (code, diagram), `suppressTriggers` has already stopped the picker.

**What this decides now:** a block-kind accept is the FIRST accept that is not a
text substitution. Both current providers replace a token with a string (`/name `,
`@Title`); this one deletes the token and CREATES A BLOCK through
`documentService.createBlock(uuid, kind, attrs, afterBlockId)`. So `accept` must
be typed against the host's CORE — "do something with this candidate" — with
range-replace being one facility a typed host offers, never the definition of
accepting. Typing it as string replacement this week would mean reopening the
contract later.

**The one part that is not free** is key precedence. The popover binds `keydown`
with `capture: true`; inside ProseMirror it must beat the interaction-policy
keymaps for arrows, Enter and Tab while open — and Escape, which must abandon the
token rather than reaching the block-escape behaviour behind it. That is the
"inter-host key precedence" gap the CommandPopup work already identified, and any
change here updates `docs/editor-interaction-contract.md` in the same commit.

### Render and navigation

**The block is an attachment chip, sized to its content.** Not a card: Sieve
already has a visual cue for what an attachment is, and a second vocabulary for
the same idea would make the two read as different objects. The ai-block's own
styles already state that principle for the pair they own — the mention mark and
the footer chip share an accent because *"the name in the sentence and the chip
under the answer are one object, and the tint is what says so"*. A block holding a
source is the same object again, standing on its own line rather than under an
answer.

So it is drawn as `.ai-block__attachment` is drawn — pill radius, accent tint,
border, icon, `inline-flex` at `flex: 0 0 auto` — in a block-level wrapper that
SHRINK-WRAPS it. **The chip is never made bigger than it needs to be.** An
attachment is whatever size makes sense, the way an image is; forcing it to span
the column would make a two-word title look like a banner.

This is a DELIBERATE contrast with `smart-card`, which is `width: 100%`
(`smart-card-renderer.styles.js`). A card is a preview surface and earns the
column; a chip is a label and does not. The two should not later be harmonised on
the grounds that they are both link-ish blocks.

The one departure from the footer chip is its `max-width: 15rem` ellipsis clamp,
which is lifted: a chip in the document may carry the FULL document title or
filename, bounded only by the text column, because it is the block's whole
identity rather than a compact provenance mark under an answer.

The block's own interaction policy is `caretStop: true`, joining `ai-block`,
`web-clip`, `smart-image` and `smart-card`: a chip has no editable text, so the
arrows select it as one stop.

Kind and size sit as quiet secondary text after the label. Expansion is a chevron
on the chip itself revealing `summary` beneath it — **not** a header bar with a
toolbar, which is card furniture and would undo the point. The chevron is
load-bearing rather than a nicety: it is what lets the double-click gesture stay
as simple as it does (see *Gestures* below).

**Dangling is already drawn.** A `uri` whose target is gone gets the
`--missing` modifier that exists on ai-block chips today.

#### Gestures: open it where it lives

**Single click selects, double click opens.** A block sits in the editing flow,
so single click must place the caret and select it like any other block. The
ai-block's FOOTER chip stays single-click because it is not in that flow — the two
differing is deliberate, and belongs in `docs/editor-interaction-contract.md`
rather than being left to look like an accident.

Double click obeys ONE rule, and it is the rule that keeps this small:

| the block | opens |
|---|---|
| points (`uri`) | the container, via `Router.Target` — `MentionService.resolve` already does exactly this for ai-block chips and is reused, not rebuilt |
| holds (`src`) | the file's location in the OS file manager, via the existing `App.showInFiles` |

`showInFiles` (`app.go:517`) is already built, already cross-platform (`open -R`
on darwin, `xdg-open` on the containing directory elsewhere) and already used for
documents, folders and prompts.

**The principle is the boundary, not the file manager.** Stated properly: *a Sieve
block opens in Sieve; anything that is not a Sieve block is the filesystem's —
even when that filesystem happens to sit inside Sieve's own Library.* Revealing in
an OS file manager is the DESKTOP REALISATION of the second half, and it is the
only one that exists today.

That matters because the desktop is not the destination
(`docs/design/vision-go-server-s3.md`): a Go server with an S3 store and web or
mobile frontends has no file manager to reveal into, and would answer the same
gesture with a download, a signed object URL, or a viewer. V1 must therefore not
harden `showInFiles` into the block.

The cost of keeping that door open is nothing, because the codebase already has
the pattern: the surface fires an INTENT and a handler decides, exactly as
`sieve:ai-ask` / `sieve:ai-explain` keep business logic out of surfaces. So the
renderer emits "open this asset" and never names a mechanism; the desktop handler
answers with `showInFiles`, and a hosted build substitutes its own answer without
reopening this design.

**Reading the asset in Sieve is the chevron's job, not double click's.** Expanding
shows `summary` and, for a text asset, a scrollable preview. That is what makes
the simple gesture sufficient.

##### Rejected: opening the asset in a tab

Considered — text/YAML/JSON in a read-only source view, binary handed to the OS —
and it collapsed under its own weight. It needed a new tab type, a viewer
registry, and a read-only surface with **no save spine at all** (markdown mode is
breakglass and authoritative on save, so an `editable: false` flag would be one
regression away from writing a swagger file back through the document save path).

It also required a NEW CAPABILITY the codebase has so far declined to take.
Nothing in Sieve launches a file today: `showInFiles` reveals, and on Linux it
opens the containing directory rather than the file. `xdg-open <file>` runs the
OS handler for whatever the bytes are, and these bytes arrived by drag-and-drop —
a `.desktop` on Linux or a `.command` on darwin is *executed* by that handler, not
viewed. Double-clicking a block in a document must not be able to do that, and
avoiding it would have meant a mime allowlist with reveal as the fallback anyway.

Every one of those parts existed to let the user read the asset. The chevron
already does.

This is a rejection FOR V1, not forever. A hosted build has to answer the open
gesture somehow, and a built-in viewer is a reasonable answer there — which is
precisely why the gesture is an intent rather than a call to `showInFiles`. What
is rejected is building the viewer NOW, to solve a problem the chevron solves.

Note for whoever builds the ingest job: the text/binary distinction is **not**
`store.Encoding`, which describes packaging (`raw|base64|lz-compressed|zipped`),
not content. It comes from the `mime` attr stamped at ingest.

#### The chip is now a shared component

The vocabulary exists in TWO implementations already — `.ai-block__attachment` in
`ai-block-renderer.styles.js` (carried styles) and `.ask-popup__chips` in
`editor.css` (shell CSS). This block is the third, and three is where it gets
extracted rather than copied.

`AttachmentChip` belongs in `frontend/src/static/block/renderers/`, a sibling of
`StatusBadge` and `LineGutter`, with its styles carried the way #43 established.
The ai-block footer and this block both consume it.

The composer is the awkward third caller: it is not a block, so it does not carry
block styles, and folding it in crosses the shell/renderer boundary. The
resolution is to unify the TOKENS rather than the components — the radius, the
`color-mix` tint formula, the border and the sizing steps as custom properties one
place owns — so all three draw the same chip without the composer pretending to be
a renderer.

**All three callers move in this change.** Leaving the composer on its own rules
would mean shipping a unification that unified two of three, which is the
duplication restated rather than removed — and the next person to touch a chip
would still have to ask which implementation they are looking at.

## Scope

**One effort.** The processor, the renderer, the `AttachmentChip` extraction and
the `TriggerHost` refactor land together.

They are not split because each split would ship something incomplete rather than
something smaller:

- The `src` and `uri` halves share every method but `DescribeJob`, so splitting
  them means writing the same file twice.
- Without `TriggerHost` the block has no `@`, and `@` is how a coordinate gets
  chosen — paste and a slash command are the fallbacks, not the affordance.
- Without the chip extraction the vocabulary exists in three implementations
  instead of one, which is the duplication this design set out to stop.

The `TriggerHost` work is a **down-payment on #71's seam**, not a competitor to
it: same abstraction, smaller first customer. #71 gets narrower as a result rather
than blocked.

One thing is genuinely outside it:

- **Binary text extraction** (PDF, docx). A dependency conversation rather than a
  slice of this one, wanted only if a non-plain-text source actually turns up.
  Swagger, the issue's own example, is plain text — and with the open gesture
  being reveal-in-place, an unreadable binary still behaves correctly today: its
  chip names it and double-click finds it.

## Rationale

The feature is small because it refuses two temptations. It does not invent an
address space — the block *is* the address, as `smart-image` already is. And it
does not reach for #74's manifest machinery — that machinery exists to compensate
for a textarea having nowhere to put a block, and this is a block in a container.

What is left is a new flavour of a pattern the codebase already runs twice, using
the framework exactly as designed: one processor, one renderer over the shared
`BlockRenderer` base, and a `BuildContext` that states what it is and where it
lives.

The `@` host is the one place this design spends where it could have saved. A
second popover would have been quicker to write and would have looked right
sooner. It is refused because a gesture that behaves the same everywhere is what
will make "blocks all the way up" feel like one application: if each surface,
view or thing asks the user to learn its own controls, the uniformity is
structural only and never reaches them. That is worth one seam.
