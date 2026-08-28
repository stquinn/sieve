// @ts-check
// The surface a TriggerPopover is hosted IN, and the strategy deciding where the
// popover sits over it.
//
// The interface splits a REQUIRED CORE (anchor, accept, key/dismiss) from two
// OPTIONAL SLICES, typed below. The optional methods are deliberately NOT declared
// on the base class: their PRESENCE is the capability, so each consumer checks
// once at its own boundary and then trusts. Throwing stubs would make every host
// look typed.
//
// ProseMirrorHost lives here but touches no PM API: it is built on an
// EditorCaretPort the SURFACE implements, because surfaces/ is the only package
// permitted to see PM/DOM.

import { ContractViolation } from '../contract/sieve-block.js'
import { TriggerProvider } from './trigger-providers.js'

/**
 * The optional TYPED SLICE — a host that can be typed into, and so has a token
 * under a caret and a range to replace.
 *
 * COORDINATES ARE HOST-RELATIVE AND OPAQUE: `start`/`end` mean whatever the host
 * says they mean. Nothing outside the host interprets them, which is why the scan
 * lives here rather than the popover reading someone's text.
 *
 * @typedef {object} TypedTriggerHost
 * @property {(fn: () => void) => (() => void)} onInput
 *   the content under the caret changed. Returns its unsubscribe.
 * @property {(providers: Map<string, TriggerProvider>) => (import('./trigger-providers.js').TriggerToken|null)} tokenAtCaret
 * @property {(index: number) => string} textAfter
 *   what follows `index`. Completion reuses an existing separator rather than
 *   doubling it, and that decision needs to see one character ahead.
 * @property {(start: number, end: number, text: string) => void} replaceRange
 *   substitutes `text` for [start, end), leaving the caret after the insert.
 */

/**
 * The optional BLOCK-MAKING SLICE — a host that is a DOCUMENT, so a candidate can
 * become a block in it rather than a run of text.
 *
 * The TOKEN is passed rather than a range because deleting it is the host's job
 * and its coordinates are opaque outside the host; both halves happen inside one
 * boundary of the host's own.
 * @typedef {object} BlockMakingTriggerHost
 * @property {(kind: string, attrs: Record<string, any>, token: import('./trigger-providers.js').TriggerToken) => void} createBlock
 */

export class TriggerHost {
  /** @returns {HTMLElement} the host's element — a placement strategy's starting point */
  anchorElement() {
    throw new ContractViolation(`${this.constructor.name} must implement anchorElement()`)
  }

  /** The rect the popover anchors to. The DEFAULT is the host element's own box,
   *  as fine a measurement as an unmirrored textarea can give; a host that can
   *  locate its caret in pixels overrides it. @returns {DOMRect} */
  anchorRect() {
    return this.anchorElement().getBoundingClientRect()
  }

  /**
   * Accept `candidate` in this host. The DEFAULT hands it to the provider that
   * offered it, passing the HOST rather than any payload: the provider owns what
   * accepting MEANS, the host owns the facilities to mean it with.
   * @param {any} candidate
   * @param {import('./trigger-providers.js').TriggerToken} token
   */
  accept(candidate, token) {
    token.provider.accept(candidate, token, this)
  }

  /** Subscribe to the host's key events. The popover must see them BEFORE the
   *  surface acts on them, so PRECEDENCE is the host's problem.
   *  @param {(e: KeyboardEvent) => void} _fn @returns {() => void} unsubscribe */
  onKeyDown(_fn) {
    throw new ContractViolation(`${this.constructor.name} must implement onKeyDown(fn)`)
  }

  /** Subscribe to the host losing the user's attention. What that MEANS for an
   *  open picker is the popover's policy.
   *  @param {() => void} _fn @returns {() => void} unsubscribe */
  onDismiss(_fn) {
    throw new ContractViolation(`${this.constructor.name} must implement onDismiss(fn)`)
  }
}

