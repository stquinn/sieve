// @ts-check
// log-renderer.styles.js — LogRenderer's stylesheet, a sibling module per the
// styles-file-geography convention (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md,
// "Styles file geography"): a renderer file starts with its class — behaviour
// first, never a CSS wall — so any sheet over ~30 lines lives in its own
// `<kind>-renderer.styles.js` sibling module, imported into the class's
// `static styles`. This module is renderer-internal — nothing outside
// log-renderer.js imports it.
//
// Sources (moved here in the same change per the spec — style carriage is
// never a separate pass):
//   - the shell + body/gutter/code-area/edit chrome: log's OWN scoped copy of
//     the former UNSCOPED `.sieve-block__body`/`.sieve-block__gutter`/etc
//     rules in editor.css (mirrors code-renderer.styles.js's identical
//     re-scoping — see that file's header). Log's dom no longer carries the
//     borrowed `sieve-block--code` class (see log-renderer.js's header for
//     why that coupling was retired), so this kind needed its OWN complete
//     shell copy, not just body chrome.
//   - `.sieve-block--log .log-tok-*` / `.log-line-*` (decoration classes) and
//     `.log--hide-noise`: carried verbatim from editor.css, already scoped.
//   - `.log-block__toggle*` (raw/explore pill): a NEW log-owned class,
//     replacing the borrowed `.diagram-block__toggle*` classes the old
//     LogHeader used (see log-renderer.js's header — that borrowing broke
//     the moment diagram's Phase-2 migration moved those classes into
//     diagram-renderer.styles.js's lazily-registered stylesheet). Same visual
//     values as diagram's pill; `--sieve-focus-accent` (declared on
//     `.sieve-block--log` in editor.css, this kind's teal) drives the active
//     state exactly as it already did before this migration.
//   - `.log-block__edit-area` / `.log-block__explore-area` / `.log-block__table`
//     / `.log-block__row` / `.log-block__cell` / `.log-block__table-msg`: the
//     Explore table's look, previously built as ad-hoc inline `element.style.*`
//     assignments in the old NodeView (now editor/surfaces/node-views/log-node-view.js) — moved into
//     real CSS here (LogRenderer.js's #renderTable now only sets the classes
//     + the few genuinely PER-CELL values: colour/opacity/whitespace that vary
//     row-to-row by log severity, which stay inline for the same reason a
//     renderer sets style.width from a per-instance value elsewhere in this
//     codebase).
//
// House rule: colour only via --theme-* vars / color-mix — nothing hardcoded
// here needed conversion (the original inline styles already used theme vars
// throughout).

