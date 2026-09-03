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
  `lens/document-editor/interaction-policy.js` resolves the context and dispatches; a
  per-renderer `handleKeyDown` for it is FORBIDDEN. It is editor-owned and
  caret-contextual, NOT a native-menu accelerator (the menu claims no `Mod+K`),
  and it is bare `Mod+K` only: `Mod+Shift+K` / `Mod+Alt+K` pass through. The
  mark mechanics (range resolution, apply) live on `ProseLink`
  (`lens/document-editor/surfaces/prose-link.js`); the dialog is the shared
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
    `lens/document-editor/interaction-policy.js` carries a pointer to this row.

**Smart Home platform note:** the Home column applies to the `Home` key
(Linux/Windows; fn+Left on Mac) AND to Cmd+Left on macOS — the idiomatic Mac
line-start gesture (VS Code parity). Shift-selection variants stay native.

## Per-mount key claims (decided 2026-08-28, #118)

The key matrix above describes what a key means **in a context inside a
document**. A second question sits above it, because a page now holds more than
one live editor: which *mount* gets the key at all.

**A key claim is per-mount configuration, resolved by focus. There is no global
claim table.** A lens declares the keys its mount owns by overriding
`AbstractEditor.claimKey(event)`; the base claims nothing, so an editing lens
that has not said otherwise behaves exactly as this contract's matrix says. The
surface asks the claim **first**, from `editorProps.handleKeyDown` — the same
pre-core hook the Enter family already routes through — and returns consumed
when the lens claims. Precedence between two live editors therefore needs no
arbitration: the hook fires on the view the keystroke landed in.

The resulting order for one keystroke, highest first:

1. **The trigger picker**, while open — a capture-phase listener on `view.dom`
   that calls `stopImmediatePropagation`, so nothing below ever sees the key.
2. **The mount's claim** — `claimKey`, pre-core.
3. **The interaction policy** — the Enter family (pre-core, `editorProps`) and
   the Tab/arrow/Home backstop (priority-50 plugin).
4. **The editor core** — TipTap's own keymaps.
5. **The host chrome** — a bubble-phase listener on the panel or the document.

### What each mount claims

| Mount | Claims | Everything else |
|---|---|---|
| Note / document (`NoteEditor`) | **nothing** | the matrix above, unchanged |
| Prompt (`PromptEditor`) | **nothing** | the matrix above, unchanged |
| Composer (`ComposerEditor`) | `Mod+Enter` → send the message | the matrix above, unchanged |