/**
 * What a caret-bearing DOCUMENT has to answer for the picker to sit in it.
 * Implemented by the surface's CaretTriggerPort.
 *
 * `caretText` is deliberately ONE call returning both halves of the scan: the text
 * and the offset must come from the same PM state, and two calls could straddle a
 * transaction. Null means there is nothing here to scan.
 *
 * @typedef {object} EditorCaretPort
 * @property {() => HTMLElement} element  the editable root — where key events land
 * @property {() => ({text: string, caret: number}|null)} caretText
 * @property {() => (DOMRect|null)} caretRect  the caret in viewport pixels
 * @property {(start: number, end: number, text: string) => void} replaceRange
 *   block-local offsets, applied as ONE tracked transaction
 * @property {(start: number, end: number, kind: string, attrs: Record<string, any>) => void} createBlock
 *   delete [start, end) and create `kind` where it stood
 * @property {(fn: () => void) => (() => void)} onDocChange
 * @property {(fn: () => void) => (() => void)} onBlur
 */

const PORT_METHODS = Object.freeze([
  'element', 'caretText', 'caretRect', 'replaceRange', 'createBlock', 'onDocChange', 'onBlur',
])

export class ProseMirrorHost extends TriggerHost {
  /** @type {EditorCaretPort} */ #port

  /** @param {EditorCaretPort} port  supplied by the surface that owns the view */
  constructor(port) {
    super()
    const p = /** @type {any} */ (port)
    for (const method of PORT_METHODS) {
      if (!p || typeof p[method] !== 'function') {
        throw new ContractViolation('ProseMirrorHost requires a port with ' + method + '()')
      }
    }
    this.#port = port
  }

