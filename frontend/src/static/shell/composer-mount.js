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
//
// A DRAFT BELONGS TO A PLACE. The host names the place the message is being
// written for (`setPlace`), and each place keeps its own draft, in memory only.
// Changing place keeps the draft left behind, its undo history excepted, and the
// place returned to presents its own again. The place named '' is the one a host
// that names none writes in.
//
// UP RECALLS WHAT WAS ASKED. The host says where the questions already asked are
// read from (`recallFrom`), and they are read at each Up or Down that needs them;
// nothing is kept of what was sent from here. In an empty draft a bare Up puts
// back the last question asked, Up again the one before; Down comes forward, and
// past the newest returns to an empty draft. A recalled question that is edited
// is the draft from then on, and Up and Down are its caret keys again.

import { InMemoryContainerProvider } from '../container/in-memory-container-provider.js'
import { ComposerEditor } from '../lens/document-editor/composer/composer-editor.js'
import { EditorMode } from '../lens/document-editor/editor-mode.js'
import { QuestionList } from '../renderers/question-list.js'
import { Ident } from '../ident/ident.js'
import { PanelPlacement } from './trigger-host.js'

/**
 * A fenced code block, written on its own: the whole of a draft block, opening
 * fence to closing fence, with the language the author tagged it with.
 */
