// @ts-check
// attachment-renderer.styles.js — AttachmentRenderer's stylesheet, a sibling
// module per the styles-file-geography convention
// (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md, "Styles
// file geography"): a renderer file starts with its class — behaviour first,
// never a CSS wall.
//
// ── THIS BLOCK IS A CHIP, NOT A CARD ────────────────────────────────────────
// Almost nothing is declared here, and that is the point: the chip's appearance
// belongs to AttachmentChip and its shared `--chip-*` tokens. This sheet owns
// only what a chip cannot know about itself:
//
//   1. THE SHRINK-WRAP. A chip is `inline-flex; flex: 0 0 auto`, so it needs a
//      block-level wrapper only as wide as its content. A DELIBERATE contrast
//      with smart-card's `width: 100%`: a card is a preview surface and earns
//      the column; a chip is a label and does not.
//
//   2. THE LIFTED CLAMP. `--chip-max-width` is `none` at `:root` and the
//      ai-block footer ROW narrows it to 15rem. This row deliberately sets
//      NOTHING, so the block's chip carries the full title, bounded only by the
//      text column. The clamp being the row's to set — never the chip's to
//      assume — is what keeps that a one-line difference and not a second
//      component.
//
//   3. THE DISCLOSURE. The chevron is a flex child OF the chip, so hover tints
//      the two as one object, rather than a header bar with a toolbar.
//
// NO TRANSFORMS. The chevron flips by swapping its GLYPH, not by rotating:
// WebKitGTK repaints a whole contentEditable subtree when a transform animates
// inside it, and this block sits in the document flow.

export const attachmentStyles = /* css */ `
  /* SHRINK-WRAPPED, so the framework's focus ring hugs the chip. That ring is
     applied to .sieve-block — this same element — and a block-level box is full
     width whatever it contains, so a content-sized chip drew a selection outline
     spanning the whole column. Every other kind is a full-width surface and wants
     that; an attachment is a label and does not. */
  .attachment-block {
    margin: 4px 0;
    width: max-content;
    max-width: 100%;
  }

  /* Shrink-wraps the chip (see 1 above). max-width keeps a long filename inside
     the text column, where the chip's own label ellipsises. */
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

  /* The summary the chevron reveals: one quiet line (or a few) under the chip. */
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
