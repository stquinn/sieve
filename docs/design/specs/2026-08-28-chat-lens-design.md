# Chat Lens — Presentation and Interaction Design

Tracked: #102 (blocked on the Composer prerequisite and #117). Design approved
2026-08-28.

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
- **Colour and font VALUES: neither.** The mockups carry resolved Sublime Mariana hex
  for portability; implementation MUST use the `--theme-*` / `--chip-*` tokens mapped in
  this spec, never a literal from the mockups.

Reading map (artboard → what it is normative for):

| File | Normative for |
|---|---|
| `Main.dc.html` | the whole lens in situ: thread, rest-state turns, pending exchange, composer, host chrome |
| `TurnRecord.dc.html` | exchange anatomy: slots, hover shell, read controls, foreign transclusion, note-host contrast |
| `Composer.dc.html` | composer states: mention in flight, seeded quote, minted fragment, chip row, key hints |
| `Streaming.dc.html` | arrival: pending → mint loop → whole-answer landing (what is deliberately NOT animated) |
| `RichAnswer.dc.html` | markdown + real blocks inside an answer, readOnly affordances |
| `RichExchange.dc.html` | rich⇄rich worst case, rest vs hovered, the three-edges rule, rejected borderless alternative |
| `Vocabulary.dc.html` | the component sheet: chip family, transclusion frames, glow/tint language, ownership legend, scale tiers |

## Problem

#102 defines the chat document kind (`List<AiBlock>`, native YAML, born Shared) and its
wire ops, but not what the lens draws. The ai-block's note-host card (badge, heading
rule, card shell) rendered per turn produces a page of stacked documents, not a
conversation — and gives the two speakers no visual identity.

## Decision — one record, two faces

The exchange keeps one renderer family and gains a second, host-selected face:

- **Note host (unchanged)**: the teal card, AI badge in the border, heading-weight
  question with the orange rule, thinking ring on the badge. Among other kinds the badge
  earns its place.
- **Chat host (this spec)**: two moves, no badge, no shell at rest. My move sits right in
  an orange surface; the answer sits left, open, in the column. The record shell
  materialises on hover/focus.

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
- **The answer**: left-set, near-full column (answers carry code and need the width).
  **No container of its own** — it is a list, not a card: prose blocks render bare;
  structured blocks (code, diagram, log, reference) render with their own full kind
  chrome via the registry, `readOnly`. Asymmetric by design; not symmetric bubbles.
- **Three edges, three claims** (the nesting rule, at most three deep):
  `--theme-aiBlockBorder`/`--theme-aiBlockBg` ("teal") = *record* (the exchange, hover
  only) · `--theme-accentPrimary` = *speaker* (the utterance boundary — it claims pasted
  fragments, quotes and chips as one ask, and stays even when the question is rich) ·
  block chrome = *kind*. A claim is never drawn twice — which is exactly why the answer,
  already identified by position and the hover shell, gets no edge.
- **Rel accents** (glossed from page C of the canvas): attach = `--theme-accentPrimary`
  · cites = `--theme-accentCyan` · pinned quote = `--theme-accentPurple` · subject =
  `--theme-accentTeal` · dangling = `--theme-muted`, dashed · LIVE/re-read tag =
  `--theme-accentGreen`. Stamps and provenance strips: `--theme-muted` in
  `--theme-monoFont`.

### Slots

| Slot | rel | Face in chat |
|---|---|---|
| body | — | content, in authored order |
| handed | `attach` | chip row docked under my move, right-aligned, 15rem clamp |
| about | `target` | **no entry** — local target glows (chain-hover language: 3px bar + tint); foreign target transcludes in place (full-anatomy readOnly render, provenance strip, `LIVE · re-read` bare / `@vN · frozen` pinned) |

### The record shell (hover/focus)

At rest an exchange is two bare moves grouped by spacing. Hover **or keyboard focus**
materialises the familiar teal ai-block shell around both moves, carrying:

- the stamp in the top border: `HH:MM · @vN` — the exchange is the citable unit
  (`sieve://{chat}/{block}?version=N`);
- the read controls: copy · quote-into-composer (seeds the composer with a pinned
  reference element) · expand. Read affordances only; `readOnly` removes mutation.
