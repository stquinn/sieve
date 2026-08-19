// @ts-check
// trigger-host.js — the TRIGGER HOST family: the surface a TriggerPopover is
// hosted IN, and the strategy that decides where the popover sits over it (#38).
//
// NAMED FOR ITS ROLE IN THE FAMILY (TriggerPopover / TriggerProvider /
// TriggerToken), NOT for its payload. A `TextHost` name would prejudge the
// content: the gesture is meant to be ubiquitous — every surface, view and thing
// offering the same controls is what makes "blocks all the way up" feel like one
// app rather than a set of them — and a future host may not be text at all.
//
// THE INTERFACE SPLITS REQUIRED CORE FROM AN OPTIONAL TYPED SLICE:
//
//   core          anchorElement()/anchorRect()   where the popover hangs
//                 accept(candidate, token)       do something with a candidate
//                 onKeyDown() / onDismiss()      subscribe to the host's events
//
//   typed slice   onInput()                      the content under the caret moved
//                 tokenAtCaret(providers)        the token the caret sits in
//                 textAfter(index)               what follows a position
//                 replaceRange(start, end, text) substitute over a range
//
//   block slice   createBlock(kind, attrs, token)  the candidate becomes a BLOCK
//                                                  where the token stood
//
// A host that cannot be typed into — a toolbar button, or Mod+K summoning the
// picker with no token — implements the CORE only. The typed methods are
// deliberately NOT declared on the base class: their PRESENCE is the capability,
// so the popover checks for them once at the boundary (the JS twin of Go's
// `s.Store.(interface{ SetMaxVersions(int) })`) and then trusts. Declaring
// throwing stubs would make every host look typed.
//
// ACCEPTANCE IS NOT A TEXT SUBSTITUTION. `accept` is typed against the CORE —
// "do something with this candidate" — because both providers that exist today
// replace a token with a string (`/name `, `@Title`) but the next one will not: a
// `{kind` provider deletes the token and CREATES A BLOCK. Range-replace is one
// FACILITY a typed host offers, never the definition of accepting. The host owns
// the boundary acceptance happens inside (a ProseMirror host wraps it in one
// tracked transaction); the provider owns what it MEANS.
//
// PLACEMENT IS A STRATEGY, NOT A METHOD, so a second placement can exist without
// a second popover. The variant tracks the HOST, not the trigger: in a composer
// both `/` and `@` read as a palette; in an editor both read as inline, the way
// Notion's `/` menu is caret-anchored. PanelPlacement is the composer's;
// CaretPlacement is the editor's.
//
// THE EDITOR'S HOST TALKS TO A PORT, NOT TO PROSEMIRROR (#38). ProseMirrorHost
// is defined here — it belongs to this family, and the popover must be able to
// hold it — but it touches no PM API. It is constructed with an
// EditorCaretPort the SURFACE implements, because the surface is the only thing
// permitted to see PM/DOM (CLAUDE.md: editor/surfaces/ is THE PM package).
// Nothing in shell/ imports the vendor bundle, and the port's seven methods are
// the exact list of what a caret-bearing document has to be able to answer.

import { ContractViolation } from '../block/sieve-block.js'
import { TriggerProvider } from './trigger-providers.js'

/**
 * The optional TYPED SLICE — a host that can be typed into, and so has a token
 * under a caret and a range to replace. Duck-typed: a host satisfies it by
 * having the methods, and each consumer checks once at ITS boundary — the
 * popover before it wires an input stream, a text provider before it substitutes
 * — which is also why `accept` is typed against the bare host: needing the slice
 * is the PROVIDER's trait, not a requirement on every host.
 *
 * COORDINATES ARE HOST-RELATIVE AND OPAQUE. `start`/`end` mean whatever the host
 * says they mean (a textarea's string offsets; a ProseMirror host's positions) —
 * nothing outside the host interprets them, which is why the scan lives here
 * rather than the popover reading someone's text.
 *
 * @typedef {object} TypedTriggerHost
 * @property {(fn: () => void) => (() => void)} onInput
 *   — the content under the caret changed. Returns its unsubscribe.
 * @property {(providers: Map<string, TriggerProvider>) => (import('./trigger-providers.js').TriggerToken|null)} tokenAtCaret
 * @property {(index: number) => string} textAfter
 *   — what follows `index`. Completion reuses an existing separator rather than
 *   doubling it, and that decision needs to see one character ahead.
 * @property {(start: number, end: number, text: string) => void} replaceRange
 *   — substitutes `text` for [start, end), leaving the caret after the insert.
 */

