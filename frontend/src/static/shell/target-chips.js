// @ts-check
// target-chips.js — TargetChips: the Ask composer's view of WHAT THE MESSAGE
// WILL ACT ON, drawn in the footer beside the attachment chips (#74).
//
// THE HEADER SHOWS THE SUBJECT, THE FOOTER SHOWS THE CONTEXT. While Ask was the
// only thing the box could do, the target WAS the subject and the header said so
// ("Ask About 'retry policy'"). A slash command breaks that — `/btw` is the
// subject and the target is merely what it receives — so the header names the
// command and the context moves down here, where it stays visible either way.
//
// VIEW-ONLY, AND THAT IS THE POINT. The editor owns the selection; this only
// draws it. So a target chip carries NO ✕: the cross keeps exactly one meaning
// in this footer — drop an attachment — and a cross that sometimes meant "change
// the selection from the panel" would be a second, worse way to do what moving
// the caret already does.
//
// BOTH ROWS ARE COORDINATE CHIPS, and they are styled as one species from one
// set of rules (editor.css, `.ask-chip, .ask-target-chip`): an attachment chip
// holds a coordinate pointing at another document, this one holds the local
// target. The difference is said with the MISSING ✕ and an outline-instead-of-
// fill, never with contrast — a first attempt at "quieter" faded it until it
// could not be read.
//
// A TARGET CHIP IS NOT AN ATTACHMENT, though. It is deliberately NOT part of
// ComposerAttachments: it never enters the manifest, never reaches the persisted
// attrs, and a send leaves it standing because the selection it describes
// outlives the message. Two rows in one footer is the honest shape of two kinds
// of context — one the editor owns, one the composer does.
//
// TODAY IT DRAWS ONE CHIP: the resolved target's own label, which is the string
// the header used to show. A chip PER BLOCK of a multi-block selection needs a
// per-block label, and neither `blockIds` (ids) nor `blockKind` (the primary
// block only) is one — see the interaction contract for what that costs and why
// it is tracked separately. The list shape here is what that would extend.

import { esc } from '../block/renderers/html-escape.js'

/**
 * @typedef {import('../editor/selection-model.js').SelectionContext} SelectionContext
 */

export class TargetChips {
  /** @type {HTMLElement|null} the chip row (null → headless: every verb no-ops) */ #row = null
  /** @type {string[]} what is drawn — one label per chip, in order */ #labels = []

  /**
   * @param {HTMLElement|null} footerEl the structural `.ask-popup__footer`. The
   *   row is CREATED here (the panel's own DOM is never rebuilt) and inserted
   *   before the hint, so Send stays the footer's last child. Construct this
   *   BEFORE ComposerAttachments and the two rows land in reading order: what
   *   the message acts on, then what it drags along.
   */
  constructor(footerEl) {
    if (!footerEl) return
    const row = document.createElement('div')
    row.className = 'ask-popup__target'
    const hint = footerEl.querySelector('.ask-popup__hint')
    footerEl.insertBefore(row, hint || footerEl.firstChild)
    this.#row = row
    this.#render()
  }

  /** @returns {number} how many chips are drawn */
  get size() { return this.#labels.length }

  /**
   * Draws the target of `context` — the SAME context the panel last rendered and
   * will send with, never a live re-read, so the chips describe exactly what a
   * send would act on. A context with no target (nothing open) draws nothing.
   * @param {Readonly<SelectionContext>|{target?: {label?: string}}|null} context
   */
  show(context) {
    const label = context && context.target && context.target.label
    this.#labels = label ? [String(label)] : []
    this.#render()
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  /** Redraws the row from the labels. */
  #render() {
    const row = this.#row
    if (!row) return
    row.innerHTML = ''
    row.style.display = this.#labels.length ? 'flex' : 'none'
    for (const label of this.#labels) row.appendChild(TargetChips.#chip(label))
  }

  /**
   * One chip: a target glyph and the label. No button — see the header.
   * @param {string} label
   * @returns {HTMLElement}
   */
  static #chip(label) {
    const chip = document.createElement('span')
    chip.className = 'ask-target-chip'
    chip.setAttribute('title', 'What this message will act on')
    chip.innerHTML =
      '<span class="ask-target-chip__icon" aria-hidden="true">&#9678;</span>' +
      '<span class="ask-target-chip__label">' + esc(label) + '</span>'
    return chip
  }
}
