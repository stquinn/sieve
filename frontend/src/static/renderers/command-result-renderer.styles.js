// @ts-check
// CommandResultRenderer's stylesheet: CSS text using ONLY --theme-* variables
// for colour (no hardcoded hex/rgba, no fallbacks). A header with the /cmd chip
// + a status badge, a title, and a sanctioned-markdown body. It mounts inside
// the detached-answer popup, so its chrome is intentionally lighter than the
// editor-embedded ai-block (no absolute-positioned border badge).

export const commandResultStyles = /* css */ `
  .command-result {
    position: relative;
  }

  /* Header: /cmd chip + status badge, on one baseline. */
  .command-result__header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 0.75rem;
    user-select: none;
    -webkit-user-select: none;
  }

  .command-result__chip {
    font-family: var(--theme-monoFont);
    /* Secondary/meta tier (see editor.css's .tiptap comment) — was 12px. */
    font-size: calc(var(--doc-size) * 0.75);
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--theme-accentPrimary);
    background: color-mix(in srgb, var(--theme-accentPrimary) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-accentPrimary) 30%, transparent);
    border-radius: 4px;
    padding: 1px 7px;
  }

  .command-result__badge {
    font-family: var(--theme-monoFont);
    /* Smallest chrome tier (badges/chips) — was 10px. */
    font-size: calc(var(--doc-size) * 0.7);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--theme-textDim);
    border: 1px solid var(--theme-border2);
    border-radius: 4px;
    padding: 1px 6px;
  }

  .command-result__badge--complete {
    color: var(--theme-accentGreen);
    border-color: color-mix(in srgb, var(--theme-accentGreen) 40%, transparent);
  }

  .command-result__badge--pending {
    color: var(--theme-accentPrimary);
    border-color: color-mix(in srgb, var(--theme-accentPrimary) 40%, transparent);
  }

  .command-result__badge--stale,
  .command-result__badge--timeout,
  .command-result__badge--error {
    color: var(--theme-accentRed);
    border-color: color-mix(in srgb, var(--theme-accentRed) 40%, transparent);
  }

  /* Reset tiptap defaults for the popup-hosted body renderer. */
  .command-result .tiptap {
    min-height: 0;
    padding: 0;
  }

  /* A literal \`---\` in a response is a real markdown hr; render it subtly. */
  .command-result hr {
    border: none;
    border-top: 1px solid color-mix(in srgb, var(--theme-accentPrimary) 30%, transparent);
    margin: 0.75rem 0;
  }

  /* Inline code (excludes block code inside <pre>). */
  .command-result :not(pre) > code {
    background: color-mix(in srgb, var(--theme-accentPrimary) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-accentPrimary) 20%, transparent);
    border-radius: 3px;
    padding: 0.1em 0.35em;
    /* Normalized onto the code tier (0.85) — was 0.88em, ~0.4px shift. */
    font-size: calc(var(--doc-size) * 0.85);
    color: var(--theme-accentCyan);
  }
`
