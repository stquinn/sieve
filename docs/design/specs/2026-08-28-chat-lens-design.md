# Chat Lens — Presentation and Interaction Design

Tracked: #102 (prerequisites cleared: the Composer #118 and the answer list
#117 are both merged). Design approved 2026-08-28.

## Design artifacts, and which one wins

The approved mockups are IN-REPO artifacts, committed with this spec:
`docs/design/mockups/2026-08-28-chat-workbench/*.html` — self-contained pages (open in
any browser; readable as plain HTML by an implementing agent). Each carries the mock
plus a numbered annotation rail stating HOST/LENS ownership per interactive region. The
live canvas (https://claude.ai/code/artifact/ee0589c9-1626-4973-8c80-c6218b5abcff) is
the *editable master* for future design sessions; the committed files are the frozen
picture of record for THIS implementation — an implementer needs no network and no
account to see the required UX.

Precedence when artifacts disagree:

- **Behaviour, interaction, ownership, contracts**: this spec wins, then the mockup
  rails.
- **Layout, proportion, spacing, visual states**: the mockups win — reproduce what they
  show.
- **Where the mockups show what this spec no longer says, this spec wins**: an `@vN`
  on the record stamp, Enter-to-send key hints, "branch from here" and "delete exchange"
  in the record's menu, an answer landing whole.
- **The mockups' record shell, its hover state, the column measure, the spacing between turns
  and the composer under the thread no longer hold**: an exchange is drawn as two messages with
  no shell round them, each with its own time and actions; the column is the Chat width setting;
  spacing is the two thread tokens below; the composer is the workspace's Ask panel, pinned open,
  with its own look and width (*The composer*, below). This spec wins on all five.
- **Colour and font VALUES: neither.** The mockups carry resolved Sublime Mariana hex
  for portability; implementation MUST use the `--theme-*` / `--chip-*` tokens mapped in
  this spec, never a literal from the mockups.

Reading map (artboard → what it is normative for):

| File | Normative for |
|---|---|
| `Main.dc.html` | the whole lens in situ: thread, pending exchange, composer, host chrome |
| `TurnRecord.dc.html` | exchange anatomy: slots, foreign transclusion, note-host contrast (its shell and control strip no longer hold) |
| `Composer.dc.html` | composer states: mention in flight, seeded quote, minted fragment, chip row, key hints |
| `Streaming.dc.html` | arrival: pending → mint loop → whole-answer landing (what is deliberately NOT animated) |
| `RichAnswer.dc.html` | markdown + real blocks inside an answer, readOnly affordances |
| `RichExchange.dc.html` | rich⇄rich worst case: the speaker surface and block chrome of a rich question and answer |
| `Vocabulary.dc.html` | the component sheet: chip family, transclusion frames, glow/tint language, ownership legend, scale tiers |

## Problem

#102 defines the chat document kind (`List<AiBlock>`, native YAML, born Shared) and its
wire ops, but not what the lens draws. The ai-block's note-host card (badge, heading
rule, card shell) rendered per turn produces a page of stacked documents, not a
conversation — and gives the two speakers no visual identity.

## Decision — one exchange, two faces

The exchange keeps one stored unit (the ai-block, its address `sieve://{chat}/{exchange}`,
what a thread sends to a model) and has two host-selected faces:

- **Note host (unchanged)**: the teal card, AI badge in the border, heading-weight
  question with the orange rule, thinking ring on the badge. Among other kinds the badge
  earns its place.
- **Chat host (this spec)**: a conversation, where the unit on screen is the MESSAGE. Each
  exchange is two messages and nothing round them: my question at the right in an orange
  surface, the answer at the left, open, at the column's width. Each message carries its own
  time and its own actions.

Which face renders is the host's framing decision, never the block's — the same
one-renderer-many-hosts discipline as everywhere else.

## The chat face, normatively

### Geometry and colour

Every colour below is a theme token; the colour words are glosses of the default
(Sublime Mariana) theme and must never be hard-coded. All sizes ride the existing
`--doc-size` tier system (×1 body · ×0.85 code · ×0.72 chips · ×0.7 badges).

- **My move (the question list)**: right-aligned, `width: fit-content`, max ~75% of the
  column. Full border on the speaker surface: border
  `color-mix(--theme-accentPrimary 22%, transparent)`, background
  `color-mix(--theme-accentPrimary 7%, transparent)`, radius 8 — `accentPrimary`
  ("orange" in Mariana) because it is already the human's accent (`--theme-cursorColor`,
  focus ring, chip default `--chip-accent`). Utterance weight — body size, no heading
  rule. The surface deliberately echoes the note-host ai-block card family.
- **The answer**: left-set, at the column's width (answers carry code, diagrams and
  tables and need the width). **No bubble and no container of its own** — it is a list,
  not a card: prose blocks render bare; structured blocks (code, diagram, log, reference)
  render with their own full kind chrome via the registry, `readOnly`. Asymmetric by
  design; not symmetric bubbles.
