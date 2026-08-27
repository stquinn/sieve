// @ts-check
// TargetChips: the Ask composer's view of WHAT THE MESSAGE WILL ACT ON, drawn in
// the footer beside the attachment chips.
//
// VIEW-ONLY: the editor owns the selection, so a target chip carries NO ✕ — the
// cross keeps one meaning in this footer, "drop an attachment".
//
// A TARGET CHIP IS NOT AN ATTACHMENT. It never enters the manifest, never
// reaches the persisted attrs, and a send leaves it standing.
//
// A CHIP PER BLOCK ONLY FOR `target.kind === 'selection'`: for a DOCUMENT target
// `blockIds` is the caret's block, not the target's extent.
//
// LABELS ARE DERIVED AT RENDER TIME, NEVER CARRIED — SelectionContext is
// ids-only, so the row asks the ACTIVE mount's container for each id as it
// paints, and is re-pointed rather than injected once.

import { esc } from '../renderers/html-escape.js'
import { getSieveIcon } from '../renderers/block-kinds.js'
import { QuestionList } from '../renderers/question-list.js'

/**
 * @typedef {import('../lens/document-editor/selection-model.js').SelectionContext} SelectionContext
 */

/**
 * The read seam: block id → what the container says that block is. A
 * `ContainerProvider` satisfies it as-is.
 * @typedef {object} BlockSource
 * @property {(blockId: string) => ({kind?: string, attrs?: Record<string, any>}|null)} getBlock
 */

export class TargetChips {
  /** How many per-block chips are drawn before `+N more` takes the rest. The
   *  footer must stay ONE line — its height feeds ui/layout.js's
   *  askPanelMinHeight — so the row is capped rather than wrapped. */
  static #CAP = 4

  /** A hint is a few words then an ellipsis; it does not reproduce the block. */
  static #HINT_WORDS = 5
  static #HINT_CHARS = 32