/**
 * The optional BLOCK-MAKING SLICE — a host that is a DOCUMENT, so a candidate
 * can become a block in it rather than a run of text. Duck-typed for the same
 * reason as the typed slice: its presence IS the capability, and a provider
 * that needs it asks for it by name at its own boundary.
 *
 * This is the second facility, not a second definition of accepting. The whole
 * point of typing `accept` against the bare host (above) is that a candidate
 * MEANS different things in different hosts: `@Auth Design` in a composer is a
 * token plus a chip, because a textarea has nowhere to put a block; the same
 * candidate in a document is an `attachment` block, because a document does.
 *
 * DELETING THE TOKEN IS THE HOST'S JOB, which is why the token is passed rather
 * than a range: `start`/`end` are host coordinates and opaque outside it. The
 * host performs both halves inside one boundary of its own.
 * @typedef {object} BlockMakingTriggerHost
 * @property {(kind: string, attrs: Record<string, any>, token: import('./trigger-providers.js').TriggerToken) => void} createBlock
 */

// ── The abstract host ────────────────────────────────────────────────────────

export class TriggerHost {
  /**
   * The host's element in the DOM — a placement strategy's starting point, and
   * the default source of the anchor rect. The popover itself never touches it.
   * @returns {HTMLElement}
   */
  anchorElement() {
    throw new ContractViolation(`${this.constructor.name} must implement anchorElement()`)
  }

  /**
   * The rect the popover anchors to. The DEFAULT is the host element's own box,
   * which is as fine a measurement as an unmirrored textarea can give; a host
   * that can locate its caret in pixels (a ProseMirror host, via
   * `view.coordsAtPos()`) overrides it. The popover never learns what produced
   * it — that is what keeps ProseMirror out of this file's graph.
   * @returns {DOMRect}
   */
  anchorRect() {
    return this.anchorElement().getBoundingClientRect()
  }

  /**
   * Accept `candidate` in this host. The DEFAULT hands it to the provider that
   * offered it, passing the HOST rather than any payload: the provider owns what
   * accepting means, the host owns the facilities to mean it with. A host
   * overrides when acceptance needs a boundary of its own — a ProseMirror host
   * wrapping the whole thing in one tracked transaction.
   * @param {any} candidate
   * @param {import('./trigger-providers.js').TriggerToken} token
   */
  accept(candidate, token) {
    token.provider.accept(candidate, token, this)
  }

  /**
   * Subscribe to the host's key events. The popover must see them BEFORE the
   * surface acts on them — a textarea host listens in the capture phase, an
   * editor host has to beat the interaction-policy keymaps — so precedence is
   * the host's problem, not the popover's.
   * @param {(e: KeyboardEvent) => void} _fn
   * @returns {() => void} unsubscribe
   */
  onKeyDown(_fn) {
    throw new ContractViolation(`${this.constructor.name} must implement onKeyDown(fn)`)
  }

  /**
   * Subscribe to the host losing the user's attention — blur, or whatever the
   * surface's equivalent is. What that MEANS for an open picker is the popover's
   * policy, not the host's.
   * @param {() => void} _fn
   * @returns {() => void} unsubscribe
   */
  onDismiss(_fn) {
    throw new ContractViolation(`${this.constructor.name} must implement onDismiss(fn)`)
  }
}

// ── The composer's host: a textarea ──────────────────────────────────────────

export class TextareaHost extends TriggerHost {
  /** @type {HTMLTextAreaElement} */ #textarea

  /** @param {HTMLTextAreaElement} textarea */
  constructor(textarea) {
    super()
    if (!textarea || typeof textarea.value !== 'string') {
      throw new ContractViolation('TextareaHost requires a textarea')
    }
    this.#textarea = textarea
  }

