// @ts-check
// attachment-renderer.styles.js — AttachmentRenderer's stylesheet, a sibling
// module per the styles-file-geography convention
// (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md, "Styles
// file geography"): a renderer file starts with its class — behaviour first,
// never a CSS wall.
//
// ── THIS BLOCK IS A CHIP, NOT A CARD ────────────────────────────────────────
// Almost nothing is declared here, and that is the point
// (docs/design/specs/2026-08-19-attachment-block-design.md, "Render and
// navigation"): the appearance of the chip belongs to AttachmentChip, which
// draws it from the shared `--chip-*` tokens. What this sheet owns is only the
// three things a chip cannot know about itself:
//
//   1. THE SHRINK-WRAP. A chip is `inline-flex; flex: 0 0 auto`, so it needs a
//      block-level wrapper that is only as wide as its content. `width:
//      max-content` gives exactly that — an attachment is whatever size makes
//      sense, the way an image is, and forcing it to span the column would make
//      a two-word title look like a banner. This is a DELIBERATE contrast with
//      smart-card's `width: 100%`: a card is a preview surface and earns the
//      column; a chip is a label and does not.
//
//   2. THE LIFTED CLAMP. `--chip-max-width` is `none` at `:root` (editor.css)
//      and the ai-block footer ROW narrows it to 15rem for a compact provenance
//      mark. This row deliberately sets NOTHING, so the block's chip carries the
//      full document title or filename, bounded only by the text column. The
//      clamp being the row's to set — never the chip's to assume — is what makes
//      that a one-line difference rather than a second component.
//
//   3. THE DISCLOSURE. The chevron and the summary it reveals: a chevron ON the
//      chip (a flex child of it, so hover tints the two as one object) rather
//      than a header bar with a toolbar, which is card furniture the design
//      rejects explicitly.
//
// NO TRANSFORMS. The chevron flips by swapping its GLYPH, not by rotating.
// WebKitGTK repaints a whole contentEditable subtree when a transform animates
// inside it, and this block sits in the document flow — the collapsed/expanded
// glyphs cost nothing and skip the problem entirely.

export const attachmentStyles = /* css */ `
  .attachment-block {
    margin: 4px 0;
  }

  /* The wrapper that shrink-wraps the chip (see 1 above). max-width keeps a long
     filename inside the text column, where the chip's own label ellipsises. */
  .attachment-block__line {
    display: flex;
    align-items: center;
    width: max-content;
    max-width: 100%;
  }

  /* A resolve/ingest job still in flight — the same quiet dimming smart-card
     uses while its face is unknown. */
  .attachment-block--pending .sieve-attachment-chip {
    opacity: 0.7;
  }

  /* The chevron is a child OF the chip: no background, no border, no colour of
     its own, so the chip's tint and hover state cover it as one surface. */
  .attachment-block__chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* Never squeezed by a long label: the label is the part that ellipsises. */
    flex: 0 0 auto;
    margin-left: 1px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    line-height: 1;
    opacity: 0.65;
    cursor: pointer;
  }

  .attachment-block__chevron:hover {
    opacity: 1;
  }

  /* The summary the chevron reveals: one quiet line (or a few) under the chip,
     which is what lets the double-click gesture stay as simple as it is. */
  .attachment-block__summary {
    display: none;
    margin: 5px 0 0 2px;
    padding: 4px 0 4px 9px;
    border-left: 2px solid color-mix(in srgb, var(--chip-accent) 40%, transparent);
    color: var(--theme-fg2);
    font-family: var(--theme-uiFont);
    font-size: calc(var(--doc-size) * 0.72);
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .attachment-block__summary--shown {
    display: block;
  }
`
