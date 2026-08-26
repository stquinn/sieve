// @ts-check
// TargetChips: the Ask composer's view of WHAT THE MESSAGE WILL ACT ON, drawn in
// the footer beside the attachment chips.
//
// THE HEADER SHOWS THE SUBJECT, THE FOOTER SHOWS THE CONTEXT: the header names
// the command, and what it will act on stays visible down here either way.
//
// VIEW-ONLY. The editor owns the selection; this only draws it. A target chip
// therefore carries NO ✕ — the cross keeps exactly one meaning in this footer,
// which is "drop an attachment".
//
// BOTH ROWS ARE COORDINATE CHIPS, styled as one species from one set of rules
// (editor.css, `.ask-chip, .ask-target-chip`): an attachment chip holds a
// coordinate pointing at another document, this one holds the local target. The
// difference is said with the missing ✕ and an outline instead of a fill, never
// with contrast.
//
// A TARGET CHIP IS NOT AN ATTACHMENT. It is deliberately not part of
// ComposerAttachments: it never enters the manifest, never reaches the persisted
// attrs, and a send leaves it standing, because the selection it describes
// outlives the message.
//
// A CHIP PER BLOCK, FOR A SELECTION ONLY. A range selection spans blocks the
// user picked out one by one, so it earns a chip each. A DOCUMENT target does
// not, because `blockIds` is then the caret's block rather than the target's
// extent, so the per-block row is gated on `target.kind === 'selection'` and the
// other two kinds keep the single chip.
//
// THE LABELS ARE DERIVED AT RENDER TIME, NEVER CARRIED. SelectionContext stays
// ids-only — a label can change without any id changing — so the row asks the
// CONTAINER for each id every time it paints, and a container cue repaints a chip
// whose block changed while the selection stood still.
//
// The container it reads is the ACTIVE mount's, so it is re-pointed rather than
// injected once: which container the composer acts on changes with the tab.

import { esc } from '../renderers/html-escape.js'
import { getSieveIcon } from '../renderers/block-kinds.js'

/**
 * @typedef {import('../lens/document-editor/selection-model.js').SelectionContext} SelectionContext
 */

/**
 * The read seam: block id → what the container says that block is. A
 * `ContainerProvider` satisfies it as-is; a test stubs it with one function.
 *
 * The container knows a block or it does not: there is no second tier for a
 * block it has not seen.
 * @typedef {object} BlockSource
 * @property {(blockId: string) => ({kind?: string, attrs?: Record<string, any>}|null)} getBlock
 */

export class TargetChips {
  /** How many per-block chips are drawn before `+N more` takes the rest. The
   *  footer must stay ONE line — its height feeds ui/layout.js's
   *  askPanelMinHeight — so the row is capped rather than wrapped. */
  static #CAP = 4

  /** A hint is a few words, then an ellipsis: it identifies the block, it does
   *  not reproduce it. */
  static #HINT_WORDS = 5
  static #HINT_CHARS = 32

  /**
   * kind → the attrs keys carrying its identifying hint, in preference order.
   * A kind absent from here (log) — or one whose keys are all empty (a code
   * block with no language) — shows its KIND NAME alone, which is the same
   * fallback a container miss takes. One table, one rule, prose included.
   * @type {Readonly<Record<string, string[]>>}
   */
  static #HINTS = Object.freeze({
    prose: ['content'],
    code: ['language'],
    diagram: ['diagramType'],
    'ai-block': ['question'],
    reference: ['title', 'uri'],
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
   *   row is CREATED here (the panel's own DOM is never rebuilt) and inserted
   *   before Send, which stays the footer's last child. Construct this BEFORE
   *   ComposerAttachments and the two rows land in reading order: what the
   *   message acts on, then what it drags along.
   * @param {BlockSource|null} [source] the container read seam. Absent (a bare
   *   construction, a headless test) the per-block chips fall back to their
   *   kind-less label rather than disappearing.
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
   * Draws the target of `context` — the SAME context the panel last rendered and
   * will send with, never a live re-read, so the chips describe exactly what a
   * send would act on. A context with no target (nothing open) draws nothing.
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
   * Points the row at a container. Called when the active mount changes; a null
   * source (nothing open) leaves the chips on their kind-less labels rather than
   * clearing a row the selection still describes.
   * @param {BlockSource|null} source
   */
  setSource(source) {
    this.#source = source || null
    this.#render()
  }

  /**
   * The container changed. Repaints only when one of the named blocks is one the
   * row is currently drawing: a language or title change must reach its chip
   * without waiting for the caret to move, and a change anywhere else in the
   * document must not redraw a row that would come out identical.
   * @param {{blockIds?: ReadonlyArray<string>}|null} change
   */
  containerChanged(change) {
    const ids = (change && change.blockIds) || []
    for (const id of ids) {
      if (id && this.#blockIds.indexOf(id) >= 0) { this.#render(); return }
    }
  }

  // ── Labelling ──────────────────────────────────────────────────────────────

  /**
   * The label for ONE block of the selection: the identifying hint its kind
   * carries, or — when the container does not hold it — the generic block name.
   * Never empty, so a chip is never suppressed.
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
      const hint = TargetChips.#tidy(attrs[key])
      if (hint) return hint
    }
    return ''
  }

  /**
   * One short line from a payload value: markdown markers off the front (a
   * heading's `#` identifies nothing), whitespace collapsed to single spaces,
   * then cut at a word boundary with an ellipsis.
   * @param {any} value
   * @returns {string}
   */
  static #tidy(value) {
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

  // ── Render ─────────────────────────────────────────────────────────────────

  /** The target's own marker, and the generic one a kind-less block falls back to. */
  static #TARGET_GLYPH = '&#9678;'
  static #BLOCK_GLYPH = '&#9642;'

  /** Redraws the row: the target chip, then one chip per spanned block. */
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
      // vocabulary for kinds that already have one.
      const icon = (block.kind && getSieveIcon(block.kind)) || TargetChips.#BLOCK_GLYPH
      row.appendChild(TargetChips.#chip(
        block.label, TargetChips.#kindName(block.kind), icon, 'ask-target-chip--block',
      ))
    }
    const rest = this.#blockIds.slice(shown.length)
    if (rest.length) row.appendChild(this.#more(rest))
  }

  /**
   * One chip: a glyph and the label. No button — see the header. `iconHtml` is
   * either an entity or the kind registry's own SVG — internal either way, never
   * user data; the LABEL is the half that is escaped.
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
   * which. It is INERT: the footer is one line, so the rest are named in the
   * tooltip rather than revealed by a control this row has no room for. Only the
   * named few are looked up, so selecting a whole document costs a handful of
   * lookups and leaves a tooltip a person can read.
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