**The composer is EDITOR-FIRST (revised 2026-08-28, #118):** it claims exactly
one chord, `Mod+Enter`, and nothing else. Bare `Enter`, `Shift+Enter` and
`Alt+Enter` are unclaimed and fall through to the surface exactly as they do
in `NoteEditor` — list continuation, a code/diagram fence's own newline, an
empty list item's exit, HardBreak all behave identically in a draft and in a
document, so muscle memory carries over instead of a context-dependent Enter
surprising the author mid-sentence. The convention matches rich block-editor
chat inputs elsewhere (Slack, Notion AI): Enter stays structural, Mod+Enter
sends.

This is a deliberate **divergence** from the note mount's own `Mod+Enter`: in
`NoteEditor` it is `modEnterTogglesMode`, a per-kind view toggle a Sieve block
declares (diagram edit↔render, log raw↔explore) — an affordance a draft has
none of, since `ComposerEditor` mints no blocks (`_innateCapabilities.blocks`
is `false`). The two mounts never compete for the chord because only one is
ever focused at a time; `Mod+Enter` means "send" in the composer and "toggle
this block's mode" in the note editor, and each mount's `claimKey` is the
sole place either meaning is decided. `Escape` is unclaimed in the composer
too — it belongs to the picker while one is open, and to the host panel
otherwise (below).

## Policy declaration (revised 2026-07-29)

A kind opts into behaviour **by name**. `DEFAULT_POLICY`
(`lens/document-editor/interaction-policy.js`) is the complete list of flags; a kind declares
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
| `suppressTriggers` | no trigger picker (`@`, `{`, `/`) ever arms in this block's text |

**`suppressTriggers` (added 2026-08-19, #38) is in `CODE_TEXT_POLICY`**, so one
line covers `code` AND `diagram` and every code-ish kind that spreads the preset
after them. `@Override`, `@media` and `@Component` sit at a line start after
whitespace, so they satisfy the `@` trigger's boundary rule and would open the
picker only to flash shut when the library search came back dry. A `{` opening a
scope is the same case and far more common, and the same one line covers it.
Eligibility is
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
   answer), and the two differing is deliberate rather than an accident. The
   footer is the ONLY place an ai-block draws a chip — its question draws none,
   because a reference the question names is either an attachment, which the
   footer shows, or a target, which is pointing and has no entry of its own.
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
| Anywhere | a `text/uri-list` of `file:` URIs (a file-manager COPY) | Forwarded verbatim as a `native-drop` paste and read by Go — the same ingestion a desktop drag takes, at the CARET index rather than a drop coordinate. |
| Anywhere | **nothing at all** (see below) | `native-clipboard`: Go reads the OS clipboard itself. |
| Log block | anything | consumed (read-only) |

### The empty clipboard (2026-08-21, #87)

WebKitGTK delivers a paste event whose `DataTransfer` **exists and is completely
empty** — no types, no items, no files — for a screenshot copied by an ordinary
desktop tool, while any normal GTK process reads the same offer fine. Nothing the
page can do salvages that, so **the emptiness is the signal**: the surface claims
the gesture, peeks the caret index, and sends a `native-clipboard` paste carrying
no clipboard at all. Go reads the OS clipboard natively (GTK, in the UI process,
outside the webview's sandboxed proxy) and probes it in one order — a raster
image first, then a file-copy's uri-list — feeding whichever it finds to the
pipeline that already exists.

"Empty" is judged conservatively: a transfer that answers `getData` while
exposing no `types` still HAS content and takes the ordinary pipeline. Only a
genuinely empty offer routes natively, and a clipboard the server makes nothing
of answers `none` — leaving the caret's blank line where it was, with nothing to
replay, because the page never held the content.

## Drop matrix (revised 2026-08-21, #86)

External drops have ONE mechanism on every platform, and it is the same ethos
as the empty-clipboard paste (#87): the gesture pages the backend. The page's
own view of a drop is NEVER consulted — WebKitGTK starves it and every source
app starves it differently (measured 2026-08-21: Dolphin leaves one readable
lens with the URI as a style-only anchor's text, VSCode a dialect the page
cannot see at all, and async reads land after the store is emptied). Instead
the OS-level catch (Wails `OnFileDrop`) feeds the native drop bucket
(`nativedrop.Default`), and the surface's claim sends a `native-drop` frame
carrying ONLY the index: "there was a drop at this position — take it from the
bucket and place it here". The redeem waits briefly because the DOM's frame and
the native callback race on one gesture. Multi-file drags are one callback, one
frame, several blocks in drag order.

| Drop | Outcome |
|---|---|
| Any external file drag, any source app | Claimed; `native-drop` frame with the index only; **Go redeems the bucket** and ingests — one block per file, the registry picking each kind as for any paste. |
| External text or link drag | Claimed, and the bucket holds no file — nothing happens. External text/link drag-in is NOT a supported gesture (copy-paste covers it); WebKitGTK never let the page read these anyway. |
| Internal PM drag (`slice`/`moved` set) | Not claimed — PM handles it natively (block reorder, moved selections). |
| Into a prompt pseudo-document | Not claimed — a prompt is a plain file with no block tree. |

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
| Mod+F | Edit › Find › Find and Replace… (mac: Find › …) | `window.sieveWorkspace?.toggleFind()` |
| F3 (non-mac) | Edit › Find › Find Next | `window.sieveWorkspace?.findNext()` |
| Mod+G (mac) | Find › Find Next | `window.sieveWorkspace?.findNext()` |
| Shift+F3 (non-mac) | Edit › Find › Find Previous | `window.sieveWorkspace?.findPrev()` |
| Mod+Shift+G (mac) | Find › Find Previous | `window.sieveWorkspace?.findPrev()` |
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

`FindDialog` exposes the real verbs (`next()`/`prev()`, mirroring the ↓/↑
buttons including the "n of m" refresh) via
`window.sieveWorkspace.findNext()`/`findPrev()` — when the bar is closed these
OPEN it (conventional "start searching") rather than silently advancing a hidden
search. Replace is inside the bar rather than a menu row of its own: one chord
opens the whole find-and-replace surface, as every editor's Mod+F does.

**The bar's own keys never reach the editor.** Enter (next), Shift+Enter
(previous) and Escape (close) are handled on the bar's own inputs, which live
outside `#tiptap-mount` — so nothing in this document's editor-surface rules is
involved, and the bar needs no `interactionPolicy`. A Tab chord is deliberately
left alone and passed to the browser's own focus order; it is recognised by
`keyCode === 9`, because WebKitGTK delivers Shift+Tab as `ISO_Left_Tab` and
`event.key` reads as neither 'Tab' nor a shifted one.

## Context menu (revised 2026-08-28, #118)

**A right-click is resolved to the MOUNT it happened in.** The host walks the
lenses it has mounted — the active tab's document and the Ask panel's draft — and
claims the gesture for the one whose fixture contains the target. A lens
publishes the element it was mounted in, so the resolution names no mount and a
third arrangement needs no third listener. Inside a claimed mount the browser's
own menu is always suppressed; a sieve block raises its own menu instead and the
editor menu stands down.

**An ELEMENT raises no menu of its own.** A sieve node living inside another
sieve block's content — the blocks an ai-block's answer is composed of, projected
into its body — is not addressable: it names no block the container holds, so
every block verb aimed at it would name a block that does not exist. A right-click
on one is left to bubble, and the block HOSTING it raises the menu. The same
suppression covers the click that makes a block the selection owner. This is a
framework decision taken once, at the NodeView factory, from the node's position;
no kind opts in or out of it.

**What is offered follows the mount, not the mount's name.** Three gates, and
only three:

| Gate | Read | Effect |
|---|---|---|
| capability | the lens's published spec (`blocks`) | a verb that MAKES a block — Ask AI, Explain, `==` Highlight Target — is absent where none can be made |
| provider shape | `typeof provider.detectExtractions` | Extract / Transform / Embed-in-Document are absent for a container that describes no extractions |
| data | what the caret is actually in or on | the table, fence and attachment sections appear only over their subject |

`==` is gated with Ask AI deliberately: it names an ask TARGET, so it means
nothing in a mount whose message becomes a block elsewhere.

**Submenus are one level, and one mechanism.** An entry carrying children opens a
flyout beside itself, flipped to its other side near the window edge and clamped
so its bottom never passes the window's — the main menu clamps the same way, so a
menu raised near either edge behaves identically to one raised anywhere else — and
is itself inert — it opens rather than acts.

| Key | On a parent entry | Inside the flyout |
|---|---|---|
| ArrowRight / Enter / Space | opens it and focuses the first child | — |
| ArrowDown / ArrowUp | — | moves within, wrapping at both ends |
| ArrowLeft | — | closes it, focus back on the parent |
| Escape | closes the whole menu | closes the flyout; a second one closes the menu |
| Enter, click | opens it | accepts, and the WHOLE menu closes |

**The structured sections.** A caret inside a table adds Row → (Add Above · Add
Below · Delete Row), Column → (Add Left · Add Right · Delete Column) and Delete
Table — the stock TipTap table commands, offered in every wysiwyg mount because
rearranging a table is editing and not authoring. Add Header Row joins them only
while the table has none: GFM pipe markdown requires a header row, so once one
exists the entry is gone rather than offering an OFF direction that would mint a
table markdown cannot represent (`toggleHeaderRow` only ever adds one). Delete
Table replaces the generic Delete Block there: one act, one entry. A caret inside
a fence adds Language →, whose entries are **the languages the highlighter is
registered for** (`getLowlight().listLanguages()`, never a hand-written list),
sorted, with Plain — the absence of a tag — first and a tick on the fence's
current one. It is the discoverable route to what `{fence:go` types.

**The draft's own two verbs.** Right-clicking on a `@Title` token that the draft
has attached offers Remove Attachment, which does exactly what the chip's ✕ does
— detaches the document and takes the token with it, because the two are one
object. The title comes from the MARK under the caret, which is drawn from the
manifest, so a mount that keeps no manifest is offered nothing without a gate to
remember. Clear Draft retires the whole draft — container, lens and undo history
— so it is styled as the destructive verb it is; the panel stays open and the
caret lands in the fresh message.

## Trigger picker (revised 2026-08-19, #74 P4/P5/P6 + #38)

**ONE picker, two hosts.** The `@`/`/` picker is a single `TriggerPopover` over a
`TriggerHost`. Both hosts are now ProseMirror carets (`ProseMirrorHost`, a
caret-anchored placement); what tells them apart is whether the mount can HOLD A
BLOCK, which is the host CLASS it is given — `BlockMakingProseMirrorHost` for a
document, the plain one for a draft. The keyboard model, the token scan, the
abandonment state machine and the scroll-into-view fix are written ONCE and are
identical in both — which is the point, and the reason a second popover was
refused. What differs is stated where it differs: the composer's half is the rest
of this section, the document's is *The same picker in the document* at the end
of it.

**Every row is the same set of columns.** A row is a left-aligned flex row of
slots — an optional icon column, the name, the description — and the widths that
make them line up (the icon gutter, the name's floor width) are declared once, by
the row constructor every provider draws through (`TriggerProvider.renderRow`).
Whether the icon column exists at all is a PROVIDER TRAIT (`providesIcons`),
declared like the two token predicates beside it and stable for the whole
interaction: a column inferred from whichever candidates a query happened to
return would shift the list sideways under a user mid-word. Where a provider
declares one, every row of that picker carries the slot — empty for an entry with
no icon — so the names stay in a column. `/` and `@` declare none and run flush
left; `{` declares one.

### In the composer (revised 2026-08-28, #118)

The Ask panel's message is written in a **composer mount** — the document-editor
lens over an in-memory draft — so the whole key matrix above applies inside it,
narrowed only by that mount's one claim (`Mod+Enter`) and by what a draft can
hold. Three owners intercept keys, in this order:

- **`TriggerPopover`** (`frontend/src/static/shell/trigger-popover.js`) — a
  capture-phase `keydown` on the editable root, active **only while the picker is
  open**;
- **the composer mount's claim** — `Mod+Enter` sends;
- **`AskPanel`** (`frontend/src/static/shell/ask-panel.js`) — a bubble-phase
  `keydown` on the panel, owning `Escape` alone.

Everything else is the editing surface's, unchanged.

| Key | While the picker is open |
|---|---|
| ↓ / ↑ | move the selection (wraps; scrolls the active row into view — #63) |
| Tab | accept the selected candidate |
| Enter (no Shift, Mod held or not) | accept the selected candidate — the mount's `Mod+Enter` send claim is **not** reached, even when Mod is held |
| Escape | **abandon the token** — the picker closes and does not reopen as you type on; the panel's dismiss is **not** reached |
| Shift+Enter | falls through (newline), picker stays open |

Accept and dismiss both `stopImmediatePropagation`, which is what keeps a
completion from also sending the message.

| Key | In the composer, picker open or shut |
|---|---|
| Mod+Enter | send (picker shut) — while the picker is open, Enter of any kind accepts the candidate above instead |
| Escape | dismiss the panel |

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
**every change to the draft**, not at send: breaking a token removes its chip the
moment it stops matching, rather than the UI claiming "attached" until send drops
the attachment with no answer and no explanation.

| Gesture | What it does |
|---|---|
| select-through-and-delete, cut, paste-over, retype | the chip goes as soon as the token stops matching |
| the chip's ✕ | deletes the `@Title` token from the message as well — the same disagreement pointing the other way — and **forgets the document** (below) |
| undo, or retyping the title | **re-attaches** *unless the document was ✕'d*: matching is on exact title text, and every candidate accepted since the composer was last cleared is retained, so the chip comes back with its token |

**The ✕ forgets; editing the text does not.** Both gestures remove the chip and
its token and differ only in INTENT, which is the whole difference. ✕ means "I do
not want this attached", so it is final: its document leaves the retained pool and
writing that title again later — `as @Auth Design says…` — is ordinary prose, not
a silent re-attach of what the user just refused. A text edit means "I am editing
my sentence", so its document stays pooled and the token coming back re-attaches
it. A ✕'d document returns the normal way: accept it from the `@` picker again.
Forgetting is per-URI, never per-title — with two "Notes" attached, ✕ on one cuts
only its token and leaves the survivor resolving to the other document.

Two more consequences worth naming:

- **A send forgets everything.** `clear()` empties the retained pool, so a title
  typed after a send is prose, not a resurrected attachment.
- **The pool is insertion-ordered**, and that order is the order tokens are
  handed out in. With two attachments sharing a title (`@Notes and @Notes`), ✕ on
  one takes exactly its own token and leaves the survivor resolving to the other
  document; accepting a document again puts it at the back, so it pairs with the
  token just written for it.

### The header shows the subject; the footer shows the context (#74)

**The panel header is a view of the composer text**, derived on the same change
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

The editor hosts the SAME popover, with two triggers: `@` (mention a document)
and `{` (insert a block, #91). `/` is a composer verb — a slash command runs
against the message being written, and a document has no message.

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

**`{` runs a MACRO.** Both its token predicates are the trigger defaults: `{`
opens at the start of the text or after whitespace — so `${code` and `fn(){` are
literal braces — and the token ends at the first whitespace, because a macro is
named in one word. A bare `{` lists everything, which is the browse gesture; a
prefix filters on the entry's label and its second name alike, so `co` and `code`
both reach Code.

**An entry MAY take an ARGUMENT, carried after `:` in the same token** — `{fence:go`
matches the Fence entry on `fence` and hands `go` to what it runs. `:` needs no
scanner change: it is not whitespace, so it already passes the token's default
`acceptsPrefix`, and MATCHING is unaffected — only the text before `:` (the
HEAD) is compared against an entry's label/name, so `{fen:go` and `{f:go`
(while unambiguous) reach Fence exactly as `{fen`/`{f` would with no argument at
all. The argument is read off the TOKEN at accept time, not off the candidate
that matched it, so it survives a partial-head match undamaged. `{fence` with
no `:` at all carries no argument (`undefined`); `{fence:` with nothing after
the separator carries an empty one — an entry that ignores the argument (every
entry but Fence, today) is unaffected either way.

**MACROS ARE TO THE FRONTEND WHAT COMMANDS ARE TO THE BACKEND.** A command is a
backend verb: declared in Go beside the logic it runs, enumerated to clients,
dispatched over the wire. A macro is a frontend verb: declared beside the
capability it fronts, enumerated to whatever renders verbs, invoked with the
caret's token. A new verb picks its side by WHERE ITS LOGIC HAPPENS — mutating
domain state is a command, driving a frontend capability (a dialog, native
editing) is a macro.

The picker offers three kinds of entry, each declared where its capability lives:

| Entry | Declared by | Accepting it |
|---|---|---|
| Code, Diagram, Log | the renderer class, as `static insertSpec()` | the token is deleted and the server creates an empty block of that kind |
| Web Clip | the workspace, which owns the URL dialog | the token is deleted, then the dialog opens |
| Attach File | the workspace, fronting the toolbar's own attach flow | the token is deleted, then the anchor is captured and the OS file picker opens — the paste pipeline decides the block, exactly as it does for the toolbar button |
| Table, Quote, Divider | the WYSIWYG surface, as class-level presets — the toolbar's native insert group, offered through a second door | the token is deleted, then the surface runs the toolbar's own command (`insertTable`, `toggleBlockquote`, `setHorizontalRule`) |
| Fence | the WYSIWYG surface, as a class-level preset — a NATIVE code block, distinct from the Sieve Code block above it | the token is deleted, then the surface runs `setCodeBlock`, tagged with the token's argument as `language` when one was typed (`{fence:go`), untagged otherwise |

The BLOCK KINDS offered are the ones a keystroke can make out of nothing. Every
other kind is born another way — prose is typed, `ai-block` comes from Ask,
`reference` from `@`, the smart kinds from a paste, `command-result` from a
command — and declares no insert. A kind is in the list because its RENDERER
CLASS declares a `static insertSpec()`
(`frontend/src/static/renderers/block-kinds.js`, `listInsertableKinds`), so the
declaration sits with the class rather than in a table that can drift from it.

Nothing REGISTERS with the picker. The workspace composes its catalog once
(`shell/macro-catalog.js`), a surface declares its presets at class level, and
each mount READS both — so two mounts of the same surface can never double an
entry.

**Accepting makes a BLOCK, not text.** This is the one behaviour that genuinely
differs between the two hosts, and it differs because the hosts do: a draft mints
no blocks, so the composer echoes `@Title` and draws a chip beside it; a document
does, so the token is deleted and a block takes its place —
a `reference` carrying the `uri` for `@`, an empty block of the named kind for a
`{` kind entry, created with NO index and NO anchor because the editor owns all
id→index math. There is no `@Title` text left behind to reconcile — the chip in
the document IS the reference.

A `{` insert starts the block on the server's own defaults (`InitAttrs`): the
picker sends no attrs, so language detection, status, timestamps and a
source-less diagram's edit mode are all settled backend-side, as they are for
every other create.

**THE TOKEN GOES FIRST, ALWAYS.** For a kind entry the deletion and the create
are one host boundary (delete, flush, create). For a verb entry the deletion is
its own tracked edit and lands BEFORE the verb runs — because the verb may be a
dialog the user then dismisses, and a dismissal must leave the line clean rather
than a stranded `{web`. A verb creates nothing itself: whatever it opens owns
that.

**Where it lands is the ordinary rule, not a new one**: the caret is left where
the token was, so a line the token had to itself becomes the block, and a line
with prose still on it puts the block on the next one (Block insertion
placement, above). A Table is inserted by ProseMirror at that same caret and is
synced back by the block-sync spine like anything else typed — no server create.

### Gestures on a block chip (#38)

| Gesture | On a `reference` block | On the ai-block's FOOTER chip |
|---|---|---|
| single click | selects the block, like any other block | opens the coordinate |
| double click | opens: a `uri` opens its container, a `src` reveals the file where it lives | — |

The footer row is the only chip site an ai-block has: the documents its question
attached. The question itself draws no chip — a reference it names is either one
of those attachments or a target, and a target is POINTING, which is shown by
the lineage affordances on the block it points at rather than by a mark inside
the question.

The two columns differ deliberately and it is recorded here so it does not later
read as an accident. A block sits in the editing flow, so a single click must
place the caret and select it exactly as it would for any other block — which
leaves double click for opening. The footer chip is NOT in that flow (there is
no caret in it and nothing to select), so single click can mean open there
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
