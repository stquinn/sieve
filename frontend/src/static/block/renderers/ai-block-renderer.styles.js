// @ts-check
// ai-block-renderer.styles.js — AiBlockRenderer's stylesheet, a sibling module
// per the styles-file-geography convention (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md,
// "Styles file geography", user decision 2026-07-20): a renderer file starts
// with its class — behaviour first, never a CSS wall — so any sheet over
// ~30 lines lives in its own `<kind>-renderer.styles.js` sibling module
// (`export const <kind>Styles = /* css */ \`…\``, Lit-style), imported into
// the class's `static styles`. This module is renderer-internal — nothing
// outside ai-block-renderer.js imports it.
//
// CSS text using ONLY --theme-* variables for colour (the host<->renderer
// styling contract). Carried verbatim from frontend/src/static/editor.css's
// former ".ai-block"/".ai-block__*" rule set (moved here in the same change
// per the spec — style carriage is never a separate pass). NOTE: unlike the
// diagram pilot, this CSS lived in editor.css, not input.css — input.css has
// no ai-block rules at all (verified before moving anything); editor.css is
// the hand-authored stylesheet linked directly in index.html (not part of the
// tailwind build), so no `tailwindcss --minify` rebuild is needed for this
// migration — only editor.css shrinks.
//
// Two changes versus the old global rule set (house rule: no hardcoded colour
// literals):
//   1. the hover/selected box-shadows' rgba(0,0,0,.25) / rgba(0,0,0,.45)
//      become color-mix() against --theme-bgDark, matching the conversion
//      diagram-renderer.styles.js already established for the identical
//      unconverted-rgba idiom;
//   2. `.ai-block__badge::selection` is carried here from editor.css's shared
//      multi-kind selector list (`.ai-block__badge::selection,
//      .web-clip-block__badge::selection, …`) — only this kind's selector
//      moved; the sibling kinds' selectors stay in editor.css until THEY
//      migrate (restraint rule — do not touch what this change doesn't own).
//
// `.sieve-block__heading` (the title/divider region) is DELIBERATELY NOT
// here: it is framework-owned chrome rendered by sieve-block-extension.js's
// titleProvider slot, shared by any future kind that declares one — not
// ai-block-exclusive look-and-feel, so it stays in editor.css per the
// restraint rule (shared clusters get their shared home at their second
// MIGRATED consumer, not before).
//
// `.ai-block__badge--error` intentionally carries no CSS RULE here, same as
// pre-split editor.css: the class is applied by AiBlockRenderer#update() for
// non-COMPLETE/non-PENDING/non-DISPATCHED statuses and for stale
// PENDING/DISPATCHED, but no distinct visual ever existed for it (a
// pre-existing gap, out of scope for this migration — carried over verbatim,
// not fixed).