  /**
   * kind → the attrs keys carrying its identifying hint, in preference order. A
   * dotted key reads through a nested map (a reference's face lives under its
   * `cache` attr). A kind absent from here, or one whose keys are all empty,
   * shows its KIND NAME.
   * @type {Readonly<Record<string, string[]>>}
   */
  static #HINTS = Object.freeze({
    prose: ['content'],
    code: ['language'],
    diagram: ['diagramType'],
    'ai-block': ['question'],
    reference: ['cache.title', 'uri'],
    'smart-image': ['alt', 'src'],
    'smart-card': ['title', 'href'],
    'web-clip': ['title', 'source'],
    'command-result': ['title', 'cmd'],
  })

  /** @type {HTMLElement|null} the chip row (null → headless: every verb no-ops) */ #row = null
  /** @type {BlockSource|null} the id→block read seam (null → kind-less fallback labels) */ #source = null
  /** @type {string} the resolved target's own label ('' → nothing to draw) */ #targetLabel = ''
  /** @type {string[]} the blocks a SELECTION spans; empty for every other target kind */ #blockIds = []
  /**
   * @param {HTMLElement|null} footerEl the structural `.ask-popup__footer`. The
   *   row is inserted before Send, which stays the footer's last child.
   *   Construct this BEFORE ComposerAttachments so the two rows land in reading
   *   order: what the message acts on, then what it drags along.
   * @param {BlockSource|null} [source] the container read seam. Absent, the
   *   per-block chips fall back to their kind-less label.
   */
  constructor(footerEl, source = null) {
    this.#source = source || null
    if (!footerEl) return
    const row = document.createElement('div')
    row.className = 'ask-popup__target'
    // insertBefore(null) appends, so a footer with no Send still works.
    footerEl.insertBefore(row, footerEl.querySelector('.ask-popup__send'))
    this.#row = row
    this.#render()
  }

  /** @returns {number} how many chips are drawn */
  get size() {
    if (!this.#targetLabel) return 0
    const shown = Math.min(this.#blockIds.length, TargetChips.#CAP)
    return 1 + shown + (this.#blockIds.length > shown ? 1 : 0)
  }

  /**
   * Draws the target of `context` — the SAME context the panel will send with,
   * never a live re-read. A context with no target draws nothing.
   * @param {Readonly<SelectionContext>|{target?: {kind?: string, label?: string}, blockIds?: string[]}|null} context
   */
  show(context) {
    const target = context ? context.target : null
    this.#targetLabel = (target && target.label) ? String(target.label) : ''
    const span = (context && Array.isArray(context.blockIds)) ? context.blockIds : []
    this.#blockIds = (target && target.kind === 'selection') ? span.filter(Boolean).map(String) : []
    this.#render()
  }

  /**
   * Points the row at a container. A null source leaves the chips on their
   * kind-less labels rather than clearing a row the selection still describes.
   * @param {BlockSource|null} source
   */
  setSource(source) {
    this.#source = source || null
    this.#render()
  }

  /**
   * The container changed. Repaints only when one of the named blocks is one the
   * row is drawing, so a title change reaches its chip without a caret move.
   * @param {{blockIds?: ReadonlyArray<string>}|null} change
   */
  containerChanged(change) {
    const ids = (change && change.blockIds) || []
    for (const id of ids) {
      if (id && this.#blockIds.indexOf(id) >= 0) { this.#render(); return }
    }
  }

  /**
   * The label for ONE block of the selection: its kind's identifying hint, or the
   * generic block name. Never empty, so a chip is never suppressed.
   * @param {string} blockId
   * @returns {{kind: string, label: string}}
   */
  #labelFor(blockId) {
    const block = this.#source ? this.#source.getBlock(blockId) : null
    const kind = (block && block.kind) || ''
    const hint = block ? TargetChips.#hintFrom(kind, block.attrs || {}) : ''
    return { kind: kind, label: hint || TargetChips.#kindName(kind) }
  }

  /**
   * The hint a kind's attrs carry, or '' when they carry none.
   * @param {string} kind @param {Record<string, any>} attrs
   * @returns {string}
   */
  static #hintFrom(kind, attrs) {
    for (const key of TargetChips.#HINTS[kind] || []) {
      const hint = TargetChips.#tidy(TargetChips.#pluck(attrs, key))
      if (hint) return hint
    }
    return ''
  }

  /**
   * One value out of `attrs`, following a dotted key through nested maps.
   * @param {Record<string, any>} attrs @param {string} key
   * @returns {any}
   */
  static #pluck(attrs, key) {
    let value = /** @type {any} */ (attrs)
    for (const part of key.split('.')) {
      if (value == null || typeof value !== 'object') return undefined
      value = value[part]
    }
    return value
  }

  /**
   * One short line from a payload value: markdown markers off the front (a
   * heading's `#` identifies nothing), whitespace collapsed to single spaces,
   * then cut at a word boundary with an ellipsis.
   *
   * A value that is a LIST OF BLOCKS — an ai-block's question — reads as the
   * prose it is composed of, which is the line a person would recognise it by.
   * @param {any} value
   * @returns {string}
   */
  static #tidy(value) {
    if (Array.isArray(value)) value = QuestionList.text(value)
    if (typeof value !== 'string' && typeof value !== 'number') return ''
    const text = String(value).replace(/\s+/g, ' ').replace(/^[#>*+\-\s]+/, '').trim()
    if (!text) return ''
    let cut = text.split(' ').slice(0, TargetChips.#HINT_WORDS).join(' ')
    if (cut.length > TargetChips.#HINT_CHARS) cut = cut.slice(0, TargetChips.#HINT_CHARS).trimEnd()
    return cut === text ? text : cut + '…'
  }

  /** @param {string} kind @returns {string} the kind as a reader's noun ('' → the generic one) */
  static #kindName(kind) {
    return kind ? String(kind).replace(/-/g, ' ') : 'block'
  }

  /** The target's own marker, and the generic one a kind-less block falls back to. */
  static #TARGET_GLYPH = '&#9678;'
  static #BLOCK_GLYPH = '&#9642;'

  #render() {
    const row = this.#row
    if (!row) return
    row.innerHTML = ''
    row.style.display = this.#targetLabel ? 'flex' : 'none'
    if (!this.#targetLabel) return
    row.appendChild(TargetChips.#chip(
      this.#targetLabel, 'What this message will act on', TargetChips.#TARGET_GLYPH, '',
    ))
    const shown = this.#blockIds.slice(0, TargetChips.#CAP)
    for (const id of shown) {
      const block = this.#labelFor(id)
      // The kind registry owns the glyph — a chip must not invent a second icon
      // vocabulary.
      const icon = (block.kind && getSieveIcon(block.kind)) || TargetChips.#BLOCK_GLYPH
      row.appendChild(TargetChips.#chip(
        block.label, TargetChips.#kindName(block.kind), icon, 'ask-target-chip--block',
      ))
    }
    const rest = this.#blockIds.slice(shown.length)
    if (rest.length) row.appendChild(this.#more(rest))
  }

  /**
   * One chip: a glyph and the label, no button. `iconHtml` is internal markup
   * either way; the LABEL is the half that is escaped.
   * @param {string} label @param {string} title @param {string} iconHtml @param {string} modifier
   * @returns {HTMLElement}
   */
  static #chip(label, title, iconHtml, modifier) {
    const chip = document.createElement('span')
    chip.className = modifier ? 'ask-target-chip ' + modifier : 'ask-target-chip'
    chip.setAttribute('title', title)
    chip.innerHTML =
      '<span class="ask-target-chip__icon" aria-hidden="true">' + iconHtml + '</span>' +
      '<span class="ask-target-chip__label">' + esc(label) + '</span>'
    return chip
  }

  /**
   * The overflow chip: how many blocks did not fit, and — up to a readable few —
   * which. INERT: the footer is one line, so the rest are named in the tooltip.
   * @param {string[]} ids the blocks it stands for
   * @returns {HTMLElement}
   */
  #more(ids) {
    const named = ids.slice(0, TargetChips.#CAP).map((id) => this.#labelFor(id).label)
    const chip = document.createElement('span')
    chip.className = 'ask-target-chip ask-target-chip--more'
    chip.setAttribute('title', named.join(', ') + (ids.length > named.length ? ', …' : ''))
    chip.innerHTML = '<span class="ask-target-chip__label">+' + ids.length + ' more</span>'
    return chip
  }
}
