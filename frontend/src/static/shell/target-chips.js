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
// A CHIP PER BLOCK, FOR A SELECTION ONLY (#82). A range selection spans blocks
// the user picked out one by one, so it earns a chip each; a DOCUMENT target
// does not, because `blockIds` is then the caret's block, not the target's
// extent — a chip row would describe a send that acts on the whole document as
// if it acted on one paragraph. So the per-block row is gated on
// `target.kind === 'selection'` and the other two kinds keep the single chip.
//
// THE LABELS ARE DERIVED AT RENDER TIME, NEVER CARRIED. SelectionContext stays
// ids-only: a label changes without any id changing (rename a code block's
// language and nothing about the selection moves), so a snapshot carrying labels
// would either miss the change or need a second freshness rule fighting the
// meaningful-diff convention. Instead the row asks the truth-mirror for each id
// every time it paints — the mirror IS the freshness — and the mirror's own
// change signal (`blockUpdated`) repaints a chip whose block changed while the
// selection stood still. The mirror arrives by CONSTRUCTOR INJECTION; this class
// reaches for no global and opens no wire.

import { esc } from '../block/renderers/html-escape.js'
import { getSieveIcon } from '../block/block-kinds.js'

/**
 * @typedef {import('../editor/selection-model.js').SelectionContext} SelectionContext
 * @typedef {import('../block/sieve-block.js').SieveBlock} SieveBlock
 */

/**
 * The truth-mirror READ SEAM: block id → what the server last said that block
 * is. `BlockService` satisfies it as-is; a test stubs it with two functions.
 * @typedef {object} BlockMirror
 * @property {(blockId: string) => SieveBlock|null} envelopeFor  the last server-authored envelope, or null
 * @property {(blockId: string) => string} kindFor               the indexed kind, or '' for an unknown id
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
   * kind → the payload keys carrying its identifying hint, in preference order.
   * A kind absent from here (log) — or one whose keys are all empty (a code
   * block with no language) — shows its KIND NAME alone, which is the same
   * fallback a mirror miss takes. One table, one rule, prose included.
   * @type {Readonly<Record<string, string[]>>}
   */
  static #HINTS = Object.freeze({
    prose: ['content'],
    code: ['language'],
    diagram: ['diagramType'],
    'ai-block': ['question'],
    attachment: ['title', 'uri', 'src'],
    'smart-image': ['alt', 'src'],
    'smart-card': ['title', 'href'],
    'web-clip': ['title', 'source'],
    'command-result': ['title', 'cmd'],
  })

  /** @type {HTMLElement|null} the chip row (null → headless: every verb no-ops) */ #row = null
  /** @type {BlockMirror|null} the id→block read seam (null → kind-less fallback labels) */ #mirror = null
  /** @type {string} the resolved target's own label ('' → nothing to draw) */ #targetLabel = ''
  /** @type {string[]} the blocks a SELECTION spans; empty for every other target kind */ #blockIds = []

  /**
   * @param {HTMLElement|null} footerEl the structural `.ask-popup__footer`. The
   *   row is CREATED here (the panel's own DOM is never rebuilt) and inserted
   *   before Send, which stays the footer's last child. Construct this BEFORE
   *   ComposerAttachments and the two rows land in reading order: what the
   *   message acts on, then what it drags along.
   * @param {BlockMirror|null} [mirror] the truth-mirror read seam. Absent (a bare
   *   construction, a headless test) the per-block chips fall back to their
   *   kind-less label rather than disappearing.
   */
  constructor(footerEl, mirror = null) {
    this.#mirror = mirror || null
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
   * The truth-mirror advanced for `block`. Repaints only when that block is one
   * the row is currently drawing: a language or title change must reach its chip
   * without waiting for the caret to move, and a change anywhere else in the
   * document must not redraw a row that would come out identical.
   * @param {{id?: string}|null} block
   */
  blockUpdated(block) {
    const id = (block && block.id) || ''
    if (!id || this.#blockIds.indexOf(id) < 0) return
    this.#render()
  }

  // ── Labelling ──────────────────────────────────────────────────────────────

  /**
   * The label for ONE block of the selection: the identifying hint its kind
   * carries, or — when the mirror has no envelope for it yet — the kind name
   * alone. Never empty, so a chip is never suppressed.
   * @param {string} blockId
   * @returns {{kind: string, label: string}}
   */
  #labelFor(blockId) {
    // Mirror-FIRST: the envelope carries the kind AND the payload the hint comes
    // from. The routing index answers only the kind, and only for a block the
    // server has not authored an envelope for yet.
    const block = this.#mirror ? this.#mirror.envelopeFor(blockId) : null
    const kind = (block && block.kind) || (this.#mirror ? this.#mirror.kindFor(blockId) : '') || ''
    const hint = block ? TargetChips.#hintFrom(kind, block.payload || {}) : ''
    return { kind: kind, label: hint || TargetChips.#kindName(kind) }
  }

  /**
   * The hint a kind's payload carries, or '' when it carries none.
   * @param {string} kind @param {Record<string, any>} payload
   * @returns {string}
   */
  static #hintFrom(kind, payload) {
    for (const key of TargetChips.#HINTS[kind] || []) {
      const hint = TargetChips.#tidy(payload[key])
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