- **Two edges, two claims**: `--theme-accentPrimary` = *speaker* (the utterance boundary —
  it claims pasted fragments, quotes and chips as one ask, and stays even when the question
  is rich) · block chrome = *kind*. A claim is never drawn twice, and nothing claims the
  exchange: the answer is identified by its position, and the pair by spacing.
- **The column**: the thread is one column, centred, its measure the **Chat width** setting
  (Appearance, characters, 48–140, blank = 100; `LookAndFeel.ChatMeasure` →
  `--theme-chatMeasure` → `--thread-measure`). Line width does not reach a chat; presenting,
  the thread takes the Presentation width. The measure is computed once at `:root`, so the
  thread is that width whatever its font. The Ask panel is not on the column: it is the
  workspace's, and spans what it spans over any tab.
- **Spacing carries the grouping**: a question sits close to its own answer
  (`--thread-reply-gap`) and clearly further from the answer before it
  (`--thread-turn-gap`, about 2rem). Nothing else encodes the grouping.
- **Rel accents** (glossed from page C of the canvas): attach = `--theme-accentPrimary`
  · cites = `--theme-accentCyan` · pinned quote = `--theme-accentPurple` · subject =
  `--theme-accentTeal` · dangling = `--theme-muted`, dashed · LIVE/re-read tag =
  `--theme-accentGreen`. Provenance strips: `--theme-muted` in `--theme-monoFont`. A
  message's time: `--theme-textDim` in the UI face, the ×0.75 tier.

### Slots

| Slot | rel | Face in chat |
|---|---|---|
| body | — | content, in authored order |
| handed | `attach` | chip row docked under my move, right-aligned, 15rem clamp |
| about | `target` | **no entry** — local target glows (chain-hover language: 3px bar + tint); foreign target transcludes in place (full-anatomy readOnly render, provenance strip, `LIVE · re-read` bare / `@vN · frozen` pinned) |

### Messages: time, days and actions

- **Each message has its own time**, always shown, under it: right-aligned under my question,
  left-aligned under the answer. A question's is when it was asked (`createdAt`); an answer's
  is when it was completed (`completedAt`); an answer not complete shows none. Under a minute:
  "a few seconds ago"; one to five minutes: "N minutes ago"; older: the time of day in the
  platform's locale. The labels move on as time passes, on the thread's own clock, without
  redrawing a message. `ThreadTime` (`renderers/`) is the one reading of a time, given `now`.
- **The date is said once, in the thread**: a separator before the first message of each
  calendar day — "Today", "Yesterday", else the weekday and date, with the year when it is not
  this year. A question and its answer may fall either side of one; a message never shows a
  date. A chat's address takes no `?version=`: the list only grows and an exchange does not
  change once it is answered, so there is nothing to pin.
- **Each message has its own actions**, in the row with its time: Copy and Quote, icon buttons
  of about 28px with a visible border, a solid surface, a hover state and a tooltip. They show
  on pointer hover or keyboard focus of that message and stay shown on the latest answer. Copy
  on a question copies its text; on an answer, the whole answer as markdown.
- **Quote is per message**: it quotes the text selected inside that message when the selection
  lies within it, otherwise its opening (about 200 characters, cut on a word boundary). The
  lens raises the `quote` intent carrying the exchange and the quoted text, and the Ask panel
  puts a quote into its draft, after the caret's block. A quote is a hand-over, not a
  selection: the lens's selection stays the chat and its last exchange. A quote is a reference to the exchange (`rel: target`, unpinned) with `displayAs: quote`
  and the quoted text in its cache: it is drawn as a blockquote in the draft and in the question
  as asked, and the model is told it as "Specifically regarding". A draft may hold several.
- **A block of an answer offers Copy and nothing else**, always armed: hovering or focusing the
  block shows it, whatever the message is doing, and one click copies that block. There is no
  Extract and no Add to Document: a chat has no document for the result to land in. The copy,
  pasted into a note, becomes a block there.
- **Retry** is offered on the answer of an exchange whose job failed or timed out. An answered
  exchange does not offer it.
- Right-click anywhere in a message resolves to the parent exchange (elements are anonymous);
  the chat raises no menu of its own. Nothing edits or deletes an exchange: the list is
  append-only. No Ask/Explain entries anywhere in a chat — the document is one.

### Arrival (no streaming theatre)

- An **unanswered exchange is structural** and renders as my move plus a quiet pending
  slot in the answer position (dashed teal, pulsing dot, "answering…"). No badge ring in
  chat (the ring is note-host chrome); no partial text, no typing carets, no progressive
  reveal inside a block. **An answer arrives a block at a time, each block whole**, as
  the model writes it; the pending slot stays under the last block as the status row
  until the exchange settles.