export const aiBlockStyles = /* css */ `
  .hide-ai-blocks .ai-block {
    display: none !important;
  }

  .ai-block {
    border: 1px solid var(--theme-aiBlockBorder);
    border-radius: 8px;
    background: var(--theme-aiBlockBg);
    margin-top: 1.5rem;
    margin-bottom: 2rem;
    padding: 1.25rem 1.5rem;
    position: relative;
    transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
  }

  .ai-block:hover {
    border-color: color-mix(in srgb, var(--theme-accentPrimary) 60%, var(--theme-aiBlockBorder));
    background: color-mix(in srgb, var(--theme-accentPrimary) 2%, var(--theme-aiBlockBg));
    box-shadow: 0 4px 20px color-mix(in srgb, var(--theme-bgDark) 25%, transparent);
  }

  .ai-block.ProseMirror-selectednode,
  .ai-block.sieve-block--focused {
    border-color: var(--theme-accentPrimary) !important;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-accentPrimary) 25%, transparent),
                0 8px 30px color-mix(in srgb, var(--theme-bgDark) 45%, transparent) !important;
    background: color-mix(in srgb, var(--theme-accentPrimary) 5%, var(--theme-aiBlockBg)) !important;
    outline: none !important;
  }

  .ai-block.ai-block--chain-active {
    border-color: color-mix(in srgb, var(--theme-accentPrimary) 30%, var(--theme-aiBlockBorder)) !important;
    background: color-mix(in srgb, var(--theme-accentPrimary) 4%, var(--theme-aiBlockBg));
  }

  .ai-block.ai-block--chain-active::after {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: 8px;
    border-left: 3px solid var(--theme-accentPrimary);
    pointer-events: none;
    z-index: 5;
  }

  /* Reset tiptap defaults for the internal ai-block AST renderer */
  .ai-block .tiptap {
    min-height: 0;
    padding: 0;
  }

  /* "AI" badge sits in the top border */
  .ai-block__badge {
    position: absolute;
    top: -9px;
    left: 12px;
    background: var(--theme-bg);
    padding: 0 6px;
    /* Smallest chrome tier (badges/chips — see editor.css's .tiptap comment)
       — was a fixed 10px. */
    font-size: calc(var(--doc-size) * 0.7);
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--theme-accentPrimary);
    font-family: var(--theme-monoFont);
    border: 1px solid var(--theme-border2);
    border-radius: 4px;
    z-index: 10;
    user-select: none;
    -webkit-user-select: none;
  }

  .ai-block__badge::selection {
    background: transparent;
    color: inherit;
  }

  .ai-block__badge--thinking {
    border-color: transparent;
    background-clip: padding-box;
    overflow: hidden;
  }

  .ai-block__badge--thinking::before {
    content: '';
    position: absolute;
    top: -50%;
    left: -50%;
    width: 200%;
    height: 200%;
    background: conic-gradient(
      from 0deg,
      transparent 0%,
      var(--theme-accentPrimary) 25%,
      var(--theme-accentPurple) 50%,
      transparent 75%
    );
    animation: ai-border-trace 2s linear infinite;
    z-index: -1;
  }

  .ai-block__badge--thinking::after {
    content: 'AI';
    position: absolute;
    inset: 1px;
    background: var(--theme-bg);
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1;
  }

  @keyframes ai-border-trace {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  /* An @Title the question attached (#74) — the INLINE half of its footer chip.
     Same accent as .ai-block__attachment below, deliberately: the name in the
     sentence and the chip under the answer are one object, and the tint is what
     says so. Tinted rather than coloured-only so it reads as a mark in both
     themes; box-decoration-break keeps the pill's ends when a long title wraps. */
  .ai-block__mention {
    border-radius: 3px;
    padding: 0 2px;
    background: color-mix(in srgb, var(--theme-accentPrimary) 14%, transparent);
    color: var(--theme-accentPrimary);
    font-weight: 500;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }

  /* ── Attachment chips (#74) — the FOOTER region ────────────────────────────
     The documents this turn's question attached. Deliberately quiet: they are
     provenance, not content, so they sit under the answer at badge weight and
     scroll sideways rather than reflowing the block. */
  .ai-block__attachments {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
    align-items: center;
    overflow-x: auto;
    margin-top: 0.9rem;
    padding-top: 0.6rem;
    border-top: 1px solid color-mix(in srgb, var(--theme-accentPrimary) 15%, transparent);
    scrollbar-width: none;
    user-select: none;
    -webkit-user-select: none;
  }

  .ai-block__attachments::-webkit-scrollbar { display: none; }

  .ai-block__attachment {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: 0 0 auto;
    max-width: 15rem;
    padding: 2px 8px;
    border: 1px solid var(--theme-border2);
    border-radius: 999px;
    background: color-mix(in srgb, var(--theme-accentPrimary) 8%, transparent);
    color: var(--theme-accentPrimary);
    font-family: var(--theme-uiFont);
    font-size: calc(var(--doc-size) * 0.72);
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .ai-block__attachment:hover {
    background: color-mix(in srgb, var(--theme-accentPrimary) 18%, transparent);
    border-color: var(--theme-accentPrimary);
  }

  .ai-block__attachment-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Dangling is a NORMAL state, not an error: greyed, marked, still readable. */
  .ai-block__attachment--missing {
    color: var(--theme-muted);
    background: transparent;
    border-style: dashed;
  }

  .ai-block__attachment--missing:hover {
    background: color-mix(in srgb, var(--theme-muted) 12%, transparent);
    border-color: var(--theme-muted);
  }

  .ai-block__attachment::selection,
  .ai-block__attachment-label::selection {
    background: transparent;
    color: inherit;
  }

  /* A literal \`---\` inside a response is a real markdown hr; render it subtly. */
  .ai-block hr {
    border: none;
    border-top: 1px solid color-mix(in srgb, var(--theme-accentPrimary) 30%, transparent);
    margin: 0.75rem 0;
  }

  /* Inline code inside AI blocks (excludes block code inside <pre>) */
  .ai-block :not(pre) > code {
    background: color-mix(in srgb, var(--theme-accentPrimary) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-accentPrimary) 20%, transparent);
    border-radius: 3px;
    padding: 0.1em 0.35em;
    /* Normalized onto the code tier (0.85, see .tiptap comment) — was 0.88em,
       a ~0.4px shift at the default 16px base. */
    font-size: calc(var(--doc-size) * 0.85);
    color: var(--theme-accentCyan);
  }
`
