// @ts-check
// attachment-chip.styles.js — AttachmentChip's stylesheet, a sibling module per
// the styles-file-geography convention (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md,
// "Styles file geography"): a component file starts with its class — behaviour
// first, never a CSS wall — so any sheet over ~30 lines lives in its own
// `<name>.styles.js` sibling (`export const <name>Styles = /* css */ \`…\``,
// Lit-style), imported into the class's `static styles`.
//
// Carried VERBATIM (values, not just rules) from ai-block-renderer.styles.js's
// former `.ai-block__attachment*` set — this is a de-duplication, not a
// redesign, so every declaration below computes to what the ai-block footer
// already drew (docs/design/specs/2026-08-19-attachment-block-design.md,
// "The chip is now a shared component").
//
// ── THE TOKENS ARE NOT DEFINED HERE ─────────────────────────────────────────
// The `--chip-*` custom properties this sheet reads are owned by ONE place:
// editor.css's `:root` block, next to the theme palette. That is deliberate and
// it is the whole point of the extraction.
//
// The composer's chips (`.ask-chip` / `.ask-target-chip`, shell CSS) are the
// third caller of this vocabulary and CANNOT consume this class: the composer is
// not a block, so it carries no block styles, and importing a renderer into the
// shell would cross the shell/renderer boundary. So the TOKENS are unified where
// the COMPONENTS cannot be — the radius, the tint strength, the border colour,
// the gap, the padding and the clamp live in one `:root` block that both this
// sheet and the composer's rules draw from. A caller that differs (the
// composer's ✕ padding, its 14rem clamp) overrides the token on its own
// selector rather than redeclaring the appearance.
//
// This is the same document-level-custom-property dependency renderers already
// have: `--doc-size` is defined on `.editor-panel` (editor.css), not by any
// renderer, and the ai-block chip has read it through `calc()` since #74.
//
// The `color-mix()` is written HERE rather than pre-mixed into a token, because
// a custom property containing `var()` is substituted where it is DECLARED and
// inherits already-resolved — a `--chip-tint` defined at `:root` would freeze at
// `:root`'s accent and ignore the override two lines below. The token is the
// STRENGTH; the mix belongs to whatever paints.
//
// ── THE MISSING VARIANT IS TWO TOKEN OVERRIDES ──────────────────────────────
// Dangling used to be four declarations across two rules (colour, background,
// border-style, and a hover rule restating the tint at 12%). Re-pointing
// `--chip-accent` at `--theme-muted` and dropping the hover strength to 12%
// makes the base rules compute the greyed variant on their own — same pixels,
// one place that knows what a chip looks like.

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
     The accent swap is what greys it — including the hover tint, which is mixed
     from the same variable. */
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