  /** @returns {HTMLElement} */
  anchorElement() { return this.#textarea }

  /**
   * CAPTURE PHASE, deliberately: the picker owns ArrowUp/Down, Tab, Enter and
   * Escape while it is open, and the composer's own keydown handler (send on
   * Enter, close on Escape) must not see them first.
   * @param {(e: KeyboardEvent) => void} fn @returns {() => void}
   */
  onKeyDown(fn) {
    /** @param {Event} e */
    const handler = (e) => fn(/** @type {KeyboardEvent} */ (e))
    this.#textarea.addEventListener('keydown', handler, true)
    return () => this.#textarea.removeEventListener('keydown', handler, true)
  }

  /** @param {() => void} fn @returns {() => void} */
  onDismiss(fn) {
    const handler = () => fn()
    this.#textarea.addEventListener('blur', handler)
    return () => this.#textarea.removeEventListener('blur', handler)
  }

  // ── The typed slice ───────────────────────────────────────────────────────

  /** @param {() => void} fn @returns {() => void} */
  onInput(fn) {
    const handler = () => fn()
    this.#textarea.addEventListener('input', handler)
    return () => this.#textarea.removeEventListener('input', handler)
  }

  /**
   * The token under the caret, scanned over the host's own text and offsets.
   * @param {Map<string, TriggerProvider>} providers
   * @returns {import('./trigger-providers.js').TriggerToken|null}
   */
  tokenAtCaret(providers) {
    return TriggerProvider.scanToken(this.#textarea.value, this.#textarea.selectionStart, providers)
  }

  /** @param {number} index @returns {string} */
  textAfter(index) { return this.#textarea.value.slice(index) }

  /**
   * Substitutes `text` for [start, end) and leaves the caret after it, focused.
   *
   * The `input` event is dispatched because the composer has OTHER listeners on
   * it — the attachment reconciler among them — and a programmatic completion is
   * a real change to the message. The popover's own echo guard is what stops it
   * reopening the picker on what it just wrote.
   * @param {number} start @param {number} end @param {string} text
   */
  replaceRange(start, end, text) {
    const value = this.#textarea.value
    this.#textarea.value = value.slice(0, start) + text + value.slice(end)
    this.#textarea.focus()
    const caret = start + text.length
    this.#textarea.setSelectionRange(caret, caret)
    this.#textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
}

// ── The editor's host: a ProseMirror document, reached through a port ────────

/**
 * What a caret-bearing DOCUMENT has to be able to answer for the picker to sit
 * in it. Implemented by `WysiwygSurface` — the only thing allowed to touch
 * PM/DOM — so this file stays PM-free and the host stays testable against a
 * plain object.
 *
 * `caretText` is deliberately ONE call returning both halves of the scan: the
 * text and the offset must come from the same PM state, and two calls could
 * straddle a transaction. It answers `null` for anything that is not a live
 * collapsed caret in a textblock — including a block whose interaction policy
 * declares `suppressTriggers`, which is how `@Override` in a code block never
 * arms the picker. THAT DECISION IS THE POLICY'S, not the host's: the port
 * reads `interactionPolicy` exactly as Tab, Enter, Home and the arrows do.
 *
 * @typedef {object} EditorCaretPort
 * @property {() => HTMLElement} element  the editable root — where key events land
 * @property {() => ({text: string, caret: number}|null)} caretText
 * @property {() => (DOMRect|null)} caretRect  the caret in viewport pixels
 * @property {(start: number, end: number, text: string) => void} replaceRange
 *   — block-local offsets, applied as ONE tracked transaction
 * @property {(start: number, end: number, kind: string, attrs: Record<string, any>) => void} createBlock
 *   — delete [start, end) and create `kind` where it stood
 * @property {(fn: () => void) => (() => void)} onDocChange
 * @property {(fn: () => void) => (() => void)} onBlur
 */

/** The port methods, named once so the constructor's guard cannot drift. */
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

  /**
   * THE CARET, not the editor's box — the whole reason this host overrides it.
   * A document is tall, so hanging the picker off the surface would put it a
   * screen away from what the user is typing. Falls back to the element's box
   * when the view cannot locate the caret (mid-transaction, detached node view),
   * which keeps the popover on screen rather than at 0,0.
   * @returns {DOMRect}
   */
  anchorRect() { return this.#port.caretRect() || super.anchorRect() }

  /**
   * CAPTURE PHASE ON THE EDITABLE ROOT, and this is the load-bearing line of the
   * whole editor host. ProseMirror installs ONE bubble-phase `keydown` listener
   * on `view.dom`, and every keymap — the core ones, the priority-50 interaction
   * policy, the pre-core editorProps Enter family — is dispatched from inside
   * it. A capture listener on that same element therefore runs FIRST, before any
   * of them, and `stopImmediatePropagation()` in the popover's handler means PM
   * never sees the key at all. That is how ↑/↓/Tab/Enter/Escape belong to the
   * picker while it is open without a single change to the policy extension.
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

  // ── The typed slice ───────────────────────────────────────────────────────

  /**
   * DOC CHANGES ONLY, which is the textarea's `input` exactly: a caret MOVE must
   * not arm the picker. Clicking into an `@` written months ago and having a
   * picker open on it is the ambush the abandonment machine exists to prevent,
   * and in a document — full of legitimate `@`s — it would fire constantly.
   * @param {() => void} fn @returns {() => void}
   */
  onInput(fn) { return this.#port.onDocChange(fn) }

  /**
   * The token under the caret, scanned over the caret's own textblock. Offsets
   * are BLOCK-LOCAL and opaque outside this host, exactly as the textarea's are
   * string offsets: the popover never interprets either.
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

  // ── The block-making slice ────────────────────────────────────────────────

  /**
   * The candidate becomes a BLOCK where its token stood: the token is deleted
   * and `kind` is created there, both inside the surface's own boundary. The
   * placement rule is the one every Sieve block already follows and is not
   * restated here — the surface hands the create to the editor's caret-derived
   * index, so an emptied line becomes the block and a line with text on it gets
   * the block on the next one.
   * @param {string} kind @param {Record<string, any>} attrs
   * @param {import('./trigger-providers.js').TriggerToken} token
   */
  createBlock(kind, attrs, token) {
    this.#port.createBlock(token.start, token.end, kind, attrs)
  }
}

// ── Placement ────────────────────────────────────────────────────────────────

export class TriggerPlacement {
  /**
   * Position `popoverEl` (already `position: fixed`) against `host`.
   * @param {HTMLElement} _popoverEl @param {TriggerHost} _host
   */
  place(_popoverEl, _host) {
    throw new ContractViolation(`${this.constructor.name} must implement place(popoverEl, host)`)
  }
}

/**
 * The composer's placement: the popover is a visual EXTENSION of the Ask Panel,
 * so it takes the panel's full width and is pinned above its top edge rather
 * than tracking the caret. Carried verbatim from TriggerPopover#position().
 */
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
 * The popover's own `max-height`, restated as the number the flip decision uses.
 * It is a CAP, not a measurement, ON PURPOSE: `show()` places the element while
 * it is still `display: none`, so `offsetHeight` reads 0 the first time and the
 * real height changes with every keystroke as the list narrows. Deciding on the
 * cap makes the side the picker opens on a function of WHERE THE CARET IS and
 * nothing else, so it cannot flip up and down under the user as they type.
 */
const POPOVER_MAX_HEIGHT = 200

/** A narrow inline list, not a palette — an editor picker sits beside a word. */
const CARET_WIDTH = 320

/** Breathing room between the caret's line and the list. */
const CARET_GAP = 4

/**
 * The editor's placement: anchored to the CARET, narrow, and flipping above the
 * line when there is no room below it. A document is tall and the caret is
 * wherever the user is typing, so a panel-anchored list would sit a screen away
 * from the word it is completing.
 *
 * NO TRANSFORMS ARE USED — left/top/bottom only. WebKitGTK repaints
 * contentEditable underneath a transformed element (project note: isolate with
 * `contain: layout paint`, never `will-change`), and this element floats over
 * the editor, so a translate-based placement would be exactly the wrong tool.
 */
export class CaretPlacement extends TriggerPlacement {
  /** @param {HTMLElement} popoverEl @param {TriggerHost} host */
  place(popoverEl, host) {
    const rect = host.anchorRect()
    const viewportW = window.innerWidth || 0
    const viewportH = window.innerHeight || 0

    const width = Math.min(CARET_WIDTH, Math.max(160, viewportW - 16))
    popoverEl.style.width = width + 'px'
    popoverEl.style.left = Math.max(8, Math.min(rect.left, viewportW - width - 8)) + 'px'

    // Below unless the caret's line genuinely cannot hold the list, and then
    // only if above is roomier — near the bottom of a SHORT viewport neither
    // side fits, and dropping down keeps the first rows (the likely pick) on
    // screen instead of clipping them off the top.
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

    // The rounded edge and the shadow's direction are part of the ANCHOR, not
    // decoration: the popover's own styles are written for a panel rising off a
    // composer, and a list hanging DOWN off a caret with its shadow cast upward
    // reads as detached. One property each, both direction-derived.
    popoverEl.style.borderRadius = '8px'
    popoverEl.style.boxShadow = above ? '0 -8px 24px rgba(0, 0, 0, 0.45)' : '0 8px 24px rgba(0, 0, 0, 0.45)'
  }
}
