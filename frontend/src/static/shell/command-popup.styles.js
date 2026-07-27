// @ts-check
// command-popup.styles.js — CommandPopup's stylesheet (sibling carriage, the
// same component-owns-its-styles pattern the block renderers use; carried via
// RendererStyleRegistry). Colours are --theme-* vars only.
//
// The ai-spin keyframes and the .status-bar__spinner base the popup spinner
// composes with live in editor.css — keyframes are document-global, so an
// adopted sheet can reference them freely.

export const commandPopupStyles = `
  /* The detached-answer host (#55): scrimless, never steals focus — an
     appearance, not an interruption. Visual grammar (entrance, button
     feedback) matches the app's other dialogs. */
  .command-popup {
    position: fixed;
    z-index: 1000;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(90vw, 920px);
    height: min(80vh, 640px);
    background: var(--theme-bgAlt);
    border: 1px solid var(--theme-border2);
    border-radius: 12px;
    box-shadow: 0 20px 60px color-mix(in srgb, var(--theme-bgDark) 65%, transparent);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* Same entrance as the app's other dialogs (ask-popup, internalize). */
    animation: command-popup-in 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  /* modal-scale-in resolves its transform against translateX(-50%) dialogs;
     this popup centres with translate(-50%,-50%), so it needs its own frames. */
  @keyframes command-popup-in {
    from { transform: translate(-50%, calc(-50% - 10px)) scale(0.95); opacity: 0; }
    to   { transform: translate(-50%, -50%) scale(1); opacity: 1; }
  }
  .command-popup__bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 20px;
    background: var(--theme-bgDark);
    border-bottom: 1px solid var(--theme-border2);
  }
  .command-popup__title {
    font-size: 13px;
    font-weight: 700;
    color: var(--theme-accentCyan);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .command-popup__actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .command-popup__body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px 28px;
    user-select: text;
    font-size: 15px;
    line-height: 1.65;
  }
  .command-popup__btn {
    background: transparent;
    border: 1px solid var(--theme-border2);
    color: var(--theme-textDim);
    cursor: pointer;
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.15s ease;
  }
  .command-popup__btn:hover {
    color: var(--theme-text);
    background: var(--theme-border);
    border-color: var(--theme-accentPrimary);
  }
  .command-popup__btn:active {
    transform: translateY(1px);
    background: var(--theme-bgDark);
  }
  .command-popup__btn:focus-visible {
    outline: 2px solid var(--theme-accentPrimary);
    outline-offset: 1px;
  }
  .command-popup__btn--delete {
    color: var(--theme-accentRed);
    border-color: color-mix(in srgb, var(--theme-accentRed) 40%, transparent);
  }
  .command-popup__btn--delete:hover {
    color: var(--theme-accentRed);
    background: color-mix(in srgb, var(--theme-accentRed) 15%, transparent);
    border-color: var(--theme-accentRed);
  }
  /* Copy micro-feedback: the button announces success itself (flash class set
     by CommandPopup for ~1.2s) — the scrimless popup has no toast channel. */
  .command-popup__btn--copied,
  .command-popup__btn--copied:hover {
    color: var(--theme-accentGreen);
    border-color: var(--theme-accentGreen);
    background: color-mix(in srgb, var(--theme-accentGreen) 12%, transparent);
  }
  /* Generic status view (pending / error) — centred spinner-or-icon + labels. */
  .command-popup__status {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 16px;
    color: var(--theme-textDim);
  }
  /* Reuses .status-bar__spinner (border + ai-spin keyframes); just resizes. */
  .command-popup__spinner {
    width: 20px;
    height: 20px;
    border-width: 2px;
  }
  .command-popup__status-icon {
    font-size: 28px;
    line-height: 1;
  }
  .command-popup__status-label {
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 0.04em;
  }
  .command-popup__status-detail {
    font-size: 12px;
    max-width: 400px;
    text-align: center;
    opacity: 0.6;
  }
  .command-popup__status--error { color: var(--theme-accentRed); }

  /* Popup-hosted block chrome suppression — the HOST's decision, so it lives
     with the host's styles. In a document a block's shell (border/background)
     and kind/status badge announce its identity among siblings; here the
     dialog IS the frame and the title bar already names the command, so the
     shell double-frames and the badge/chip duplicates. Question/title and
     body stay — a re-summoned badge needs "what did I ask". Selectors carry
     an extra class of specificity so they beat the renderers' single-class
     rules regardless of adopted-sheet registration order. */
  .command-popup__body .sieve-ai-block,
  .command-popup__body .sieve-ai-block:hover,
  .command-popup__body .sieve-command-result,
  .command-popup__body .sieve-command-result:hover {
    border: none;
    background: transparent;
    padding: 0;
    margin: 0;
    box-shadow: none;
  }
  .command-popup__body .ai-block__badge,
  .command-popup__body .command-result__chip,
  .command-popup__body .command-result__badge {
    display: none;
  }

  /* Editor gutter rule suppression (#59). AiBlockRenderer/CommandResultRenderer
     tag their content wrapper with the bare .tiptap class to inherit the
     document's markdown typography (tables, headings, code) — but editor.css's
     .tiptap::before is the MAIN editor's line-gutter separator: a fixed-
     viewport 1px rule positioned from --sidebar-w/--chrome-w/--editor-top, with
     no awareness of the popup at all. Reusing the class name pulls that rule in
     for free, so a second, mispositioned gutter line was bleeding straight down
     through the dialog. It carries no identity here (there is no gutter to
     separate), so the host drops it outright, same as the badge/chip chrome.
     Extra class of specificity out-ranks editor.css deterministically. */
  .command-popup__body .tiptap::before {
    display: none;
  }

  /* Tables re-contrasted for THIS surface. The document's .tiptap table rules
     assume the page background (--theme-bg): cell borders in --theme-border2
     and header cells in --theme-bgAlt — but the popup's surface IS bgAlt, so
     in here the header melts into the dialog and the borders sit within a
     shade of the background. Extra .tiptap class in the selectors out-ranks
     the editor.css rules deterministically (not just by sheet order). */
  .command-popup__body .tiptap table {
    border: 1px solid var(--theme-border);
  }
  .command-popup__body .tiptap table th,
  .command-popup__body .tiptap table td {
    border: 1px solid var(--theme-border);
  }
  .command-popup__body .tiptap table th {
    background: var(--theme-bgDark);
  }
  .command-popup__body .tiptap table tr:nth-child(even) td {
    background: color-mix(in srgb, var(--theme-bgDark) 55%, transparent);
  }
`
