// @ts-check
// What the footer says when the draft resolves to a command: the verb named
// beside its description, and Send saying it will RUN that verb rather than ask.
//
// ONE VIEW, ONE STATE. Both halves are drawn from the same `show` call, so the
// button and the badge cannot disagree with each other — and because the panel
// derives that state from the same predicate it dispatches on, neither can
// disagree with what Send actually does.
//
// A COMMAND IS NOT A CHIP. It is drawn as one — the footer has one vocabulary —
// but it names a verb rather than a coordinate, so it carries the accent the
// draft's own `/verb` token carries and never the chip accent beside it.

import { esc } from '../renderers/html-escape.js'

export class CommandCue {
  /** What Send says when the draft is an ask. Read off the button at
   *  construction rather than assumed, so the label stays the template's. */
  static #ASK_LABEL = 'Send'

  /** The class Send carries while a command is armed: it takes the command
   *  accent, so the button and the badge beside it are one statement. */
  static #SEND_ARMED = 'ask-popup__send--command'

  /** @type {HTMLElement|null} the badge row (null → headless: `show` no-ops) */ #row = null
  /** @type {HTMLElement|null} the Send button whose label follows the state */ #send = null
  /** @type {string} the label Send carries for an ask */ #askLabel = CommandCue.#ASK_LABEL

  /**
   * @param {HTMLElement|null} footerEl the structural `.ask-popup__footer`. The
   *   badge is inserted before Send, so it reads as the last thing said about
   *   the message before the button that sends it.
   */
  constructor(footerEl) {
    if (!footerEl) return
    this.#send = /** @type {HTMLElement|null} */ (footerEl.querySelector('.ask-popup__send'))
    if (this.#send) this.#askLabel = (this.#send.textContent || '').trim() || CommandCue.#ASK_LABEL
    const row = document.createElement('div')
    row.className = 'ask-popup__command'
    row.style.display = 'none'
    footerEl.insertBefore(row, this.#send)
    this.#row = row
  }

  /**
   * Draws the command the draft resolves to, or takes the cue down when it
   * resolves to none.
   * @param {{name: string, description?: string}|null} cmd
   */
  show(cmd) {
    const row = this.#row
    if (row) {
      row.style.display = cmd ? 'flex' : 'none'
      row.innerHTML = cmd ? CommandCue.#badge(cmd) : ''
    }
    const send = this.#send
    if (!send) return
    send.textContent = cmd ? 'Run /' + cmd.name : this.#askLabel
    send.classList.toggle(CommandCue.#SEND_ARMED, !!cmd)
  }

  /**
   * @param {{name: string, description?: string}} cmd
   * @returns {string} the badge's markup
   */
  static #badge(cmd) {
    const description = cmd.description ? String(cmd.description) : ''
    return '<span class="ask-command-chip" title="' + esc(description) + '">' +
      '<span class="ask-command-chip__verb">/' + esc(cmd.name) + '</span>' +
      (description ? '<span class="ask-command-chip__desc">' + esc(description) + '</span>' : '') +
      '</span>'
  }
}