  /** @returns {HTMLElement} */
  anchorElement() { return this.#port.element() }

  /** THE CARET, not the editor's box: a document is tall, so hanging the picker
   *  off the surface would put it a screen away from what the user is typing.
   *  Falls back to the element's box when the caret cannot be located.
   *  @returns {DOMRect} */
  anchorRect() { return this.#port.caretRect() || super.anchorRect() }

  /**
   * CAPTURE PHASE ON THE EDITABLE ROOT. ProseMirror dispatches every keymap from
   * ONE bubble-phase `keydown` on `view.dom`, so a capture listener on that same
   * element runs first and `stopImmediatePropagation()` means PM never sees the
   * key — which is how the picker owns ↑/↓/Tab/Enter/Escape without touching the
   * policy extension.
   * @param {(e: KeyboardEvent) => void} fn @returns {() => void}
   */
  onKeyDown(fn) {
    const el = this.#port.element()
    /** @param {Event} e */
    const handler = (e) => fn(/** @type {KeyboardEvent} */ (e))
    el.addEventListener('keydown', handler, true)
    return () => el.removeEventListener('keydown', handler, true)
  }

  /** @param {() => void} fn @returns {() => void} */
  onDismiss(fn) { return this.#port.onBlur(fn) }

  /** @param {() => void} fn @returns {() => void} */
  onInput(fn) { return this.#port.onDocChange(fn) }

  /**
   * @param {Map<string, TriggerProvider>} providers
   * @returns {import('./trigger-providers.js').TriggerToken|null}
   */
  tokenAtCaret(providers) {
    const at = this.#port.caretText()
    return at ? TriggerProvider.scanToken(at.text, at.caret, providers) : null
  }

  /** @param {number} index @returns {string} */
  textAfter(index) {
    const at = this.#port.caretText()
    return at ? at.text.slice(index) : ''
  }

  /** @param {number} start @param {number} end @param {string} text */
  replaceRange(start, end, text) { this.#port.replaceRange(start, end, text) }

  /** @protected @returns {EditorCaretPort} the surface's caret port */
  get _port() { return this.#port }
}

/**
 * The ProseMirror host of a mount that can HOLD A BLOCK. The capability is the
 * class, because presence of `createBlock` is how every provider probes for it:
 * a mount that mints nothing is the plain ProseMirrorHost, and a candidate
 * offered there completes as text instead.
 */
export class BlockMakingProseMirrorHost extends ProseMirrorHost {
  /** The candidate becomes a BLOCK where its token stood — delete and create both
   *  inside the surface's own boundary.
   *  @param {string} kind @param {Record<string, any>} attrs
   *  @param {import('./trigger-providers.js').TriggerToken} token */
  createBlock(kind, attrs, token) {
    this._port.createBlock(token.start, token.end, kind, attrs)
  }
}

export class TriggerPlacement {
  /** @param {HTMLElement} _popoverEl @param {TriggerHost} _host */
  place(_popoverEl, _host) {
    throw new ContractViolation(`${this.constructor.name} must implement place(popoverEl, host)`)
  }
}

/** The popover as a visual EXTENSION of the Ask Panel: full panel width, pinned
 *  above its top edge rather than tracking the caret. */
export class PanelPlacement extends TriggerPlacement {
  /** @param {HTMLElement} popoverEl @param {TriggerHost} host */
  place(popoverEl, host) {
    const anchor = host.anchorElement()
    const panel = (anchor && anchor.closest && anchor.closest('#ask-panel')) || (anchor && anchor.parentElement)
    const rect = panel ? panel.getBoundingClientRect() : host.anchorRect()

    popoverEl.style.left = Math.max(0, rect.left) + 'px'
    popoverEl.style.width = (rect.width || window.innerWidth) + 'px'
    popoverEl.style.bottom = Math.max(0, window.innerHeight - rect.top) + 'px'
  }
}

/**
 * The popover's own `max-height`, mirrored here as a CAP rather than a
 * measurement: `show()` places the element while it is still `display: none`, so
 * `offsetHeight` reads 0 the first time. Deciding on the cap makes the side the
 * picker opens on a function of the caret position alone, so it cannot flip up and
 * down under the user as they type.
 */
const POPOVER_MAX_HEIGHT = 320

const CARET_MIN_WIDTH = 160
const CARET_GAP = 4

/**
 * Anchored to the CARET, flipping above the line when there is no room below.
 *
 * NO TRANSFORMS — left/top/bottom only. WebKitGTK repaints contentEditable
 * underneath a transformed element, and this one floats over the editor.
 */
export class CaretPlacement extends TriggerPlacement {
  /** @param {HTMLElement} popoverEl @param {TriggerHost} host */
  place(popoverEl, host) {
    const rect = host.anchorRect()
    const viewportW = window.innerWidth || 0
    const viewportH = window.innerHeight || 0

    // As wide as its longest row or as wide as the editor, whichever is SHORTER.
    // A fixed cap wrapped ordinary document titles onto four lines.
    const anchorEl = host.anchorElement()
    const columnW = anchorEl ? anchorEl.getBoundingClientRect().width : viewportW
    const maxWidth = Math.max(CARET_MIN_WIDTH, Math.min(columnW, viewportW - 16))
    popoverEl.style.width = 'max-content'
    popoverEl.style.maxWidth = maxWidth + 'px'

    // Measured, not assumed: under `max-content` the real width is only known
    // after layout, and clamping against maxWidth would shove a narrow list
    // leftwards whenever the caret sat near the right edge.
    const width = popoverEl.offsetWidth || maxWidth
    popoverEl.style.left = Math.max(8, Math.min(rect.left, viewportW - width - 8)) + 'px'

    // Flip up only if above is genuinely roomier: near the bottom of a SHORT
    // viewport neither side fits, and dropping down keeps the likely pick on
    // screen instead of clipping it off the top.
    const roomBelow = viewportH - rect.bottom - CARET_GAP
    const roomAbove = rect.top - CARET_GAP
    const above = roomBelow < POPOVER_MAX_HEIGHT && roomAbove > roomBelow

    if (above) {
      popoverEl.style.top = ''
      popoverEl.style.bottom = Math.max(0, viewportH - rect.top + CARET_GAP) + 'px'
    } else {
      popoverEl.style.bottom = ''
      popoverEl.style.top = Math.max(0, rect.bottom + CARET_GAP) + 'px'
    }

    // The popover's own styles are written for a panel rising off a composer, so a
    // list hanging DOWN needs its shadow cast the other way to read as attached.
    popoverEl.style.borderRadius = '8px'
    popoverEl.style.boxShadow = above ? '0 -8px 24px rgba(0, 0, 0, 0.45)' : '0 8px 24px rgba(0, 0, 0, 0.45)'
  }
}
