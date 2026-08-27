// @ts-check
// AiBlockRenderer's stylesheet. Colour comes ONLY from --theme-* variables —
// the host↔renderer styling contract — so no rule here carries a colour literal.
//
// `.sieve-block__heading` (the title/divider region) is deliberately NOT here:
// it is framework-owned chrome, shared by any kind that declares one.
//
// `.ai-block__badge--error` intentionally carries no rule. The class is applied
// for non-COMPLETE statuses, but no distinct visual has ever been designed.

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

  /* ── The question list — the TITLE region ─────────────────────────────────
     The blocks the question is composed of, drawn in order. The framework's
     .sieve-block__heading gives the region its weight and its divider; what is
     owned here is only the spacing BETWEEN elements and the fact that a
     structured element inside a heading is not heading text — a code listing
     must not inherit the question's weight. */
  .ai-block__question > .ai-block__element + .ai-block__element {
    margin-top: 0.6rem;
  }

  /* SPACING BETWEEN ELEMENTS IS THE LIST'S, and only the list's. A composed
     element is a whole block, and a block in a DOCUMENT carries the margins that
     separate it from its neighbours there — 1.5rem above and 2rem below. Inside
     a question those are somebody else's spacing: they double the row gap and
     pad the region top and bottom with space that says nothing. */
  .ai-block__question .sieve-block {
    margin-top: 0;
    margin-bottom: 0;
  }

  /* Rendered markdown outside a .tiptap surface keeps the browser's own
     paragraph margins. The heading region promises no leading or trailing
     margin, but its rules reach only its DIRECT children, and an element's text
     is two levels in — so the promise is re-made where the text actually is.
     Inner paragraphs keep their margins: those separate prose from prose. */
  .ai-block__question .sieve-block__content > :first-child {
    margin-top: 0;
  }

  .ai-block__question .sieve-block__content > :last-child {
    margin-bottom: 0;
  }

  .ai-block__element:not([data-kind="prose"]) {
    font-weight: normal;
  }

  /* A kind the question list has no rendering for: its name, then its literal
     text. Quiet — it is a fallback, not a design. */
  .ai-block__element-plain pre {
    margin: 0.35rem 0 0;
    white-space: pre-wrap;
    font-family: var(--theme-monoFont);
    font-size: calc(var(--doc-size) * 0.85);
    color: var(--theme-textSubtle);
  }

  /* An @Title the question attached — the INLINE half of its footer chip. Same
     accent as the ReferenceChip in the footer row below, so the name in the
     sentence and the chip under the answer read as one object. Tinted rather
     than coloured-only so it reads as a mark in both themes;
     box-decoration-break keeps the pill's ends when a long title wraps. */
  .ai-block__mention {
    border-radius: 3px;
    padding: 0 2px;
    background: color-mix(in srgb, var(--theme-accentPrimary) 14%, transparent);
    color: var(--theme-accentPrimary);
    font-weight: 500;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }

  /* ── Attachment chips — the FOOTER region ─────────────────────────────────
     The documents this turn's question attached. Deliberately quiet: they are
     provenance, not content, so they sit under the answer at badge weight and
     scroll sideways rather than reflowing the block.

     THE ROW IS AI-BLOCK'S; THE CHIP IS NOT. The chips inside are
     ReferenceChip (renderers/reference-chip.js) and carry their own
     appearance — this rule set owns only the strip that holds them. The one
     thing the ROW says about its chips is how far they may run: a chip under an
     answer is a compact provenance mark, so it ellipsises at 15rem. The
     reference BLOCK deliberately lifts that clamp (its chip is the block's
     whole identity), which is exactly why the clamp is the row's to set and not
     the chip's to assume. */
  .ai-block__attachments {
    --chip-max-width: 15rem;
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