const WHOLE_FENCE = /^```([^\s`]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```$/

/** @typedef {import('../renderers/question-list.js').QuestionElement} QuestionElement */

/**
 * What every draft's lens is built with. Each is OPTIONAL and each may be
 * absent as `null`: a host that has no such service says so, and the lens's
 * published capabilities reflect it honestly.
 * @typedef {object} ComposerDependencies
 * @property {object|null} [mentionService]  the `@` typeahead's peer
 * @property {object|null} [macroCatalog]    what the `{` picker offers
 * @property {object|null} [commandService]  the `/` picker's peer
 */

/**
 * One place's draft, and where a recall through the questions asked stands in
 * it. Whether the draft is empty, and whether a recalled one has been edited,
 * are read from the draft container, so a draft holding only an attachment is
 * not empty.
 */
class DraftPlace {
  /** @type {InMemoryContainerProvider} the message being written */ #draft = new InMemoryContainerProvider()
  /** @type {number} which question asked the draft is a recall of, oldest first; -1 while it is none */ #at = -1
  /** @type {string} the recalled draft's content as it was presented */ #shown = ''

  /** @returns {InMemoryContainerProvider} */
  get draft() { return this.#draft }

  /** Starts another draft. */
  retire() {
    this.#draft = new InMemoryContainerProvider()
    this.#at = -1
  }

  /** Records the recalled draft's content as its lens now presents it; an edit
   *  that changes it ends the recall. */
  markShown() { this.#shown = this.#content() }

  /**
   * Steps through the questions asked: -1 to an older one, 1 to a newer one, and
   * 1 past the newest back to an empty draft. Only an empty draft starts a
   * recall, and only Up starts one. A recalled draft that has been edited is the
   * draft from then on: the step is not taken, and the key is the caret's. Up on
   * the oldest is taken and stays there.
   * @param {-1|1} step
   * @param {() => ReadonlyArray<ReadonlyArray<QuestionElement>>} asked the
   *   questions asked, oldest first, read only when a step needs them
   * @returns {boolean} whether the step was taken, which is whether the key is claimed
   */
  recall(step, asked) {
    if (this.#at >= 0 && this.#content() !== this.#shown) this.#at = -1
    if (this.#at < 0) {
      if (step > 0 || ComposerMount.elementsOf(this.#draft).length) return false
      const questions = asked()
      if (questions.length === 0) return false
      this.#show(questions, questions.length - 1)
      return true
    }
    const questions = asked()
    const at = Math.min(this.#at, questions.length - 1)
    if (at < 0) this.retire()
    else if (step < 0) { if (at > 0) this.#show(questions, at - 1) }
    else if (at < questions.length - 1) this.#show(questions, at + 1)
    else this.retire()
    return true
  }

  /** @returns {string} what the draft says, its block ids aside */
  #content() {
    return JSON.stringify(ComposerMount.elementsOf(this.#draft).map((element) => {
      const { id: _id, ...attrs } = element.attrs
      return [element.kind, attrs]
    }))
  }

  /** @param {ReadonlyArray<ReadonlyArray<QuestionElement>>} questions @param {number} at */
  #show(questions, at) {
    this.#at = at
    this.#draft = new InMemoryContainerProvider({
      blocks: ComposerMount.blocksOf(questions[at]).map((block) => {
        const id = Ident.mint()
        return { id: id, kind: block.kind, attrs: Object.assign({}, block.attrs, { id: id }) }
      }),
    })
  }
}

export class ComposerMount {
  /** @type {HTMLElement|null} the fixture the lens goes in (null → headless) */ #el
  /** @type {ComposerDependencies} what every draft's lens is built with */ #deps
  /** @type {Map<string, DraftPlace>} each place's draft */ #places = new Map()
  /** @type {string} the place the message is being written for */ #place = ''
  /** @type {ComposerEditor|null} the lens presenting the place's draft */ #editor = null
  /** @type {Array<() => void>} */ #submitListeners = []
  /** @type {Array<() => void>} */ #changeListeners = []
  /** @type {Array<(candidate: any) => void>} */ #mentionListeners = []
  /** @type {Array<(title: string) => void>} */ #detachListeners = []
  /** @type {Array<() => void>} */ #clearListeners = []
  /** @type {Array<() => void>} the live lens's subscriptions, dropped on reset */ #unsubs = []
  /** @type {() => ReadonlyArray<ReadonlyArray<QuestionElement>>} the questions asked, oldest first */
  #asked = () => []

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

  /** @returns {InMemoryContainerProvider|null} the current place's draft, null
   *  while it has none */
  get provider() {
    const place = this.#places.get(this.#place)
    return place ? place.draft : null
  }

  /** @returns {string} the place the message is being written for */
  get place() { return this.#place }

  /**
   * Makes `place` the one the message is being written for. The draft of the
   * place left is kept, every pending edit in it; the lens presenting it is
   * retired, and the next `open` presents the new place's draft.
   * @param {string} place
   */
  setPlace(place) {
    const next = String(place || '')
    if (next === this.#place) return
    if (this.#editor) this.#editor.flushSave()
    this.#teardown()
    this.#place = next
  }

  /**
   * Says where Up reads the questions already asked from: `source` answers them,
   * oldest first, each as the elements it was asked with, and is called at each
   * Up or Down that needs them. Without one there is nothing to recall.
   * @param {() => ReadonlyArray<ReadonlyArray<QuestionElement>>} source
   */
  recallFrom(source) {
    this.#asked = source
  }

  /**
   * Drops `place`'s draft. When it is the current place its lens is retired
   * too, and the next `open` starts an empty draft.
   * @param {string} place
   */
  forget(place) {
    const key = String(place || '')
    if (key === this.#place) this.#teardown()
    this.#places.delete(key)
  }

  /**
   * Presents the current place's draft, bringing one into being if the place has
   * none, and returns the lens presenting it. Idempotent: opening the panel a
   * second time returns to the message that was being written, which is what
   * "close keeps the draft" means.
   * @returns {ComposerEditor|null} null when there is nowhere to mount
   */
  open() {
    if (this.#editor) return this.#editor
    if (!this.#el) return null
    // The picker is the panel's: pinned above its top edge at its full width,
    // not hung off a caret that sits at the bottom of the screen.
    const editor = new ComposerEditor(Ident.mint(), Object.assign({}, this.#deps, {
      provider: this.#placeNow().draft,
      triggerPlacement: new PanelPlacement(),
      recall: (/** @type {-1|1} */ step) => this.#recall(step),
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

  /** Tells the draft which command it currently resolves to, so its leading
   *  `/verb` token is marked. Which one that is comes of reading the draft
   *  against the host's registry, so the host is what says this.
   *  @param {string|null} verb the command name, without its slash */
  setCommandVerb(verb) {
    if (this.#editor) this.#editor.setCommandVerb(verb)
  }

  /** Puts the caret in the message: where it was, or at its end.
   *  @param {'end'} [at] */
  focus(at) {
    const pane = this.#editor && this.#editor.editorPane
    if (pane) pane.commands.focus(at)
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
    if (!editor) return []
    editor.flushSave()
    return ComposerMount.elementsOf(this.#placeNow().draft)
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
   * THE WALK'S INVERSE: a question's elements as the draft blocks they are
   * written as, in order and without ids. A code element is the prose block
   * wholly fenced that it is harvested from; a reference is the block it is, its
   * attrs as the element holds them. An element of any other kind is one a
   * draft cannot hold, and it is left out.
   * @param {ReadonlyArray<QuestionElement>} elements
   * @returns {Array<{kind: string, attrs: Record<string, any>}>}
   */
  static blocksOf(elements) {
    /** @type {Array<{kind: string, attrs: Record<string, any>}>} */
    const blocks = []
    for (const element of elements) {
      const { id: _id, ...attrs } = element.attrs || {}
      if (element.kind === 'prose') blocks.push({ kind: 'prose', attrs: { content: String(attrs.content || '') } })
      else if (element.kind === 'code') blocks.push({ kind: 'prose', attrs: { content: '```' + String(attrs.language || '') + '\n' + String(attrs.source || '') + '\n```' } })
      else if (element.kind === 'reference') blocks.push({ kind: 'reference', attrs: attrs })
    }
    return blocks
  }

  /**
   * One draft block as one question element. A prose block that is WHOLLY a
   * fenced code block becomes a code element carrying the source and the
   * language the author tagged — they know what they typed, so nothing here
   * guesses. Every other prose block is prose, and its markdown is what it is.
   * A block of any other kind — a quote put into the draft — is the element it
   * is, its attrs as the draft holds them.
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
    if (node.kind !== 'prose') return { kind: node.kind, attrs: Object.assign({}, node.attrs, { id: node.id }) }
    const content = String((node.attrs && node.attrs.content) || '').trim()
    if (!content) return null
    const fence = WHOLE_FENCE.exec(content)
    if (!fence) return { kind: 'prose', attrs: { id: node.id, content: content } }
    /** @type {Record<string, any>} */
    const attrs = { id: node.id, source: fence[2] }
    if (fence[1]) attrs.language = fence[1]
    return { kind: 'code', attrs: attrs }
  }

  /**
   * Puts `element` into the draft as a block of its own: after the block the
   * caret is in, before it when that block is an empty paragraph (so no empty
   * line is left above it and the paragraph is where writing goes on), or last
   * when the caret is in no block of the draft. The lens draws it where it lands
   * and puts the caret in the block after it. The block is named here, as every
   * block of a draft is.
   * @param {import('../renderers/question-list.js').QuestionElement} element
   */
  insert(element) {
    const editor = this.open()
    if (editor) editor.flushSave()
    const draft = this.#placeNow().draft
    const caret = editor ? editor.getSelectionContext().blockId : null
    draft.requestAddBlock(element.kind, Object.assign({}, element.attrs, { id: Ident.mint() }), this.#anchorFor(draft, caret))
    this.#notify(this.#changeListeners)
  }

  /**
   * What a block put in at the caret is anchored after.
   * @param {InMemoryContainerProvider} draft @param {string|null|undefined} caret the block the caret is in
   * @returns {string|null|undefined} a block id, null for the front, undefined to append
   */
  #anchorFor(draft, caret) {
    const order = draft.getOrder()
    const at = caret ? order.indexOf(caret) : -1
    if (at < 0) return undefined
    const block = draft.getBlock(/** @type {string} */ (caret))
    const emptyParagraph = !!block && block.kind === 'prose' && !String((block.attrs || {}).content || '').trim()
    if (!emptyParagraph) return caret
    return at === 0 ? null : order[at - 1]
  }

  /** Retires this draft and starts another: a fresh container, a fresh lens, no
   *  undo history reaching back into the message retired. */
  reset() {
    this.#teardown()
    this.#placeNow().retire()
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

  /** @returns {DraftPlace} the current place, brought into being if it was not */
  #placeNow() {
    let place = this.#places.get(this.#place)
    if (!place) {
      place = new DraftPlace()
      this.#places.set(this.#place, place)
    }
    return place
  }

  /**
   * The lens's Up or Down, put to the place: when it recalls a question, the
   * recalled draft is presented in a lens of its own.
   * @param {-1|1} step @returns {boolean} whether the key is claimed
   */
  #recall(step) {
    if (this.#editor) this.#editor.flushSave()
    const place = this.#placeNow()
    const before = place.draft
    if (!place.recall(step, this.#asked)) return false
    if (place.draft !== before) {
      this.#teardown()
      const editor = this.open()
      if (editor) editor.flushSave()
      place.markShown()
      this.focus('end')
      this.#notify(this.#changeListeners)
    }
    return true
  }

  #teardown() {
    for (const drop of this.#unsubs) drop()
    this.#unsubs = []
    if (this.#editor) this.#editor.destroy()
    this.#editor = null
  }

  /** @param {Array<() => void>} listeners */
  #notify(listeners) {
    for (const fn of listeners) {
      try { fn() } catch (e) { console.error('[composer-mount] listener threw', e) }
    }
  }
}
