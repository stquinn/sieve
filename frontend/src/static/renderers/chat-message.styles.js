// @ts-check
// ChatMessage's stylesheet. The `--utterance-*` (the speaker surface),
// `--record-*` (the answering side: Retry, beside the pending slot) and
// `--quote-*` tokens it reads are owned by editor.css's `:root`. A tint is a
// STRENGTH mixed in the rule that paints, as the `--chip-*` set's is.
//
// A message sets its own face, the theme's UI face, and the answer's `.tiptap`
// typography inherits it: `.tiptap` carries the note editor's face, a monospace
// stack in every shipped theme. A message sets no margin of its own: the
// spacing between messages is the thread's.
//
// The actions are hidden by opacity, never by display or visibility, so they
// stay in the tab order and focusing one shows them. A block's Copy is shown by
// its own block's hover or focus and by nothing about the message.

export const chatMessageStyles = /* css */ `
  .chat-message {
    display: flex;
    flex-direction: column;
    font-family: var(--theme-uiFont);
    font-size: var(--doc-size);
  }

  .chat-message:focus {
    outline: none;
  }

  .chat-message:focus-visible .chat-message__bubble,
  .chat-message--answer:focus-visible .chat-message__body {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-accentPrimary) 35%, transparent);
  }

  .chat-message--question {
    align-items: flex-end;
  }

  .chat-message--answer {
    align-items: stretch;
  }

  /* My question: right, fit to its content, in the speaker surface. */
  .chat-message__bubble {
    box-sizing: border-box;
    width: fit-content;
    max-width: 75%;
    padding: 10px 14px;
    border: 1px solid color-mix(in srgb, var(--utterance-accent) var(--utterance-border-strength), transparent);
    border-radius: var(--utterance-radius);
    background: color-mix(in srgb, var(--utterance-accent) var(--utterance-tint-strength), transparent);
    line-height: 1.6;
  }

  .chat-message__bubble > .chat-message__body > .ai-block__element + .ai-block__element {
    margin-top: 8px;
  }

  .chat-message__attachments {
    --chip-max-width: 15rem;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 9px;
    padding-top: 8px;
    border-top: 1px solid color-mix(in srgb, var(--utterance-accent) var(--utterance-rule-strength), transparent);
  }

  .chat-message__body[hidden] + .chat-message__attachments {
    margin-top: 0;
    padding-top: 0;
    border-top: none;
  }

  /* The answer: left, the column's whole width, and no container of its own. It
     wears .tiptap for the document's prose typography, and these rules undo
     what .tiptap is for in a note: the editor's face, its rail and its height. */
  .chat-message--answer > .chat-message__body.tiptap {
    width: 100%;
    margin: 0;
    padding: 0;
    min-height: 0;
    font-family: inherit;
    line-height: 1.62;
  }

  .chat-message--answer > .chat-message__body > .ai-block__element {
    position: relative;
  }

  .chat-message--answer > .chat-message__body > .ai-block__element + .ai-block__element {
    margin-top: 10px;
  }

  /* A block in a document carries the margins that part it from its neighbours
     there; inside a message the gap between rows is the only spacing. */
  .chat-message__body .sieve-block {
    margin-top: 0;
    margin-bottom: 0;
  }

  .chat-message__body .sieve-block--prose .sieve-block__content > * {
    margin-top: 0;
    margin-bottom: 0;
  }

  .chat-message--question .sieve-block--prose .sieve-block__content > * + * {
    margin-top: 8px;
  }

  .chat-message--answer .sieve-block--prose .sieve-block__content > * + * {
    margin-top: 10px;
  }

  /* Inline code in a message: the mono face a tier down, in the citation accent. */
  .chat-message .sieve-block--prose :not(pre) > code {
    padding: 1px 5px;
    border: 1px solid color-mix(in srgb, var(--theme-accentPrimary) 20%, transparent);
    border-radius: 3px;
    background: color-mix(in srgb, var(--theme-accentPrimary) 10%, transparent);
    color: var(--theme-accentCyan);
    font-family: var(--theme-monoFont);
    font-size: calc(var(--doc-size) * 0.85);
  }

  /* A quote in a question: the quote accent's band, full text strength. */
  .chat-message .sieve-block--prose blockquote {
    margin-left: 0;
    padding: 4px 10px;
    border-left: 3px solid var(--quote-accent);
    border-radius: 0 6px 6px 0;
    background: color-mix(in srgb, var(--quote-accent) var(--quote-tint-strength), transparent);
    color: var(--theme-text);
    font-style: normal;
  }

  /* What an answer points at, it cites: its references draw in the cites accent. */
  .chat-message--answer > .chat-message__body > .ai-block__element[data-kind="reference"] {
    --chip-accent: var(--theme-accentCyan);
    --chip-tint-strength: 10%;
  }

  /* The row under a message: its time and its actions, at the message's edge. */
  .chat-message__meta {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 28px;
    margin-top: 6px;
  }

  .chat-message--question > .chat-message__meta {
    flex-direction: row-reverse;
  }

  .chat-message__time {
    color: var(--theme-textDim);
    font-size: calc(var(--doc-size) * 0.75);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .chat-message__actions {
    display: flex;
    gap: 6px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .chat-message--active .chat-message__actions,
  .chat-message--latest .chat-message__actions,
  .chat-message__actions:focus-within {
    opacity: 1;
  }

  .chat-message__copy,
  .chat-message__quote,
  .chat-message__block-copy {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid var(--theme-border2);
    border-radius: 6px;
    background: color-mix(in srgb, var(--theme-bgAlt) 55%, var(--theme-bg));
    color: var(--theme-textDim);
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }

  .chat-message__copy,
  .chat-message__quote {
    width: 28px;
    height: 28px;
  }

  .chat-message__copy svg,
  .chat-message__quote svg {
    width: 14px;
    height: 14px;
  }

  .chat-message__copy:hover,
  .chat-message__quote:hover,
  .chat-message__block-copy:hover,
  .chat-message__copy:focus-visible,
  .chat-message__quote:focus-visible,
  .chat-message__block-copy:focus-visible {
    border-color: var(--theme-textDim);
    background: var(--theme-bgAlt);
    color: var(--theme-text);
    outline: none;
  }

  /* Each answer block's own Copy, in the gutter beside the block's top edge. */
  .chat-message__block-copy {
    position: absolute;
    top: 0;
    left: calc(100% + 4px);
    width: 24px;
    height: 24px;
    opacity: 0;
    transition: opacity 0.12s ease, background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }

  .chat-message__block-copy svg {
    width: 13px;
    height: 13px;
  }

  .ai-block__element:hover > .chat-message__block-copy,
  .ai-block__element:focus-within > .chat-message__block-copy {
    opacity: 1;
  }

  .chat-message__status {
    margin-top: 8px;
  }

  .chat-message__body[hidden] + .chat-message__status {
    margin-top: 0;
  }

  .chat-message__failure {
    display: flex;
    align-items: center;
    gap: 0.75em;
    color: var(--theme-muted);
    font-style: italic;
    font-size: calc(var(--doc-size) * 0.85);
  }

  .chat-message__retry {
    min-height: 28px;
    padding: 2px 10px;
    border: 1px solid var(--record-border-color);
    border-radius: 6px;
    background: var(--record-background);
    color: var(--record-accent);
    font-family: var(--theme-uiFont);
    font-style: normal;
    font-size: calc(var(--doc-size) * 0.75);
    cursor: pointer;
  }

  .chat-message__retry:hover,
  .chat-message__retry:focus-visible {
    border-color: var(--record-accent);
    outline: none;
  }

  /* A message the reader was taken to: its own face, the bubble or the answer's
     body, tinted faintly with the accent to just past its edge, fading once.
     The tint is a shadow, so it follows the face's corners and leaves its
     background alone. Under reduced motion there is no mark. */
  .chat-message--revealed {
    scroll-margin-top: 16px;
  }

  .chat-message--answer > .chat-message__body {
    border-radius: 6px;
  }

  .chat-message--revealed > .chat-message__bubble,
  .chat-message--answer.chat-message--revealed > .chat-message__body {
    animation: chat-message-revealed 1s ease-out 1;
  }

  @keyframes chat-message-revealed {
    from {
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--theme-accentPrimary) 10%, transparent),
        inset 0 0 0 100vmax color-mix(in srgb, var(--theme-accentPrimary) 10%, transparent);
    }
    to {
      box-shadow: 0 0 0 6px transparent, inset 0 0 0 100vmax transparent;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-message--revealed > .chat-message__bubble,
    .chat-message--answer.chat-message--revealed > .chat-message__body {
      animation: none;
    }
  }

  .chat-message [hidden] {
    display: none;
  }
`
