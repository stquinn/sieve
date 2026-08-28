// @ts-check
// The lens a MESSAGE is written in: one WYSIWYG surface over a draft container.
//
// Two facts are the class's own, and no host arrangement can change either.
//
// IT MINTS NO BLOCKS. A draft holds prose, native structure and pointers;
// everything a Sieve block does — classification, jobs, rendering — is a reading
// affordance, and reading happens in the record the draft is sent to.
//
// IT HAS ONE SURFACE. There is no markdown half to flip to: a draft's container
// offers no whole-content projection to flip through.
//
// IT CLAIMS MOD+ENTER, AND NOTHING ELSE. This mount is EDITOR-FIRST: Enter,
// Shift+Enter and Alt+Enter are pure native editor behaviour here exactly as in
// NoteEditor, so list continuation, a fence's own newline and an empty item's
// exit all come free. Only Mod+Enter finishes a message — the same convention a
// rich chat input (Slack, Notion AI) uses to keep Enter itself structural.
//
// It carries no toolbar — that is NoteEditor's — and it saves by the inherited
// flush alone: pending edits reach the draft container, and persisting is a
// local no-op, because a draft persists nowhere.

import { AbstractEditor } from '../abstract-editor.js'
import { EditorMode } from '../document-editor/editor-mode.js'
import { WysiwygSurface } from '../document-editor/surfaces/wysiwyg-surface.js'
import { LensCapability } from '../../contract/lens-capabilities.js'

export class ComposerEditor extends AbstractEditor {
  /** @type {Array<() => void>} who is told the message is finished */
  #submitListeners = []

  /** @type {Array<(candidate: any) => void>} who is told a `@` candidate was taken */
  #mentionListeners = []

  /** @type {Array<(title: string) => void>} who is asked to detach a document */
  #detachListeners = []

  /** @type {Array<() => void>} who is asked to retire this draft */
  #clearListeners = []

  /**
   * @protected
   * @returns {import('../document-editor/editor-mode.js').EditorModeValue}
   */
  get _defaultMode() { return EditorMode.WYSIWYG }

  /** @override — no invitation at all. The footer's chords, the Send button and
   *  the focus ring already say this is an input; ghost text inside it would be
   *  a second, redundant announcement of the same fact.
   *  @returns {string} */
  get placeholder() { return '' }

  /**
   * @protected
   * @returns {Readonly<import('../../contract/lens-capabilities.js').LensCapabilities>}
   */
  get _innateCapabilities() {
    return Object.freeze(Object.assign({}, super._innateCapabilities, {
      [LensCapability.BLOCKS]: false,
    }))
  }

  /**
   * WYSIWYG ONLY — `mode` is deliberately ignored; a draft has no other surface.
   * @protected
   * @param {import('../document-editor/editor-mode.js').EditorModeValue} mode
   * @returns {import('../document-editor/surfaces/abstract-surface.js').AbstractSurface}
   */
  _createSurface(mode) {
    return new WysiwygSurface(this)
  }

  /**
   * @override — this mount's ONE key claim: Mod+Enter sends. Bare Enter,
   * Shift+Enter and Alt+Enter all fall through to the surface unclaimed, so
   * the editor's native Enter family — list continuation, a fence's own
   * newline, an empty item's exit — behaves exactly as it does in NoteEditor.
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  claimKey(event) {
    if (event.key !== 'Enter' || !window.isMod(event)) return false
    this.#notifySubmit()
    return true
  }

  /**
   * @override — the candidate has no block to become here, so it goes to
   * whoever is keeping this draft's manifest.
   * @param {any} candidate
   */
  onMentionAccepted(candidate) {
    for (const fn of this.#mentionListeners) {
      try { fn(candidate) } catch (e) { console.error('[composer] mention listener threw', e) }
    }
  }

  /**
   * Registers a listener for "the message is finished". The lens states the
   * gesture and nothing more — what a finished message COSTS is the host's.
   * @param {() => void} fn
   * @returns {() => void} unsubscribe
   */
  onSubmit(fn) {
    this.#submitListeners.push(fn)
    return () => { this.#submitListeners = this.#submitListeners.filter((l) => l !== fn) }
  }

  /**
   * Registers a listener for an accepted `@` candidate.
   * @param {(candidate: any) => void} fn
   * @returns {() => void} unsubscribe
   */
  onMention(fn) {
    this.#mentionListeners.push(fn)
    return () => { this.#mentionListeners = this.#mentionListeners.filter((l) => l !== fn) }
  }

  /**
   * ASKS whoever keeps this draft's manifest to detach the document written as
   * `@title`. The lens states the gesture and holds no manifest to act on it —
   * the same division `onSubmit` makes for a finished message.
   * @param {string} title the name the token carries
   */
  requestDetach(title) {
    for (const fn of this.#detachListeners) {
      try { fn(title) } catch (e) { console.error('[composer] detach listener threw', e) }
    }
  }

  /** @param {(title: string) => void} fn @returns {() => void} unsubscribe */
  onDetachRequest(fn) {
    this.#detachListeners.push(fn)
    return () => { this.#detachListeners = this.#detachListeners.filter((l) => l !== fn) }
  }

  /**
   * ASKS whoever keeps this draft to retire it and start another. A draft is a
   * LIFETIME and this lens is part of the one being retired, so it cannot do
   * this itself; nothing here runs after the listeners.
   */
  requestClear() {
    for (const fn of this.#clearListeners) {
      try { fn() } catch (e) { console.error('[composer] clear listener threw', e) }
    }
  }

  /** @param {() => void} fn @returns {() => void} unsubscribe */
  onClearRequest(fn) {
    this.#clearListeners.push(fn)
    return () => { this.#clearListeners = this.#clearListeners.filter((l) => l !== fn) }
  }

  #notifySubmit() {
    for (const fn of this.#submitListeners) {
      try { fn() } catch (e) { console.error('[composer] submit listener threw', e) }
    }
  }
}
