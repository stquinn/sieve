// @ts-check
// The HOST's arrangement for ONE draft: the in-memory container it lives in, the
// composer lens presenting it, and the walk that turns what was written into the
// list of blocks a question IS.
//
// A DRAFT IS A LIFETIME, NOT A VALUE. `reset()` retires the whole arrangement —
// container, lens, undo history — and starts another, which is why sending
// cannot leave a trace of the message behind it.
//
// THE HARVEST IS A PROVIDER READ. The lens's own observer has already written
// what is typed into the draft container as blocks, so this asks the container
// rather than the editing surface: the walk sees the same content whatever was
// doing the typing, and knows nothing about ProseMirror.

import { InMemoryContainerProvider } from '../container/in-memory-container-provider.js'
import { ComposerEditor } from '../lens/composer/composer-editor.js'
import { EditorMode } from '../lens/document-editor/editor-mode.js'
import { QuestionList } from '../renderers/question-list.js'
import { Ident } from '../ident/ident.js'

/**
 * A fenced code block, written on its own: the whole of a draft block, opening
 * fence to closing fence, with the language the author tagged it with.
 */
const WHOLE_FENCE = /^```([^\s`]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```$/

/**
 * What every draft's lens is built with. Each is OPTIONAL and each may be
 * absent as `null`: a host that has no such service says so, and the lens's
 * published capabilities reflect it honestly.
 * @typedef {object} ComposerDependencies
 * @property {object|null} [mentionService]  the `@` typeahead's peer
 * @property {object|null} [macroCatalog]    what the `{` picker offers
 * @property {object|null} [commandService]  the `/` picker's peer
 */

export class ComposerMount {
  /** @type {HTMLElement|null} the fixture the lens goes in (null → headless) */ #el
  /** @type {ComposerDependencies} what every draft's lens is built with */ #deps
  /** @type {InMemoryContainerProvider|null} the live draft */ #provider = null
  /** @type {ComposerEditor|null} the lens presenting it */ #editor = null
  /** @type {Array<() => void>} */ #submitListeners = []
  /** @type {Array<() => void>} */ #changeListeners = []
  /** @type {Array<(candidate: any) => void>} */ #mentionListeners = []
  /** @type {Array<(title: string) => void>} */ #detachListeners = []
  /** @type {Array<() => void>} */ #clearListeners = []
  /** @type {Array<() => void>} the live lens's subscriptions, dropped on reset */ #unsubs = []

  /**
   * @param {HTMLElement|null} el the element the composer is mounted into
   * @param {ComposerDependencies} [deps]
   */
  constructor(el, deps = {}) {
    this.#el = el || null
    this.#deps = deps || {}
  }

  /** @returns {ComposerEditor|null} the live lens, or null before the first open */
  get editor() { return this.#editor }

  /** @returns {InMemoryContainerProvider|null} the live draft's container */
  get provider() { return this.#provider }

  /**
   * Brings a draft into being if there is not one already, and returns the lens
   * presenting it. Idempotent: opening the panel a second time returns to the
   * message that was being written, which is what "close keeps the draft" means.
   * @returns {ComposerEditor|null} null when there is nowhere to mount
   */
  open() {
    if (this.#editor) return this.#editor
    if (!this.#el) return null
    this.#provider = new InMemoryContainerProvider()
    const editor = new ComposerEditor(Ident.mint(), Object.assign({}, this.#deps, {
      provider: this.#provider,
    }))
    this.#unsubs = [
      editor.onSubmit(() => this.#notify(this.#submitListeners)),
      editor.onMention((c) => { for (const fn of this.#mentionListeners) fn(c) }),
      editor.onDetachRequest((title) => { for (const fn of this.#detachListeners) fn(title) }),
      editor.onClearRequest(() => this.#notify(this.#clearListeners)),
      editor.onEvent((e) => { if (e.type === 'doc-changed') this.#notify(this.#changeListeners) }),
    ]
    editor.presentSurface(EditorMode.WYSIWYG, this.#el, null)
    this.#editor = editor
    return editor
  }

  /** What the live lens publishes about itself — the spec the footer's hints and
   *  the context menu are both derived from.
   *  @returns {Readonly<import('../contract/lens-capabilities.js').LensCapabilities>|null}
   *    null before the first open, when there is no lens to ask */
  capabilities() { return this.#editor ? this.#editor.getCapabilities() : null }

  /** Tells the draft which documents it has attached, so every `@Title` token
   *  naming one is marked where it was written. Which tokens those are is the
   *  host's reading of the draft, so the host is what says this.
   *  @param {ReadonlyArray<string|undefined>} titles */
  setMentionTitles(titles) {
    if (this.#editor) this.#editor.setMentionTitles(titles)
  }

  /** Puts the caret in the message. */
  focus() {
    const pane = /** @type {any} */ (this.#editor && this.#editor.editorPane)
    if (pane) pane.commands.focus()
  }

  /** @returns {boolean} whether the user is typing in this composer */
  hasFocus() {
    if (!this.#el || typeof document === 'undefined') return false
    const active = document.activeElement
    return !!active && (active === this.#el || this.#el.contains(active))
  }

  /** The message as written, flat — the coordinate space `cut` works in and the
   *  text the attachment chips pair their tokens against.
   *  @returns {string} */
  read() { return this.#editor ? this.#editor.plainText() : '' }

  /** Cuts `[start, end)` out of that text. @param {number} start @param {number} end */
  cut(start, end) {
    if (this.#editor) this.#editor.deletePlainRange(start, end)
    this.#notify(this.#changeListeners)
  }

  /** @returns {boolean} whether anything has been written */
  isEmpty() { return this.read().trim() === '' }

  /**
   * THE HARVEST: the draft as the ordered list of blocks the question is made
   * of. Flushes first, so what the surface holds has reached the container, then
   * walks the container in order.
   *
   * AN AUTHORED BLOCK'S ID TRAVELS: the lens minted a UUIDv7 for it, and the
   * authority the question lands in adopts that name rather than inventing a
   * second one.
   * @returns {Array<import('../renderers/question-list.js').QuestionElement>}
   */
  harvest() {
    const editor = this.#editor
    const provider = this.#provider
    if (!editor || !provider) return []
    editor.flushSave()
    return ComposerMount.elementsOf(provider)
  }

  /**
   * THE WALK, over any container: its blocks in order, as question elements. A
   * block that says nothing contributes nothing — a blank line between two
   * paragraphs is spacing, not a block of the question.
   * @param {{getOrder: () => ReadonlyArray<string>, getBlock: (id: string) => any}} provider
   * @returns {Array<import('../renderers/question-list.js').QuestionElement>}
   */
  static elementsOf(provider) {
    /** @type {Array<import('../renderers/question-list.js').QuestionElement>} */
    const elements = []
    for (const id of provider.getOrder()) {
      const element = ComposerMount.#elementFor(provider.getBlock(id))
      if (element) elements.push(element)
    }
    return elements
  }

  /**
   * One draft block as one question element. A block that is WHOLLY a fenced
   * code block becomes a code element carrying the source and the language the
   * author tagged — they know what they typed, so nothing here guesses. Every
   * other block is prose, and its markdown is what it is.
   *
   * AN ATTACHMENT'S ID DOES NOT TRAVEL, alone among the elements: its reference
   * is minted afresh from the address and face the draft block holds, so what
   * leaves is the element a scalar ask mints, and the authority names it at the
   * door.
   * @param {{id: string, kind: string, attrs: Record<string, any>}|null} node
   * @returns {import('../renderers/question-list.js').QuestionElement|null}
   */
  static #elementFor(node) {
    if (!node) return null
    const attached = QuestionList.attachmentOf(node)
    if (attached) return QuestionList.attachment(attached.uri, attached.title)
    const content = String((node.attrs && node.attrs.content) || '').trim()
    if (!content) return null
    const fence = WHOLE_FENCE.exec(content)
    if (!fence) return { kind: 'prose', attrs: { id: node.id, content: content } }
    /** @type {Record<string, any>} */
    const attrs = { id: node.id, source: fence[2] }
    if (fence[1]) attrs.language = fence[1]
    return { kind: 'code', attrs: attrs }
  }

  /** Retires this draft and starts another: a fresh container, a fresh lens, no
   *  undo history reaching back into a message already sent. */
  reset() {
    this.#teardown()
    this.open()
  }

  /** Hands back the element and closes the draft for good. */
  destroy() { this.#teardown() }

  /** @param {() => void} fn @returns {() => void} unsubscribe */
  onSubmit(fn) {
    this.#submitListeners.push(fn)
    return () => { this.#submitListeners = this.#submitListeners.filter((l) => l !== fn) }
  }

  /** @param {() => void} fn @returns {() => void} unsubscribe */
  onChanged(fn) {
    this.#changeListeners.push(fn)
    return () => { this.#changeListeners = this.#changeListeners.filter((l) => l !== fn) }
  }

  /** @param {(candidate: any) => void} fn @returns {() => void} unsubscribe */
  onMention(fn) {
    this.#mentionListeners.push(fn)
    return () => { this.#mentionListeners = this.#mentionListeners.filter((l) => l !== fn) }
  }

  /** Registers a listener for "detach the document written as `@title`" — the
   *  lens's ask, forwarded to whoever keeps the manifest.
   *  @param {(title: string) => void} fn @returns {() => void} unsubscribe */
  onDetachRequest(fn) {
    this.#detachListeners.push(fn)
    return () => { this.#detachListeners = this.#detachListeners.filter((l) => l !== fn) }
  }

  /** Registers a listener for "retire this draft". Subscriptions survive the
   *  reset that answers it: they are held here, not on the lens being retired.
   *  @param {() => void} fn @returns {() => void} unsubscribe */
  onClearRequest(fn) {
    this.#clearListeners.push(fn)
    return () => { this.#clearListeners = this.#clearListeners.filter((l) => l !== fn) }
  }

  #teardown() {
    for (const drop of this.#unsubs) drop()
    this.#unsubs = []
    if (this.#editor) this.#editor.destroy()
    this.#editor = null
    this.#provider = null
  }

  /** @param {Array<() => void>} listeners */
  #notify(listeners) {
    for (const fn of listeners) {
      try { fn() } catch (e) { console.error('[composer-mount] listener threw', e) }
    }
  }
}
