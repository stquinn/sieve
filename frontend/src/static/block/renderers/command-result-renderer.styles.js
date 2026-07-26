// @ts-check
// command-result-renderer.styles.js — CommandResultRenderer's stylesheet, a
// sibling module per the styles-file-geography convention
// (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md, "Styles
// file geography"): the renderer file starts with its class — behaviour first —
// and any sheet over ~30 lines lives in its own `<kind>-renderer.styles.js`
// sibling (`export const <kind>Styles = /* css */ \`…\``), imported into the
// class's `static styles`. Renderer-internal — nothing outside
// command-result-renderer.js imports it.
//
// CSS text using ONLY --theme-* variables for colour (the host<->renderer
// styling contract — no hardcoded hex/rgba, no fallbacks). The command-result
// kind is the HONEST envelope for non-AI slash commands (/uuid, /hash, /base64,
// /env, /jwt, /now, /stats): a header with the /cmd chip + a status badge, a
// title, and a sanctioned-markdown body. It mounts inside the detached-answer
// popup (command-popup.js), so its chrome is intentionally lighter than the
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
    font-size: 12px;
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
    font-size: 10px;
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
    font-size: 0.88em;
    color: var(--theme-accentCyan);
  }
`