- Right-click anywhere in a record resolves to the parent exchange (elements are
  anonymous) and opens the **host** context menu: cite, branch from here, delete
  exchange. No Ask/Explain entries anywhere in a chat — the document is one.

### Arrival (aligned with #117's mechanism — no streaming theatre)

- An **unanswered exchange is structural** and renders as my move plus a quiet pending
  slot in the answer position (dashed teal, pulsing dot, "answering…"). No badge ring in
  chat (the ring is note-host chrome); no partial text, no typing carets, no progressive
  reveal — the mint tools hand blocks back to the model, which places them in its reply,
  so **the whole answer lands as one wire event** and the lens paints once.
- Citations are reference elements in the answer body and render as cyan `cites` chips
  in flow; click navigates via the Router.
- If a true streaming backend is ever designed (LLM piping into a live block — parked,
  out of scope), the pending slot is its seam; nothing else here changes.

### The composer

The full document-editor lens mounted on an in-memory draft container — the same
instance family as notes' Ask input. Normative points:

- **Key claims are per-mount configuration**: this mount claims `Enter` = send ahead of
  the editor's core handling; `Alt+Enter` = newline; every other key falls through to
  the editor. (This per-mount rule is the general precedence model — see contract deltas
  below.)
- `@` opens the MentionService typeahead (workspace-wire tenant); accepting inserts the
  `@Title` token in prose AND the attach chip below — one gesture, one `rel: attach`
  reference element.
- Paste mints whole blocks through the registry paste-match; a minted fragment is live
  and editable inside the draft, full kind chrome.
- Chips are removable (×) in the draft — the only place a chip mutates.
- Send = the #102 append-exchange op; the draft's block list becomes the question list
  verbatim. Draft state is in-memory only; nothing persists before send.

### Chrome the lens does NOT own

Tabs (kind-tagged: MD / CHAT / WB), the Chats sidebar section (chronological,
hypermedia), and the status bar are host chrome. The chat lens contributes no toolbar.

## The shared vocabulary is code, not convention

Page C of the canvas is a component sheet, and its pieces ship as PM-free, lens-blind,
transport-blind classes in `renderers/` — the tier that both a NodeView and a plain lens
may consume — following the two patterns already shipped there:

- **Tokens at `:root`** for anything two surfaces must draw identically without
  importing each other — the `--chip-*` precedent in `editor.css` (ReferenceChip and the
  composer draw one pill from one token set). This spec adds the speaker-surface and
  record-shell values the same way (e.g. `--utterance-*`, `--record-*`; exact names are
  the implementer's call, the ownership rule is not).
- **Components beside `QuestionListView`** — one class + sibling `.styles.js` each, no
  PM, no window.*, one narrow constructor contract:
  - **exchange record chrome** (the two-move layout, rest/hover shell, stamp, read
    controls) — consumed by the chat lens AND, later, the workbench conversation panel;
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
   Enter=send; workbench mount, later: Mod+Enter), resolved by focus and DOM bubbling;
   there is no global claim table.
2. **Record hover/focus materialisation** — the shell and read controls appear on
   pointer hover or keyboard focus; both paths are required (no pointer-only
   affordances).
3. **Right-click on records resolves to the parent block**; menus are host-scoped.

## Non-goals

- Restyling the note-host ai-block face (unchanged, including badge + thinking ring).
- Turn-grammar enforcement, export-as-markdown, librarian auto-titles (deferred in #102).
- The answer-side mint tools themselves (#117 owns the mechanism; this spec consumes it).

## Tests / definition of done

- Lens-isolation and contract-purity suites cover the new lens (transport-blind, one
  provider, imports fenced).
- Record readOnly: mutation affordances absent, read affordances live — pinned per kind
  through the existing renderer readOnly tests, plus shell-materialisation on focus.
- A **showcase chat** joins the showcase-note convention: rich question, rich answer,
  pending exchange, quote-follow-up, foreign transclusion, dangling reference — Go
  fixture + JS fixture + app-drive target.
- Any op/frame change goes through `sieve/protocol` + artifact regen (per #102).