export const logStyles = /* css */ `
  .sieve-block--log {
    display: flex;
    flex-direction: column;
    background: var(--theme-bgDark);
    border: 1px solid var(--theme-aiBlockBorder);
    border-radius: 8px;
    transition: border-color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;
  }

  .sieve-block--log:hover {
    border-color: color-mix(in srgb, var(--sieve-focus-accent) 60%, var(--theme-aiBlockBorder));
    box-shadow: 0 4px 20px color-mix(in srgb, var(--theme-bgDark) 25%, transparent);
  }

  .sieve-block--log .sieve-block__body {
    display: flex;
    overflow: hidden;
    border-radius: 0 0 8px 8px;
  }

  .sieve-block--log .sieve-block__gutter {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    padding: 0.85em 0.6em;
    background: var(--theme-bgDark);
    border-right: 1px solid var(--theme-gutterLineColor);
    color: var(--theme-lineNumberColor);
    font-family: var(--theme-monoFont);
    /* Code tier of the editor's four-tier scale (see editor.css's .tiptap
       comment) — MUST stay numerically equal to .sieve-block__highlight/
       __edit below for row-alignment (see code-renderer.styles.js's
       identical gutter comment; this is log's copy of the same shape). */
    font-size: calc(var(--doc-size) * 0.85);
    line-height: 1.6;
    user-select: none;
    flex-shrink: 0;
  }

  .sieve-block--log .sieve-block__gutter span {
    display: block;
    line-height: 1.6;
  }

  /* Pseudo-content line numbers (data-ln) — see code-renderer.styles.js for
     the WebKit copy-leak rationale. */
  .sieve-block--log .sieve-block__gutter span::before {
    content: attr(data-ln);
  }

  .sieve-block--log .sieve-block__code-area {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  /* .sieve-block__highlight has no corresponding element in this kind's DOM
     today (a retired textarea+highlight-overlay layout) — carried forward
     verbatim for parity with code-renderer.styles.js / diagram-renderer.styles.js,
     which do the same for the identical reason. */
  .sieve-block--log .sieve-block__highlight,
  .sieve-block--log .sieve-block__edit {
    grid-area: 1 / 1;
    font-family: var(--theme-monoFont);
    /* Code tier — must match .sieve-block__gutter above (row-alignment). */
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

  .sieve-block--log .sieve-block__highlight {
    pointer-events: none;
    background: transparent;
    border: none;
    overflow: hidden;
  }

  .sieve-block--log .sieve-block__edit {
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

  .sieve-block--log .sieve-block__highlight code,
  .sieve-block--log .sieve-block__edit code {
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

  .log-block__edit-area {
    display: flex;
    flex-direction: row;
    width: 100%;
    max-height: 600px;
    overflow-y: auto;
    /* Let the gutter + code grid grow to their natural (full) height and have
       THIS wrapper scroll — the default align-items:stretch would pin the
       grid to the 600px container height and clip everything past ~28 lines
       with nothing to scroll. */
    align-items: flex-start;
  }

  /* ── Log highlighting (decoration classes) ─────────────────────────────
     Applied by the log adapter's decoration plugin to the read-only log
     text. Colours + noise dimming live here so the "Toggle Noise" button is
     a pure view concern: it flips .log--hide-noise on the block root. */
  .sieve-block--log .log-tok-error  { color: var(--theme-red);    font-weight: bold; }
  .sieve-block--log .log-tok-warn   { color: var(--theme-yellow); }
  .sieve-block--log .log-tok-info   { color: var(--theme-accentCyan); }
  .sieve-block--log .log-tok-level  { font-weight: bold; }
  .sieve-block--log .log-tok-thread { color: var(--theme-magenta); }
  .sieve-block--log .log-tok-logger { color: var(--theme-green); }
  .sieve-block--log .log-tok-bracket { color: var(--theme-textSubtle); font-weight: 500; }
  .sieve-block--log .log-tok-noise  { opacity: 0.6; }

  .sieve-block--log .log-line-error { color: var(--theme-red);    font-weight: bold; }
  .sieve-block--log .log-line-warn  { color: var(--theme-yellow); }
  .sieve-block--log .log-line-info  { opacity: 0.85; }

  /* Noise hidden: dim timestamps/pid/thread/logger and de-emphasise info lines. */
  .sieve-block--log.log--hide-noise .log-tok-noise { opacity: 0.15; }
  .sieve-block--log.log--hide-noise .log-line-info { opacity: 0.3; }

  /* ── Explore table ──────────────────────────────────────────────────── */

  .log-block__explore-area {
    display: flex;
    flex-direction: row;
    width: 100%;
  }

  .log-block__table {
    flex: 1;
    overflow: auto;
    max-height: 600px;
    padding: 12px 16px;
    font-family: var(--theme-monoFont);
    /* Code tier (see .tiptap comment) — was a fixed 13px that never scaled. */
    font-size: calc(var(--doc-size) * 0.85);
    line-height: 1.5;
    user-select: text;
    -webkit-user-select: text;
    cursor: text;
  }

  .log-block__table-msg {
    padding: 16px;
    color: var(--theme-textSubtle);
  }

  .log-block__table-msg--error {
    color: var(--theme-red);
  }

  .log-block__rows {
    display: flex;
    flex-direction: column;
  }

  .log-block__row {
    display: flex;
    gap: 12px;
    margin-bottom: 4px;
  }

  .log-block__row--header {
    position: sticky;
    top: 0;
    background: var(--theme-bgDark);
    z-index: 10;
    padding-bottom: 4px;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--theme-border);
    text-transform: uppercase;
    /* Smallest chrome tier (see .tiptap comment) — was a fixed 11px. */
    font-size: calc(var(--doc-size) * 0.7);
    letter-spacing: 0.5px;
    font-weight: bold;
    color: var(--theme-textSubtle);
  }

  .log-block__cell {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Raw/Explore toggle pill (log-owned — see file header for why this is
     no longer borrowed from diagram-renderer.styles.js's classes) ──────── */

  .log-block__toggle {
    display: flex;
    align-items: center;
    background: var(--theme-bgLight);
    border: 1px solid var(--theme-border2);
    border-radius: 4px;
    overflow: hidden;
    height: 22px;
  }

  .log-block__toggle-btn {
    /* Smallest chrome tier (see .tiptap comment) — was a fixed 10px. */
    font-size: calc(var(--doc-size) * 0.7);
    padding: 0 9px;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--theme-fg3);
    cursor: pointer;
    border: none;
    background: transparent;
    letter-spacing: 0.02em;
    transition: color 0.1s;
  }

  .log-block__toggle-btn svg {
    width: 9px;
    height: 9px;
    flex-shrink: 0;
  }

  .log-block__toggle-btn--active-raw,
  .log-block__toggle-btn--active-explore {
    background: var(--theme-bgDark);
    color: var(--sieve-focus-accent, var(--theme-accentTeal));
    border-radius: 3px;
    margin: 1px;
    height: calc(100% - 2px);
    padding: 0 8px;
  }
`
