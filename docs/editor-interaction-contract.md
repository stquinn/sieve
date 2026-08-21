# Editor Interaction Contract

**Normative.** Any interaction change MUST update this document in the same
change. Each cell is a testable behaviour; ✅-mark cells during a manual
regression pass. Source spec:
`docs/design/archive/specs/2026-07-04-editor-interaction-contract-design.md`.

## Key matrix

"consume ∅" = event consumed, nothing happens, focus stays in the editor.
"native" = TipTap/ProseMirror default; Sieve does not interject.

| Context | Tab | Shift+Tab | Enter | Shift+Enter | Mod+Enter | ArrowDown at end | ArrowUp at start | Home |
|---|---|---|---|---|---|---|---|---|
| Plain paragraph | consume ∅ | consume ∅ | native (split para) | native (soft break) | native | native | native | native |
| List item | native (indent) | native (outdent) | native | native (soft break) | native | native | native | native |
| Table cell | native (next cell; last cell appends row — adopted TipTap default) | native (prev cell; consume ∅ in first cell) | native | native (soft break) | native | native | native | native |
| Code block (sieve `code` AND native `codeBlock` — one policy for both) | indent 2 (multi-line: indent each selected line) | de-indent ≤2 per line | between an empty pair: expand to a block (see Pair characters); else newline + auto-indent (copy previous line's leading whitespace) | **escape: insert ¶ after block** | native (core exitCode — same effect as escape; undocumented alias) | exit to next block, content unchanged | exit to previous block | 1st press: first non-ws char; 2nd: column 0 |
| Diagram (edit) | indent 2 (as code) | de-indent ≤2 (as code) | as code (pair expansion, else newline + auto-indent) | **escape: insert ¶ after block** | **toggle to render mode** (cursor position preserved) | exit to next block | exit to previous block | as code |
| Diagram (render) | consume ∅ | consume ∅ | insert ¶ after (block is a caret stop) | **escape: insert ¶ after block** | **toggle to edit mode** (block selected OR render body focused — one function, two entry points) | pass to next block | pass to previous block | n/a |
| Log block | consume ∅ | consume ∅ | consume ∅ (read-only text) | **escape: insert ¶ after block** | **toggle raw↔explore** | exit to next block | exit to previous block | native |
| ai-block | consume ∅ | consume ∅ | insert ¶ after (caret stop) | **escape: insert ¶ after block** | native ∅ | pass | pass | n/a |
| web-clip | consume ∅ | consume ∅ | insert ¶ after (caret stop) | **escape: insert ¶ after block** | native ∅ | pass | pass | n/a |
| smart-image | consume ∅ | consume ∅ | insert ¶ after (caret stop) | **escape: insert ¶ after block** | native ∅ | pass | pass | n/a |
| attachment | consume ∅ | consume ∅ | insert ¶ after (caret stop) | **escape: insert ¶ after block** | native ∅ | pass | pass | n/a |

**THE WHOLE MATRIX IS OVERRIDDEN WHILE A TRIGGER PICKER IS OPEN (#38).** ↑, ↓,
Tab, Enter and Escape belong to the picker in every context above, in the
editor exactly as in the composer — see *Trigger picker* below for the rule and
for why the mechanism is precedence rather than a policy flag.

**Two chords, one meaning each (decided 2026-07-04):**

- **Shift+Enter = the universal block escape** — inside ANY sieve block (or
  with one selected), insert a new paragraph after the block and move the
  caret there. Free of clashes: HardBreak (the native Shift+Enter soft break)
  cannot exist inside `text*` blocks, and prose keeps it natively. Precedent:
  Jupyter's "Shift+Enter leaves the cell downward".
- **Mod+Enter = mode toggle**, a policy mechanism, not a special case: any
  kind with two view modes declares `modEnterTogglesMode: true` and provides
  an `onModEnter` hook. Current users: diagram (edit↔render, preserving the
  long-standing Ctrl+Enter habit), log (raw↔explore).
- **Mod+Alt+E = expand** (decided 2026-07-14, #35) — for any kind declaring
  `interactionPolicy.expandable: true` (with a `getExpandContent(node, dom)`
  renderer callback), open the block in a fit-to-window pan/zoom lightbox
  overlay. `Mod+Alt` is the appearance/view tier of the app-wide
  keyboard-shortcut taxonomy (#39) — distinct from `Mod+E` (Explain) and
  `Mod+Alt+M` (Smart Metadata), no collision. It is editor-owned, NOT a
  native-menu accelerator. Like every interaction chord, it is
  **policy-extension-owned** — per-renderer `handleKeyDown` for it is
  FORBIDDEN, the shared interaction-policy extension resolves the caret/
  selection's block and dispatches the chord. One documented exception:
  a render-mode diagram's own raw `keydown` listener also handles it,
  because in render mode focus sits OUTSIDE ProseMirror so the PM-level
  policy handler cannot see the key — the same rationale as the existing
  Ctrl/Mod+Enter render-toggle listener. **Esc** closes the lightbox
  overlay and restores focus to the editor. Current adopters: diagram
  (render mode only — `getExpandContent` returns `null` in edit mode) and
  smart-image (once the asset is resolved).
- **`expandable` is a declared capability, not just a chord** — a kind that
  declares `interactionPolicy.expandable: true` and provides
  `getExpandContent(node, dom)` (returning `{ element, title, mode }`, or
  `null` when there is nothing to expand right now) gets three
  framework-provided affordances for free: a header expand button (when the
  kind also has a `headerProvider`), a gated context-menu "Expand" item, and
  the Mod+Alt+E chord above. `getExpandContent` returning `null` (diagram in
  edit mode; image still pending/errored) suppresses all three — the
  renderer writes zero conditional wiring.
- **Ctrl(=Mod)+wheel = zoom, Ctrl+drag = pan** (inline, render-mode diagram,
  #35) — a lightweight in-place pan/zoom on the diagram render pane, distinct
  from the fullscreen lightbox. Ctrl-gated so bare wheel/click always pass
  through (document scroll, block selection); a grab cursor + hint show only
  while Ctrl is held. A per-renderer mouse gesture (NOT a key chord — the
  policy extension owns keys, not pointer/wheel), scoped to a static render
  surface. The pane uses `contain: layout paint` so the zoom transform does
  not repaint the surrounding contentEditable document in WebKit.
- **Mod+K = edit / create a link** (#67, 2026-07-27) — the ONE link chord, and
  the only way to make a link out of text ALREADY IN the document (a bare click
  never navigates). It is not the only way a link ENTERS one: pasting a URL is
  Go's doing, and the "Insert from URL" dialog's **Link** rung inserts a URL you
  do not have in the document yet. Both of those go through the same Go
  round-trip and are the same insertion in the end — Mod+K owns the caret-
  contextual case, and no chord competes with it. Two behaviours, one chord,
  chosen by what the selection is:
  - caret **inside** a `link` mark → open the link editor prefilled with that
    link's URL and label; saving rewrites the mark.
  - **non-empty text selection** with no link → open the editor with the
    selected text as the label and a blank URL; saving marks the selection.
  - anything else (bare caret in unlinked prose, a raw-text/read-only sieve
    block, a paragraph inside a sieve container whose body Go authors, a
    NodeSelection) → **native** (unhandled), so the chord stays free there.

  **Policy-extension-owned**, like every key chord —
  `editor/interaction-policy.js` resolves the context and dispatches; a
  per-renderer `handleKeyDown` for it is FORBIDDEN. It is editor-owned and
  caret-contextual, NOT a native-menu accelerator (the menu claims no `Mod+K`),
  and it is bare `Mod+K` only: `Mod+Shift+K` / `Mod+Alt+K` pass through. The
  mark mechanics (range resolution, apply) live on `ProseLink`
  (`editor/surfaces/prose-link.js`); the dialog is the shared
  `ui/link-edit-dialog.js`, the same one the smart-card block's "Edit Link…"
  opens. Editing a link is an ORDINARY TRACKED prose edit — it rides the
  existing prose→Go block-sync, has no wire verb of its own, and undoes in one
  step. The same verbs appear on the editor context menu over a link ("Edit
  Link…", "Copy Link", plus the URL itself as a header — the cheapest fix for a
  link rendering as its label alone). A hover/caret link bubble is deliberately
  NOT part of this (deferred by the owner).

- **Mod+Click on ANY link = open externally** (#67, 2026-07-27) — a link is
  ordinary markdown, not a Sieve block
  (`docs/design/archive/specs/2026-07-27-inline-block-removal-links-decision.md`), and
  in prose it carries the TipTap `link` mark. A BARE click never navigates: the
  mark is configured `openOnClick: false` because a navigating WebKit webview
  would replace the running Wails app, so a plain click is just a caret
  placement. Mod+Click hands the href to `window.runtime.BrowserOpenURL`.

  **Owner: `shell/workspace.js` `bootEditorLifecycle()`** — a document-level
  CAPTURE-phase `click` listener matching `a[href^=https?://]`. It is the ONE
  mechanism, and it is deliberately APP-GLOBAL rather than editor-scoped:
  links appear in chrome, dialogs and block renderers as well as in prose, and
  the navigate-suppression has to be unconditional in a webview.

  Consequences, all verified in the running app with CDP-instrumented
  Ctrl+Click (2026-07-27):
  - Anchors inside a sieve block body (an ai-block response, a web-clip)
    open exactly like prose links — the capture matches them too. `stopEvent`'s
    `a[href]` shield gates *ProseMirror's* processing of the click; it cannot
    stop a document-capture listener that has already run.
  - No editor- or renderer-level click handler can ever see a Mod+Click: the
    capture runs before anything on `view.dom` and calls `stopPropagation()`.
    A PM-level `editorProps.handleDOMEvents.click` that duplicated this was
    measured at 0 invocations under Mod+Click (1 under a plain click, proving
    the probe live) and was DELETED. Do not add one back.
  - A pointer gesture, not a key chord, so it is not the policy extension's;
    `editor/interaction-policy.js` carries a pointer to this row.

**Smart Home platform note:** the Home column applies to the `Home` key
(Linux/Windows; fn+Left on Mac) AND to Cmd+Left on macOS — the idiomatic Mac
line-start gesture (VS Code parity). Shift-selection variants stay native.

## Policy declaration (revised 2026-07-29)

A kind opts into behaviour **by name**. `DEFAULT_POLICY`
(`editor/interaction-policy.js`) is the complete list of flags; a kind declares
a `Partial` of it as `interactionPolicy`, and `policyFor` merges the two.

| Flag | Behaviour |
|---|---|
| `tabIndents` + `indentWidth` | Tab/Shift+Tab indent/de-indent each touched line |
| `smartHome` | Home column above (1st press → first non-ws char, 2nd → column 0) |
| `enterInsertsNewline` / `autoIndentOnEnter` | Enter column above |
| `modEnterTogglesMode` | Mod+Enter routes to the kind's `onModEnter` |
| `readOnlyText` | caret may enter, typing/Backspace/Delete consumed |
| `caretStop` (`true` \| `'render'`) | block is a single caret stop for arrows |
| `expandable` | Mod+Alt+E / header button / context-menu item |
| `surroundSelection` | typing a pair character over a selection wraps it |
| `autoClosePairs` | typing an opener inserts the pair (+ type-over, + Backspace-deletes-pair) |
| `expandPairOnEnter` | Enter inside an empty pair expands to a block |
| `blockTextSubstitution` | cancel OS text substitution (macOS smart dashes/quotes) |
| `literalGlyphs` | no ligature shaping — every character renders as itself |
| `suppressTriggers` | `@`/`/` pickers never arm in this block's text |

**`suppressTriggers` (added 2026-08-19, #38) is in `CODE_TEXT_POLICY`**, so one
line covers `code` AND `diagram` and every code-ish kind that spreads the preset
after them. `@Override`, `@media` and `@Component` sit at a line start after
whitespace, so they satisfy the `@` trigger's boundary rule and would open the
picker only to flash shut when the library search came back dry. Eligibility is
an INTERACTION POLICY decision and not a host judgement: a host that adjudicated
it would be a second declaration mechanism beside `interactionPolicy`. The
chip-like kinds need nothing — `ai-block`, `web-clip`, `smart-image`,
`smart-card` and `attachment` are all `caretStop: true`, so no caret enters their
text and no trigger can arm there in the first place.

**`CODE_TEXT_POLICY` is a declaration-time preset, not a genre.** Kinds whose
content is literal source text spread it (`{ ...CODE_TEXT_POLICY }`) and
override individual keys after it — `code` takes it whole, `diagram` adds
`modEnterTogglesMode`/`caretStop: 'render'`/`expandable`. There is deliberately
**no** `genre`/`textType` field: a category would be a second declaration
mechanism beside the flags, and it lies as soon as one kind wants code-style
autoclose with prose-style Enter. The preset gives the "yep, this is code"
ergonomics while `policyFor` still only ever sees plain flags.

**Flags are born with their reader.** Never add a flag here before something
consumes it, and never leave one whose declarers have gone. `readOnlyText` sat
in `DEFAULT_POLICY` with a live branch that no shipped kind switched on — log's
declaration had lost it while both its comment and its guard plugin claimed
otherwise — so log's Backspace/Delete were unguarded and only a test FakeBlock
exercised the branch. Fixed 2026-07-29; the same commit split the old `rawText`
flag (which meant three things and implemented one) into `tabIndents` +
`smartHome`.

## Pair characters (decided 2026-07-29)

The pair table is shared and frozen: `"` `'` `` ` `` `(` `[` `{`. Markdown
emphasis (`*` `_`) is deliberately excluded — Mod+B/Mod+I own bold/italic and a
literal asterisk is common enough that surrounding it would fight the user.

| Behaviour | Flag | Rule |
|---|---|---|
| Surround | `surroundSelection` | Typing a pair character over a NON-EMPTY selection wraps it instead of replacing it. The selection is preserved inside the pair, so the gesture nests. Implemented as two INSERTIONS, never a replacement — a prose range carries marks, and rewriting it would flatten bold/links. |
| Autoclose | `autoClosePairs` | Typing an opener at a collapsed caret inserts the pair. NOT when the next character is a word character (it would strand the closer); for symmetric pairs, also not when the PREVIOUS character is one (`don` + `'`). |
| Type-over | `autoClosePairs` | Typing a closer already sitting at the caret moves past it. Checked BEFORE autoclose, since `"`/`'`/`` ` `` are their own closers. |
| Backspace-deletes-pair | `autoClosePairs` | Backspace between an empty pair removes both halves. Not optional — autoclose without it strands orphaned closers and is worse than no autoclose. |
| Enter expansion | `expandPairOnEnter` | Enter between an empty pair expands to opener line / indented blank line with the caret / closer line at the original indent. This is where a brace style like `if x {` ⏎ lives; it subsumes auto-indent for that keystroke. |

**Who declares what.** `code` and `diagram` take all five via `CODE_TEXT_POLICY`.
`prose` declares `surroundSelection` ONLY: auto-pairing a `(` mid-sentence is the
first thing anyone disables, and `'` would fight every apostrophe. The markdown
breakglass textarea declares surround + guard + glyphs, but NOT autoclose — it
holds the whole document, prose and fences together, and cannot tell which the
caret is in. Autoclose stays where the policy can be sure.

**Both surfaces, one rule.** The transforms are pure functions over
`(text, from, to, char, policy)` returning positional ops; the PM surface applies
them as a transaction, the markdown textarea via `applyTextEdit` + `execCommand`
(so each surface's native undo stack records one step). Two call sites, one rule
— a divergence would be a keyboard behaviour that silently stops working when you
switch to markdown mode.

## OS text substitution + ligatures (decided 2026-07-29)

Two different problems that both make `--` stop being `--`, with two different
fixes. Kinds declaring `blockTextSubstitution` cancel `beforeinput` events whose
`inputType` is `insertReplacementText` — the type reserved for
spellcheck/autocorrect/substitution, so ordinary typing (`insertText`) and
deliberate pastes (`insertFromPaste`, including a genuine em dash) are untouched.
This matters because macOS WebKit rewrites `--` + space to `–` inside
contentEditable AND textareas; it is a real character mutation that corrupts a
PlantUML or mermaid fence. WebKitGTK does not do it. Confirmed on macOS
2026-07-29, in markdown mode.

Kinds declaring `literalGlyphs` get `font-variant-ligatures: none`, applied as a
ProseMirror **Decoration** (`.sieve-literal-glyphs`) by the policy extension —
one read site, and the sanctioned way to style native PM nodes, which revert a
directly-set class. The bundled mono families all ligate `--` into a single long
dash, making `--`, `---` and `----` visually identical when PlantUML treats them
as three different things.

**The dividing line: the policy owns input events, renderer styles own glyphs.**
`literalGlyphs` is declared in the policy but realised in CSS; that is the one
place appearance reads the policy, deliberately kept to a single site.

## Caret contract

1. No dead-ends: every position reachable by arrows alone; a trailing
   paragraph is guaranteed after a final structured block (trailing-node).
2. Entering an editable raw-text block from above: text caret on FIRST line,
   column preserved. From below: LAST line. Never a NodeSelection, never
   skipped.
3. Leaving a block never modifies its content (no phantom newlines).
4. Read-only blocks (web-clip, ai-block, diagram-render, smart-image,
   smart-card, attachment) are a single caret stop: arrow onto → whole-block selection; arrow again → past
   it. Enter or Shift+Enter while selected inserts a paragraph after (this is
   how prose is added between two adjacent read-only blocks).
5. Click-to-own-selection (framework-uniform, every kind): a click anywhere in
   a block makes it the caret/selection owner — never silent nothing.
   - Click in editable text (a block's `contentDOM`) → text caret there.
   - Click on any non-editable region (a custom render area, the log Explore
     table, an image) → whole-block `NodeSelection` + editor focus, so keyboard
     chords (Mod+Enter mode toggle, arrows, escape) route to the block.
   - Interactive controls and the header/gutter chrome own their own clicks and
     do NOT move the document selection (the gutter handle drives its own
     block-selection/reorder).
   - A drag that leaves a text selection inside the block is preserved (copy);
     it does not collapse into a block selection.
   Owned by `shouldClaimBlockSelection` + the `mouseup` seam in
   `sieve-block-extension.js` — never per-renderer.
6. Typing always goes somewhere visible after entering a block.
7. Diagram edit↔render round-trip restores cursor position (block-start if
   content changed).
8. **Double click OPENS an attachment block** (#38, 2026-08-19). Single click on
   it is rule 5 unchanged — it selects the block, because a block sits in the
   editing flow and must behave like one. The ai-block's FOOTER chip stays
   single-click to open: it is not in that flow (it is provenance under an
   answer), and the two differing is deliberate rather than an accident.
   What opening means is decided by ONE rule, off the block's single address:
   - points (`uri`) → the container, via `window.sieveWorkspace.openAddress`
     (`MentionService.resolve` → the Router) — the same path ai-block chips take.
   - holds (`src`) → the `sieve:attachment-open-asset` INTENT on `document`,
     answered on desktop by revealing the document directory in the OS file
     manager. The renderer names no mechanism, so a hosted build answers the
     same gesture differently without the block changing.

   The chevron ON the chip is not an open gesture: it reveals `summary` in
   place, and it swallows the double click that lands on it. Reading the asset
   inside Sieve is its job, which is what lets opening stay this simple.

## Block insertion placement (decided 2026-07-04)

Additive block creation (toolbar insert, AI-block create, extract, smart-paste,
paste-slice, drop) places the new block **after the caret's top-level block —
never splitting it**. ONE uniform exception:

**An empty paragraph is a placement target, not an anchor.** If the caret's
block is a bare empty paragraph (type `paragraph`, empty or whitespace-only),
the new block **takes its index and the paragraph is consumed** — no orphan
blank line above the insertion. Empty headings/list items/table cells are NOT
consumed (their emptiness carries chosen structure). Sole-block documents keep
the paragraph — it becomes the paragraph after the new block.

Mechanism (no replace op, no backend emptiness-sniffing): at COMMIT time the
frontend deletes the paragraph as an ordinary tracked prose edit (the same
delete-block op a backspace emits), flushes the block-sync so Go's shadow
applies the delete first, then sends create-block at the freed index — two
existing primitives, ordered on one socket. Capture-time never consumes: a
cancelled dialog must not eat the blank line (known gap: the async image-upload
dialog path commits outside the editor and does not consume — acceptable).

## Converting a prose link (decided 2026-07-27, #67)

A link is ordinary markdown, so it is a **mark over a text range**, not a block:
it has no id, and its enclosing block is the whole paragraph. Right-clicking one
offers the same Convert items every other source gets (smart-card, web-clip —
one discovery path, `detectAndAppendExtractions`), but the in-place block
TRANSFORM those offers normally mean would replace the paragraph and destroy the
sentence around the link. The playback for a **range source** is instead, uniform
for every target kind:

> Remove the link's own range from the prose, place the new block **after** that
> paragraph, and drop the paragraph if the delete left it empty.

- Link alone in its paragraph (the common case after a URL paste) → behaviourally
  identical to the block Transform: the paragraph goes, the block takes its slot,
  no blank line left behind.
- Link mid-sentence → the link is consumed, the block lands below, the sentence
  survives with a gap where the link was.

Mechanism — **no new server operation**: the two deletes are ordinary TRACKED
prose edits (the same undo sanctity as the empty-paragraph consume above), the
block-sync is flushed so Go's shadow applies them before the create arrives on
the same socket, and the create is the existing additive `extract` at the freed
index. `AbstractEditor.extract` owns it (`sourceRange` ⇒ `#consumeSourceRange`);
the MENU keeps the user-facing verb it was offered ("Convert to …") — which wire
op carries it is not the user's concern. This is the frontend twin of Go's
`SupportedActions.asAdditive` demotion for a source nested inside a composite.

The link's ContentEntry views MUST include `text/html` (`<a href>`): a rendered
link's plain text is the label alone, so a text/plain-only entry set carries no
URL and every processor declines — zero offers, silently.

## Copy matrix

| Selection | Result |
|---|---|
| Partial text inside any sieve block (PM content — code/diagram/log-raw — OR a non-PM region like the log Explore table or the ai-block question title) | **Uniform rule:** text/plain + text/html follow the selection (the DOM highlight, or the PM range as fallback); `sieve/slice` + `sieve/<kind>` carry the WHOLE block (only-meaningful-whole). NEVER deferred to native PM copy — a slice inside a `defining`/`code` block re-wraps the whole node, so native copied everything. Served by the copy handler's per-block loop + `domSelectionTextInside`. **A highlight in a block's READ-ONLY region** (contentEditable=false DOM PM cannot track — the ai-block question title, the log Explore table) leaves PM's own selection on whatever block last held the caret; the handler re-targets the visited range onto the highlighted block via `domSelectionBlockRange`, so copy serves the block the user highlighted, not the stale one. |
| Single whole sieve block (gutter / NodeSelection) | text/plain + text/html + `sieve/slice` + `sieve/<kind>` + renderer custom views |
| Gutter block-range | `sieve/slice` = ordered ContentEntry sets, one per block |
| Smart-image node selection | real bitmap to clipboard |

## Paste matrix

| Target | Content | Outcome |
|---|---|---|
| Prose | URL / HTML / image / matchable | silent smart conversion (Go FirstPasteMatch) — by design |
| Prose | plain text (no match) | local insert |
| Raw-text block (code/diagram-edit) | anything | literal text (PM `code: true` on the node — NOT a policy read; the old `rawText` flag claimed this and never implemented it) |
| Anywhere | `sieve/slice` (>1) | Go paste-slice reconstructs blocks |
| Anywhere | ```` ```ai-block ```` fence | ai-block re-import |
| Log block | anything | consumed (read-only) |

## Drop matrix (revised 2026-08-21, #86)

A drop is CLAIMED by flavour — `dataTransfer.types` advertising `text/uri-list`
— and ROUTED by URI scheme after an async read. Two platform facts force that
split: WebKitGTK leaves `dataTransfer.files` and `kind: 'file'` items empty for
a file-manager drag (the page gets nothing but a `file:///…` string), and its
synchronous `getData('text/uri-list')` answers `''` on a real drag even while a
string ITEM carries the list — so the claim (which must happen inside the
handler, where `preventDefault` still works) cannot depend on content, and the
content comes off the items API afterwards.

| Dragged from | Arrives as | Outcome |
|---|---|---|
| The desktop (file manager) | `text/uri-list` of `file:` URIs | Claimed; the list is sent verbatim as a `native-drop` paste; **Go reads the files** and makes one block per file, in drag order, from the drop position. Kind is the paste registry's decision as always — `image/*` to smart-image, everything else to attachment. |
| A browser (a link) | `text/uri-list` of an `http(s)` URI | Claimed (indistinguishable from a file drop until the async read), then the URI is REPLAYED as text at the drop position — the outcome PM native handling used to produce. |
| Within the document, or any text drag | no `text/uri-list` flavour | Not claimed — PM handles it natively. |
| Into a prompt pseudo-document | anything | Not claimed — a prompt is a plain file with no block tree. |

Placement follows the block-insertion rule above, at the DROP coordinate rather
than the caret: the index is PEEKED (side-effect-free) before the round trip and
the empty-paragraph anchor is consumed only once Go confirms a block — a drag
naming a file this machine no longer has answers `none`, and the caret's blank
line has to survive that.

## App-Level Chords

**Ownership rule (NORMATIVE).** The native menu (`main.go` `buildMenu`) is the
**single owner** of every app-level chord. A menu item declares the accelerator
and, in its callback, **calls the component API directly**
(`window.sieveWorkspace…` — with optional-chaining guards) or runs an
`htmx.ajax` call. The `sieve:*` `CustomEvent` hop is gone for the migrated rows
(P2.C); remaining `sieve:*` events are in-page seams, not menu transport. This
is the only reliable ownership on both platforms — on macOS native menu
accelerators intercept chords **before** the webview, so any editor/DOM keydown
binding on the same chord is silently shadowed; on Linux GTK the webview sees
keys first. Owning them in the menu makes the resolution identical everywhere.

Consequences:

- The TipTap editor keymap (`extensions.js`) may bind **only caret-contextual
  chords the menu does not claim** (currently `Mod+E` Explain — `Mod+Shift+A` Ask
  LEFT the editor keymap in P4.E, see below; no menu item exists for either).
- **Document-level DOM `keydown` shortcut listeners are FORBIDDEN.** Insertion
  and app gestures ride the menu → event path, never a global `keydown`.
- Never bind the same chord in two places, even to the same action — the menu
  wins on Mac and the duplicate is dead weight.
- Dev-browser note: with no native menu, menu-owned chords are simply absent —
  since P2.C this includes markdown-mode `Mod+S`/`Mod+J`, whose quarantined
  transitional `keydown` listener is removed. The transitional P2.B exception
  is gone. The `Mod+Shift+A` **Ask** chord is now the ONE sanctioned document-level
  `keydown` listener: it is owned by the **AskPanel** (a Workspace child, not the
  editor), because the Ask panel is chrome that must toggle regardless of which
  editor or block has focus, and the menu deliberately does not claim the chord.
  This is the P4.E landing of the formerly-ledgered `editor.js` ask-focus router —
  the editor keymap no longer binds Ask at all (`AiShortcuts.onAsk` removed), so
  there is no double-binding; the listener is no longer transitional.

### Menu accelerator table

| Chord | Menu item | Action |
|---|---|---|
| Mod+N | File › New Note | `htmx.ajax` POST `/api/note/new` |
| Mod+S | File › Save | `window.sieveWorkspace?.activeTab?.editor?.flushSave()` |
| Mod+W | File › Close Tab | `htmx.ajax` POST `/api/tabs/close/{id}` |
| (menu-click only) | File › Export › Clipboard (Markdown) | `window.sieveWorkspace?.copyDocumentAsMarkdown()` |
| Mod+Shift+O | File › Open Library… | `window.sieveSelectLibrary()` |
| Mod+, | File › Settings/Preferences | open settings dialog |
| Mod+Q | File › Quit (non-Mac) | `wailsruntime.Quit` |
| Mod+\\ | View › Toggle Sidebar | `htmx.ajax` POST `/api/session/sidebar/toggle` |
| Mod+Shift+I | View › Toggle Meta Panel | `htmx.ajax` POST `/api/session/meta/toggle` |
| Mod+Shift+P | View › Toggle Prompts | `htmx.ajax` POST `/api/session/prompts/toggle` |
| (menu-click only) | View › Toggle Line Numbers | `htmx.ajax` POST `/api/session/linenumbers/toggle` |
| Mod+Shift+M | View › Toggle Editor Mode | `window.sieveWorkspace?.activeTab?.editor?.toggleMode()` |
| Mod+F | Edit › Find › Find… (mac: Find › Find…) | `window.sieveWorkspace?.toggleSearch()` |
| F3 (non-mac) | Edit › Find › Find Next | `window.sieveWorkspace?.searchNext()` |
| Mod+G (mac) | Find › Find Next | `window.sieveWorkspace?.searchNext()` |
| Shift+F3 (non-mac) | Edit › Find › Find Previous | `window.sieveWorkspace?.searchPrev()` |
| Mod+Shift+G (mac) | Find › Find Previous | `window.sieveWorkspace?.searchPrev()` |
| Mod+Shift+F | Edit › Find › Find in Notes… (mac: Find › …) | `window.sieveSidebarSearch()` |
| Mod+J | View › Toggle AI Blocks | `window.sieveWorkspace?.activeTab?.editor?.toggleAiBlocks()` |
| Mod+P | View › Quick Switcher | open quick-switcher dialog |
| Mod+Shift+T | View › Show Toolbar | `htmx.ajax` POST `/api/session/toolbar/toggle` |
| Mod+= | View › Increase Editor Font | `htmx.ajax` POST `/api/settings/editor-scale/step?dir=up` |
| Mod+- | View › Decrease Editor Font | `htmx.ajax` POST `/api/settings/editor-scale/step?dir=down` |
| Mod+0 | View › Reset Editor Font | `htmx.ajax` POST `/api/settings/editor-scale/step?dir=reset` |
| Mod+Alt+M | Tools › Smart Metadata | `window.SieveAI.smartMetadata()` |
| Mod+Shift+E | Tools › Smart File | `window.SieveAI.smartFile()` |
| Mod+Shift+Return | Tools › Keep & Smart File | `window.SieveAI.keepAndSmartFile()` |
| Mod+Shift+W | Tools › Insert WebClip | `window.sieveWorkspace?.openWebClipDialog()` |
| Mod+Shift+L | Tools › Insert URL Card | `window.sieveWorkspace?.openUrlCardDialog()` |
| Mod+Shift+D | Tools › Insert Diagram | `window.sieveWorkspace?.activeTab?.editor?.createBlock('diagram', {})` |
| Mod+/ | Help › Shortcuts | open help dialog |

Editor-owned caret chords (NOT in the menu): `Mod+E` = Explain block (bound in
`extensions.js`); `Mod+K` = edit/create a link (owned by the interaction-policy
extension — see its row above). (`Mod+Shift+A` Ask is NOT editor-bound — the
AskPanel's document-level listener owns it; see "Consequences" above.)

**Why find sits with the editing verbs, and why its home differs per platform.**
Find/Replace is an editing concern, not a View one (View is for what you look at,
not what you operate on). Where the Find submenu hangs is forced by a Wails
v2.12.0 limitation:

- `menu.EditMenu()` is a bare *role marker* with a nil `SubMenu` — the native
  backend expands it, so nothing can be appended to it.
- The individual role helpers (`Undo()`/`Cut()`/`Copy()`/`Paste()`/`SelectAll()`)
  **and their `Role` constants** are commented out in `pkg/menu/menuroles.go`, and
  no platform backend reads `Role` at all — so a hand-built Edit menu cannot
  supply native editing items either.

So macOS keeps the role Edit menu (native Undo/Cut/Copy/Paste) and gets **Find as
its own top-level menu** — a normal Mac text-editor idiom (Sublime Text, BBEdit).
Linux/Windows have no role Edit menu today, so they get the conventional
**Edit ▸ Find**. If a future Wails release un-comments the role items, collapse
macOS onto Edit ▸ Find too.

Each verb gets ONE row with ONE platform-appropriate accelerator: F3/Shift+F3 on
Windows/Linux, Mod+G/Mod+Shift+G on macOS (where Ctrl+G conventionally means
"go to line" on the former, so binding it there would be actively wrong). Do NOT
"restore" the other platform's chord as a second hidden row: `menu.MenuItem`
carries exactly one `Accelerator`, and `Hidden: true` short-circuits *before*
accelerator registration on all three backends (confirmed in the Wails v2
source), so a hidden duplicate silently never binds.

`SearchOverlay` exposes the real verbs (`next()`/`prev()`, mirroring the ↓/↑
buttons including the n/N stats refresh) via
`window.sieveWorkspace.searchNext()`/`searchPrev()` — when the overlay is closed
these OPEN it (conventional "start searching") rather than silently advancing a
hidden search. Replace… slots into the same Find submenu when #61 lands.

## Trigger picker (revised 2026-08-19, #74 P4/P5/P6 + #38)

**ONE picker, two hosts.** The `@`/`/` picker is a single `TriggerPopover` over a
`TriggerHost`: the composer's is its textarea (`TextareaHost`, a panel-anchored
placement), the document's is a ProseMirror caret (`ProseMirrorHost`, a
caret-anchored one). The keyboard model, the token scan, the abandonment state
machine and the scroll-into-view fix are written ONCE and are identical in both
— which is the point, and the reason a second popover was refused. What differs
is stated where it differs: the composer's half is the rest of this section, the
document's is *The same picker in the document* at the end of it.

### In the composer

The Ask panel's textarea is chrome, not an editor surface — none of the key
matrix above applies to it. Two owners intercept keys there, and nothing else
does:

- **`TriggerPopover`** (`frontend/src/static/shell/trigger-popover.js`) — a
  capture-phase `keydown`, active **only while the picker is open**;
- **`AskPanel`** (`frontend/src/static/shell/ask-panel.js`) — the bubble-phase
  `keydown` that already owned Enter/Escape, and now owns **Backspace at an
  attachment token's right edge** as well.

Everything else falls through to the browser's own text editing, unchanged.

| Key | While the picker is open |
|---|---|
| ↓ / ↑ | move the selection (wraps; scrolls the active row into view — #63) |
| Tab | accept the selected candidate |
| Enter (no Shift) | accept the selected candidate — the panel's send is **not** reached |
| Shift+Enter | falls through (newline), picker stays open |
| Escape | **abandon the token** — the picker closes and does not reopen as you type on; the panel stays open |

Accept and dismiss both `stopImmediatePropagation`, which is what keeps a
completion from also sending the message.

| Key | In the composer, picker open or shut |
|---|---|
| Enter (no Shift) | send |
| Escape | dismiss the panel |
| **Backspace** | **when the caret sits at the right edge of an accepted `@Title` token and nothing is selected: deletes the WHOLE token, its trailing gap, and its chip.** Anywhere else — including over a selection, and with any of Ctrl/Cmd/Alt held — it falls through as an ordinary Backspace |

**Two triggers, one picker.** `/` (slash commands) and `@` (document mentions)
are PROVIDERS on the one popover, not two popovers: the keyboard model, the
positioning and the dismissal are written once. A provider contributes only its
trigger character, its two token predicates, its candidate search and what
accepting does. There is no key handling in a provider.

**The token predicates** — one per side of the trigger, and the reason the scan
is a token-under-caret walk rather than a `value.startsWith()` test. Each trigger
overrides exactly one; neither is an if-branch in the scanner.

| | `acceptsBoundary` — what precedes the trigger | `acceptsPrefix` — how far the token runs past it |
|---|---|---|
| `/` | **position 0 only** — a command is a whole-line verb | *(default)* ends at the first whitespace |
| `@` | *(default)* start of text or after whitespace, so `me@example` is an address and never a mention | **spans up to 4 words / 60 chars**, never a newline |

`@` is sticky because a document is named in words: `@sprite sheet an` is still
one token narrowing towards "Sprite Sheet Analysis". `/btw hello` is a command
plus an argument, so the picker closes at the space — but moving the caret back
inside the command name (`/bt|w hello`) re-offers it, which is the one
intentional difference from the pre-#74 popover.

**Abandoning a token.** A sticky token must be able to stop, or an `@` typed in
an ordinary sentence would query on every keystroke and ambush the typist with a
picker that swallows Enter. Three things abandon the token under the caret:

- **it goes dry** — a query returns zero candidates. Nothing is lost: both
  providers narrow monotonically, so a prefix that matched nothing cannot match
  more once it grows;
- **Escape**;
- **acceptance** — otherwise the completed `@Sprite Sheet Analysis ` is itself a
  legal token that matches the candidate just accepted, and the picker reopens on
  top of its own result.

Abandonment is keyed to **(trigger index, the prefix at which it stopped)**.
Typing forward stays abandoned; backspacing to a shorter prefix re-arms it, so a
typo is recoverable. A blank prefix is never recorded — a bare `@` has asked
nothing.

The record is **forgotten when the composer clears** (`TriggerPopover.reset()`,
called from the panel's `#clearComposer`). It is keyed to an index in text that a
send has just destroyed, and a document *created* mid-session would otherwise
stay unfindable behind a prefix that went dry before it existed.

**An attachment exists only if a candidate is ACCEPTED.** `@` followed by prose
that matches nothing stays plain text: no chip, no best guess, no auto-attach.

### The chip is a view of the token (#74 P6)

**The `@Title` tokens in the message are the truth; the chips are that data
drawn.** The text is what you edit — there is no second place to edit it. The
invariant is one-way and is what makes a silent drop impossible:

> **A chip implies a token. A token does not imply a chip.**

So `@Auth Design` typed as prose and never accepted is just prose (above), while
a chip can never outlive the token it claims to represent. Reconciliation runs on
**every composer `input`**, not at send: breaking a token removes its chip the
moment it stops matching, rather than the UI claiming "attached" until send drops
the attachment with no answer and no explanation.

| Gesture | What it does |
|---|---|
| Backspace at a token's right edge | deletes the whole token, its gap, and its chip (the table above) |
| select-through-and-delete, cut, paste-over, retype | the chip goes as soon as the token stops matching |
| the chip's ✕ | deletes the `@Title` token from the message as well — the same disagreement pointing the other way — and **forgets the document** (below) |
| undo, or retyping the title | **re-attaches** *unless the document was ✕'d*: matching is on exact title text, and every candidate accepted since the composer was last cleared is retained, so the chip comes back with its token |

**The ✕ forgets; editing the text does not.** Both gestures remove the chip and
its token and differ only in INTENT, which is the whole difference. ✕ means "I do
not want this attached", so it is final: its document leaves the retained pool and
writing that title again later — `as @Auth Design says…` — is ordinary prose, not
a silent re-attach of what the user just refused. Every text edit, atomic
Backspace included, means "I am editing my sentence", so its document stays
pooled and the token coming back re-attaches it. A ✕'d document returns the
normal way: accept it from the `@` picker again. Forgetting is per-URI, never
per-title — with two "Notes" attached, ✕ on one cuts only its token and leaves
the survivor resolving to the other document.

**Only text edits are undoable.** Ctrl+Z restores any chip whose token an
ordinary edit removed, because the browser's native undo stack holds that edit
and reconciliation follows the restored text. It does **not** restore the two
programmatic gestures — atomic Backspace and the chip's ✕ — because they assign
`textarea.value`, which never enters that stack. Deliberate: routing them through
`document.execCommand` to buy undo is not worth depending on a deprecated API.

Two more consequences worth naming:

- **A send forgets everything.** `clear()` empties the retained pool, so a title
  typed after a send is prose, not a resurrected attachment.
- **Detaching demotes.** With two attachments sharing a title (`@Notes and
  @Notes`), deleting one token must drop exactly one chip *and leave the right
  one*. The detached attachment moves to the back of the pool (or leaves it, for
  a ✕) before the pairing is redone, so the surviving token pairs with the
  attachment the user did not touch.

Programmatic edits to the composer text (the two deletion gestures) go through
`TriggerPopover.applyOwnEdit()` — the **same** `#completing` guard acceptance
uses, so the `input` they fire is understood as ours: it neither reopens the
picker on the token just deleted nor records an abandonment for text that no
longer exists.

### The header shows the subject; the footer shows the context (#74)

**The panel header is a view of the composer text**, derived on the same `input`
event and for the same reason as the chips: a label set when the panel opened
goes on claiming "Ask About Document" over a `/btw` the user has already typed.
You are not asking *about* the target there — you are invoking a command that
merely receives it.

| Composer text | Header |
|---|---|
| anything that is not a known command | `Ask About <target label>` (or `Ask Follow-up`) — unchanged |
| an **exact** match against a known command, args or not (`/btw`, `/btw what did I miss`) | `/btw` |
| a partial or unknown slash word (`/b`, `/bt`, `/nosuch`) | the target label — **no** swap |

The exact-match rule is what stops the header flickering through `/b`, `/bt` on
the way to `/btw`; "known" is `CommandService.resolve()`, the same predicate
dispatch uses, so a header can never name a command a send would not run. It
reverts the moment the token goes — no send, no selection event required — and a
selection change never stomps it: the two are different questions.

**The target renders as a chip in the footer**, left of the attachment chips, so
that a message aimed at a command still shows what it will act on.

- **View-only.** The editor owns the selection; the panel draws it. A target chip
  has **no ✕** — the cross keeps exactly one meaning in this footer, *drop an
  attachment* — and the difference is said with the missing button and an
  outline-instead-of-fill, never with contrast.
- **Not an attachment.** It never enters the manifest or the persisted attrs, and
  a send leaves it standing: the selection outlives the message. Both are
  coordinate chips and share one appearance (`.ask-chip, .ask-target-chip`) —
  one points at another document, one at the local target.
- **One chip today.** It carries `SelectionContext.target.label`, the string the
  header used to show. A chip **per block** of a multi-block selection is
  deliberately *not* shipped: `blockIds` are ids and `blockKind` is the primary
  block only, so per-block labels would need a new per-block noun rule, a new
  `SelectionContext` field and a ruling on whether label churn belongs in the
  meaningful diff — and `blockIds` is the selection SPAN, not the target extent,
  so a caret in flowing text (target: the whole document) would chip the one
  paragraph it sits in and misdescribe what a send does. Tracked separately.

### The same picker in the document (#38)

The editor hosts the SAME popover, with `@` only: `/` is a composer verb (a slash
command runs against the message being written, and a document has no message).

**Where the picker's keys sit in the precedence order.** The popover binds
`keydown` in the CAPTURE phase on `view.dom`. ProseMirror installs exactly one
BUBBLE-phase listener on that same element and dispatches every keymap from
inside it — core, the pre-core `editorProps` Enter family, and the priority-50
interaction-policy backstop alike. A capture listener on the same element
therefore runs first, and the popover's `preventDefault()` +
`stopImmediatePropagation()` mean ProseMirror never sees the key at all. So the
picker's claim on the keyboard is a PRECEDENCE fact, not a policy flag, and no
kind declares anything for it.

| Key | While the picker is open in the editor |
|---|---|
| ↓ / ↑ | move the selection — the caret does not move, and no block's arrow behaviour (caret stops included) is reached |
| Tab / Shift+Tab | accept the selected candidate. Shift+Tab is matched as Tab **or** `ISO_Left_Tab` **or** keyCode 9 — WebKitGTK reports the X11 keysym where Chrome says 'Tab', and matching the name alone let Shift+Tab fall through to the policy's Tab backstop |
| Enter (no Shift) | accept — the paragraph is **not** split, and `policyEnterKeydown` is never reached |
| Shift+Enter | falls through: the universal block escape keeps its meaning even with a list up |
| Escape | **abandon the token** — the picker closes, the text is left exactly as typed, and **the block-escape behaviour behind it is not reached**. It does not merely hide: a picker the user dismissed must not reappear on the next keystroke |
| anything else | falls straight through to the editor |

A SHUT picker intercepts nothing whatsoever — every key above behaves as the
matrix at the top of this document says.

**The picker never arms where `suppressTriggers` is declared** (Policy
declaration, above), so a `@Override` in a code or diagram block is text.
Elsewhere the token rules are the composer's, unchanged: `@` keeps the default
boundary (so `me@example` is an address), spans up to 4 words / 60 chars, and
abandons on Escape, on going dry, and on acceptance.

**Accepting makes a BLOCK, not text.** This is the one behaviour that genuinely
differs between the two hosts, and it differs because the hosts do: a textarea
has nowhere to put a block, so the composer echoes `@Title` and draws a chip
beside it; a document does, so the token is deleted and an `attachment` block
carrying the `uri` takes its place. There is no `@Title` text left behind to
reconcile — the chip in the document IS the reference.

**Where it lands is the ordinary rule, not a new one**: the caret is left where
the token was, so a line the token had to itself becomes the block, and a line
with prose still on it puts the block on the next one (Block insertion
placement, above).

### Gestures on a block chip (#38)

| Gesture | On an `attachment` block | On the ai-block's FOOTER chip |
|---|---|---|
| single click | selects the block, like any other block | opens the coordinate |
| double click | opens: a `uri` opens its container, a `src` reveals the file where it lives | — |

The two differ deliberately and it is recorded here so it does not later read as
an accident. A block sits in the editing flow, so a single click must place the
caret and select it exactly as it would for any other block — which leaves
double click for opening. The ai-block's footer chip is NOT in that flow (there
is no caret in it and nothing to select), so single click can mean open there
without ambiguity.

Reading the asset is the chevron's job rather than double click's: expanding
shows the summary, and for a text asset a preview. The open gesture is an INTENT
the renderer emits, never a call to a mechanism — the desktop build answers it by
revealing in the OS file manager, and a hosted build answers it differently
without reopening the contract.

## Deferred (recorded, not shipped)

- Bracket/quote auto-pairing in code blocks (`autoPair` policy flag) —
  deferred; must not fight PM input rules.
- Per-language indent width — uniform 2 until proven insufficient.