- Citations are reference elements in the answer body and render as cyan `cites` chips
  in flow; click navigates via the Router.
- If a true streaming backend is ever designed (LLM piping into a live block — parked,
  out of scope), the pending slot is its seam; nothing else here changes.

### The composer

The composer is the workspace's Ask panel: the one panel every tab has, pinned open and not
dismissible while a chat's tab is current, and otherwise exactly itself — its pinned look, its
grab handle and the height the user gave it, its width. Leaving the chat's tab returns the panel
to what the user had it. Its draft is the full document-editor lens mounted on an in-memory
draft container, one per chat. Normative points:

- **Key claims are per-mount configuration**: this mount claims `Mod+Enter` = send, the
  composer's existing claim; `Enter` is a newline as in any editor, and every other key
  falls through to the editor. (This per-mount rule is the general precedence model — see
  contract deltas below.)
- `@` opens the MentionService typeahead (workspace-wire tenant); accepting inserts the
  `@Title` token in prose AND the attach chip below — one gesture, one `rel: attach`
  reference element.
- Paste mints whole blocks through the registry paste-match; a minted fragment is live
  and editable inside the draft, full kind chrome.
- Chips are removable (×) in the draft — the only place a chip mutates.
- Send = the #102 append-exchange op; the draft's block list becomes the question list
  verbatim. Draft state is in-memory only; nothing persists before send.

### Chrome the lens does NOT own

Tabs (kind-tagged: MD / CHAT / WB), the Chats sidebar item, and the status bar are host
chrome. The chat lens contributes no toolbar.

The **Chats** item follows the Notebooks, Diary and Buffers items
(`docs/how-the-sidebar-works.md`): a folder-like row directly after Diary, expanded to a
row per chat, newest first. Right-click on the Chats row offers New Chat; right-click on
a chat's row offers Open and Delete. New Chat is also File › New Chat, `Mod+Shift+N`:
the variant of `Mod+N`, New Note.

## The shared vocabulary is code, not convention

Page C of the canvas is a component sheet, and its pieces ship as PM-free, lens-blind,
transport-blind classes in `renderers/` — the tier that both a NodeView and a plain lens
may consume — following the two patterns already shipped there:

- **Tokens at `:root`** for anything two surfaces must draw identically without
  importing each other — the `--chip-*` precedent in `editor.css` (ReferenceChip and the
  composer draw one pill from one token set). This spec adds the speaker-surface, the
  answering side's surface and the thread's values the same way (`--utterance-*`,
  `--record-*` for the pending slot and Retry, `--thread-*` for the column and its spacing).
- **Components beside `QuestionListView`** — one class + sibling `.styles.js` each, no
  PM, no window.*, one narrow constructor contract:
  - **chat message** (`ChatMessage`: one side of an exchange, its time and its actions) —
    consumed by the chat lens AND, later, the workbench conversation panel;
  - **thread time** (`ThreadTime`: a message's time label and a day's, given `now`);
  - **pending slot** (dashed `aiBlockBorder` box, pulsing dot);
  - **transclusion frame** (provenance strip + LIVE/pinned tag around a composed
    readOnly renderer);
  - the existing **ReferenceChip**, **QuestionListView**, **mention token** styling
    (`.ai-block__mention`) are reused as-is.

Nothing in this tier may know which lens, host, or backing service is drawing it — the
same fence `contract-purity`/`lens-isolation` tests already pin.

## Interaction-contract deltas (same change, normative doc)

`docs/editor-interaction-contract.md` gains, in the change that builds this:

1. **Per-mount key claims** — a host claims keys at the mount it owns (composer mount:
   Mod+Enter=send), resolved by focus and DOM bubbling;
   there is no global claim table.
2. **Message actions on hover/focus** — a message's actions appear on pointer hover or
   keyboard focus of that message; both paths are required (no pointer-only affordances).
3. **Right-click on a message resolves to the parent block**; menus are host-scoped.

## Non-goals

- Restyling the note-host ai-block face (unchanged, including badge + thinking ring).
- Turn-grammar enforcement, export-as-markdown, librarian auto-titles (deferred in #102).
- The answer-side mint tools themselves (#117 owns the mechanism; this spec consumes it).

## Tests / definition of done

- Lens-isolation and contract-purity suites cover the new lens (transport-blind, one
  provider, imports fenced).
- Messages readOnly: mutation affordances absent, read affordances live — pinned per kind
  through the existing renderer readOnly tests, plus a message's actions on hover and focus.
- A **showcase chat** joins the showcase-note convention: rich question, rich answer,
  pending exchange, quote-follow-up, foreign transclusion, dangling reference — Go
  fixture + JS fixture + app-drive target.
- Any op/frame change goes through `sieve/protocol` + artifact regen (per #102).
