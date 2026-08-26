// @ts-check
// CodeRenderer's stylesheet, SCOPED under `.sieve-block--code` so this kind owns
// a complete, independent copy of its shell and body chrome. Renderer-internal,
// and colour comes only from --theme-* vars / color-mix.
//
// The `--sieve-focus-accent` custom property declaration on `.sieve-block--code`
// stays FRAMEWORK-owned in editor.css (it feeds the shared generic
// `.sieve-block:focus-within` / `.ProseMirror-selectednode` rule every kind's
// shell participates in) — only the kind's OWN visual properties live here.

export const codeStyles = /* css */ `
  .sieve-block--code {
    display: flex;
    flex-direction: column;
    background: var(--theme-bgDark);
    border: 1px solid var(--theme-aiBlockBorder);
    border-radius: 8px;
    transition: border-color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;
  }

  .sieve-block--code:hover {
    border-color: color-mix(in srgb, var(--sieve-focus-accent) 60%, var(--theme-aiBlockBorder));
    box-shadow: 0 4px 20px color-mix(in srgb, var(--theme-bgDark) 25%, transparent);
  }

  .sieve-block--code .sieve-block__body {
    display: flex;
    overflow: hidden;
    border-radius: 0 0 8px 8px;
  }

  /* Gutter font-size is the code tier of the editor's four-tier scale (1 /
     0.85 / 0.75 / 0.7 of --doc-size — see editor.css's .tiptap comment) and
     MUST stay numerically equal to .sieve-block__highlight/__edit below:
     this gutter is a separate column of line-number rows kept aligned with
     the code rows purely by matching row height (line-height * font-size) —
     any divergence would drift the numbers off their lines. Comment lives
     OUTSIDE the declaration block (not before font-size) so it can't perturb
     diagram-mermaid-init.test.js's naive prop/value rule-body parser (no
     comment-stripping — a comment inside the block folds into whichever
     property key follows it, which would break the property-key match
     against diagram's identical copy). */
  .sieve-block--code .sieve-block__gutter {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    padding: 0.85em 0.6em;
    background: var(--theme-bgDark);
    border-right: 1px solid var(--theme-gutterLineColor);
    color: var(--theme-lineNumberColor);
    font-family: var(--theme-monoFont);
    font-size: calc(var(--doc-size) * 0.85);
    line-height: 1.6;
    user-select: none;
    flex-shrink: 0;
  }

  .sieve-block--code .sieve-block__gutter span {
    display: block;
    line-height: 1.6;
  }

  /* The number lives in pseudo-content (LineGutter sets data-ln, no text
     node): WebKit ignores user-select inside a contenteditable host, so real
     gutter text leaks line numbers into copied selections. */
  .sieve-block--code .sieve-block__gutter span::before {
    content: attr(data-ln);
  }

  .sieve-block--code .sieve-block__code-area {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  /* Code tier — must match .sieve-block__gutter above (row-alignment); see
     that rule's comment for why (and why this comment sits outside the
     declaration block). */
  .sieve-block--code .sieve-block__highlight,
  .sieve-block--code .sieve-block__edit {
    grid-area: 1 / 1;
    font-family: var(--theme-monoFont);
    font-size: calc(var(--doc-size) * 0.85);
    line-height: 1.6;
    padding: 0.85em 1.1em;
    white-space: pre-wrap;
    word-break: break-word;
    tab-size: 2;
    margin: 0;
    min-height: 2.5em;
    box-sizing: border-box;
  }

  .sieve-block--code .sieve-block__highlight {
    pointer-events: none;
    background: transparent;
    border: none;
    overflow: hidden;
  }

  .sieve-block--code .sieve-block__highlight code,
  .sieve-block--code .sieve-block__edit code {
    display: block;
    background: transparent;
    border: none;
    padding: 0;
    font: inherit;
    white-space: inherit;
    word-break: inherit;
    tab-size: inherit;
    color: inherit;
    border-radius: 0;
  }

  .sieve-block--code .sieve-block__edit {
    position: relative;
    z-index: 1;
    color: transparent;
    caret-color: var(--theme-text);
    background: transparent;
    border: none;
    outline: none;
    resize: none;
    overflow: hidden;
    cursor: text;
  }
`
