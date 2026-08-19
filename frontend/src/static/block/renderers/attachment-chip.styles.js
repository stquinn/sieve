// @ts-check
// attachment-chip.styles.js — AttachmentChip's stylesheet, a sibling module per
// the styles-file-geography convention (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md,
// "Styles file geography"): a component file starts with its class — behaviour
// first, never a CSS wall — so any sheet over ~30 lines lives in its own
// `<name>.styles.js` sibling (`export const <name>Styles = /* css */ \`…\``,
// Lit-style), imported into the class's `static styles`.
//
// ── THE TOKENS ARE NOT DEFINED HERE ─────────────────────────────────────────
// The `--chip-*` custom properties this sheet reads are owned by editor.css's
// `:root`, next to the theme palette, so that the composer's chips — which
// cannot consume this class — draw the same appearance from the same numbers.
// That file's header states the contract; this one only reads it.
//
// The one thing to know while editing HERE: the `color-mix()` stays in the rule
// that paints rather than being pre-mixed into a token, because a custom
// property containing `var()` resolves where it is DECLARED. A `--chip-tint`
// defined at `:root` would freeze at `:root`'s accent and ignore the `--missing`
// override two rules below. The token is the STRENGTH; the mix belongs to
// whatever paints.

export const attachmentChipStyles = /* css */ `
  .sieve-attachment-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--chip-gap);
    flex: 0 0 auto;
    max-width: var(--chip-max-width);
    padding: var(--chip-padding);
    border: 1px solid var(--chip-border-color);
    border-radius: var(--chip-radius);
    background: color-mix(in srgb, var(--chip-accent) var(--chip-tint-strength), transparent);
    color: var(--chip-accent);
    font-family: var(--theme-uiFont);
    /* The one dimension that is NOT a shared token: --doc-size is declared on
       .editor-panel, so a :root token derived from it would substitute against
       nothing and go invalid — and panel chrome does not scale with the document
       anyway, so there is nothing for the composer to share here. */
    font-size: calc(var(--doc-size) * 0.72);
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .sieve-attachment-chip:hover {
    background: color-mix(in srgb, var(--chip-accent) var(--chip-tint-strength-hover), transparent);
    border-color: var(--chip-accent);
  }

  .sieve-attachment-chip__label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Kind and size sit as quiet secondary text after the label — never clamped,
     because a truncated "412 KB" says nothing. */
  .sieve-attachment-chip__detail {
    flex: 0 0 auto;
    white-space: nowrap;
    opacity: 0.7;
  }

  /* Dangling is a NORMAL state, not an error: greyed, marked, still readable.
     Re-pointing the accent is what greys it — including the hover tint, which is
     mixed from that same variable. */
  .sieve-attachment-chip--missing {
    --chip-accent: var(--theme-muted);
    --chip-tint-strength-hover: 12%;
    background: transparent;
    border-style: dashed;
  }

  .sieve-attachment-chip::selection,
  .sieve-attachment-chip__label::selection,
  .sieve-attachment-chip__detail::selection {
    background: transparent;
    color: inherit;
  }
`
