// @ts-check
// The lens a chat gets: its exchanges drawn as a conversation, a question and its
// answer each a message, in the chat's order and read-only. Mounted over a
// ChatContainerProvider, it claims no key. The one capability it publishes is
// `ask`: a question put to it is asked of the chat as a new exchange, verbatim,
// and what was asked of it is its exchanges' questions, in order.
// Its selection is the chat and one exchange of it (ChatThreadSurface). Of what
// a message offers it answers Retry, which asks the chat to run an unanswered
// exchange again, and Copy, which puts what the message hands over on the
// clipboard; Quote and an open are the surface's to report.
//
// What acts on the whole chat is in the workspace toolbar, at the end of the
// strip after what came of the last of it: Name now, which asks for the chat to
// be named and summarised again, and Rename..., which turns the two into a field
// holding the chat's name, a Rename and a Cancel. Enter in the field renames the
// chat, a blank name handing naming back, and Escape leaves it as it was.

import { AbstractEditor } from '../abstract-editor.js'
import { SurfaceEvent } from '../abstract-surface.js'
import { LensCapability } from '../../contract/lens-capabilities.js'
import { ContractViolation } from '../../contract/sieve-block.js'
import { ActionStatus } from '../../renderers/action-status.js'
import { QuestionList } from '../../renderers/question-list.js'
import { ButtonGroup, ToolbarButton, ToolbarField, ToolbarLabel, ToolbarPlace } from '../../renderers/toolbar-button.js'
import { ChatThreadSurface } from './chat-thread-surface.js'

/** The one mode a chat is presented in. */
const MODES = Object.freeze([ChatThreadSurface.MODE])

const CAPABILITIES = Object.freeze({
  [LensCapability.MARKDOWN]: false,
  [LensCapability.MENTIONS]: false,
  [LensCapability.COMMANDS]: false,
  [LensCapability.BLOCKS]: false,
  [LensCapability.ASK]: true,
})

export class ChatLens extends AbstractEditor {
  /** What the toolbar's naming says: asking, asked, renamed, or that it could not. */
  static NamingWords = Object.freeze({
    ASKING: 'Asking for a new name and summary…',
    ASKED: 'A new name and summary were asked for',
    FAILED: 'Could not ask for a new name and summary',
    RENAMED: 'Renamed',
    RENAME_FAILED: 'Could not rename the chat',
  })

  /** @type {ActionStatus} */ #status = new ActionStatus(() => this.onSurfaceEvent(SurfaceEvent.TOOLBAR_CHANGED))
  /** @type {Promise<void>|null} the Name now under way */ #naming = null
  /** @type {ToolbarField|null} the name being typed; null while the chat is not being renamed */ #field = null
  /** @type {{leaf: string, seek: string|undefined, at: number}|null} the exchange last asked
   *  into view, the text sought in it, and when: the thread presented next opens at it too,
   *  while the asking is recent */ #revealing = null

  /** How long, in ms, an exchange asked into view is still owed to the thread presented next. */
  static REVEAL_OWED_MS = 3000

  /**
   * @param {string} uuid the chat
   * @param {import('../abstract-editor.js').AbstractEditorOptions} [options]
   *   `provider` must be a ChatContainerProvider
   */
  constructor(uuid, options = {}) {
    super(uuid, options)
    if (typeof this.provider.getExchanges !== 'function' || typeof this.provider.requestRetry !== 'function' ||
      typeof this.provider.nameNow !== 'function' || typeof this.provider.rename !== 'function') {
      throw new ContractViolation('ChatLens: construct with a ChatContainerProvider')
    }
  }

  /** @returns {boolean} whether the chat's name is being typed in the toolbar */
  get renaming() { return this.#field !== null }

  /**
   * At the end of the strip: what came of the last naming, then Name now and
   * Rename..., or, while the chat is being renamed, the field and its Rename and
   * Cancel.
   * @override @protected
   * @returns {import('../../renderers/toolbar-button.js').ToolbarItem[]}
   */
  _toolbarGroups() {
    const END = ToolbarPlace.END
    /** @type {import('../../renderers/toolbar-button.js').ToolbarItem[]} */
    const items = []
    if (this.#status.text) items.push(new ToolbarLabel({ id: 'tb-chat-status', className: 'tb-status', text: () => this.#status.text, live: true, place: END }))
    const field = this.#field
    if (field) {
      items.push(new ButtonGroup([
        field,
        new ToolbarButton({ id: 'tb-chat-rename-save', text: 'Rename', title: 'Give the chat this name; empty hands naming back to the AI', onClick: () => { this.rename(field.value) } }),
        new ToolbarButton({ id: 'tb-chat-rename-cancel', text: 'Cancel', title: 'Leave the name as it is', onClick: () => this.cancelRename() }),
      ], { place: END, label: 'Rename the chat' }))
      return items
    }
    items.push(new ButtonGroup([
      new ToolbarButton({ id: 'tb-chat-name-now', text: 'Name now', title: 'Ask for the chat to be named and summarised again from its answers', enabled: () => this.#naming === null, onClick: () => { this.nameNow() } }),
      new ToolbarButton({ id: 'tb-chat-rename', text: 'Rename…', title: 'Give the chat a name of your own', onClick: () => this.startRename() }),
    ], { place: END, label: 'This chat' }))
    return items
  }

  /**
   * Asks for the chat to be named and summarised again, saying in the toolbar
   * that it is asking and then what came of it. A second ask while one is under
   * way is the same ask.
   * @returns {Promise<void>}
   */
  nameNow() {
    if (this.#naming) return this.#naming
    const W = ChatLens.NamingWords
    const status = this.#status
    this.#naming = new Promise((resolve) => { resolve(this.provider.nameNow()) })
      .then(() => status.showResult(W.ASKED), (err) => status.showResult(this.#said(err) || W.FAILED))
      .finally(() => {
        this.#naming = null
        this.onSurfaceEvent(SurfaceEvent.TOOLBAR_CHANGED)
      })
    status.showPending(W.ASKING)
    return this.#naming
  }

  /** Puts the field holding the chat's name in the toolbar in place of Name now and Rename... */
  startRename() {
    if (this.#field) return
    this.#field = new ToolbarField({
      id: 'tb-chat-rename-field',
      label: 'The chat\'s name',
      placeholder: 'Empty: its first question\'s words, until the AI names it',
      value: this.provider.getName(),
      onCommit: (value) => { this.rename(value) },
      onCancel: () => this.cancelRename(),
    })
    this.onSurfaceEvent(SurfaceEvent.TOOLBAR_CHANGED)
  }

  /** Takes the field away, the name left as it was. */
  cancelRename() {
    if (!this.#field) return
    this.#field = null
    this.onSurfaceEvent(SurfaceEvent.TOOLBAR_CHANGED)
  }

  /**
   * Gives the chat `name` by hand, a blank one handing naming back, and takes the
   * field away, saying in the toolbar what came of it.
   * @param {string} name
   * @returns {Promise<void>}
   */
  rename(name) {
    const W = ChatLens.NamingWords
    const status = this.#status
    this.#field = null
    this.onSurfaceEvent(SurfaceEvent.TOOLBAR_CHANGED)
    return new Promise((resolve) => { resolve(this.provider.rename(name)) })
      .then(() => status.showResult(W.RENAMED), (err) => status.showResult(this.#said(err) || W.RENAME_FAILED))
  }

  /** @param {unknown} err @returns {string} what a refusal says, '' when it says nothing */
  #said(err) {
    console.warn('[chat] the chat could not be named', err)
    return typeof err === 'string' ? err : err instanceof Error ? err.message : ''
  }

  /** @override */
  destroy() {
    this.#status.clear()
    this.#field = null
    super.destroy()
  }

  /** @protected @returns {Readonly<import('../../contract/lens-capabilities.js').LensCapabilities>} */
  get _innateCapabilities() { return /** @type {any} */ (CAPABILITIES) }

  /** @protected @returns {ReadonlyArray<string>} */
  get _modes() { return MODES }

  /** @protected @returns {string} */
  get _defaultMode() { return ChatThreadSurface.MODE }

  /** @protected @returns {string} */
  get _blockMode() { return ChatThreadSurface.MODE }

  /** @returns {string} */
  get placeholder() { return '' }

  /**
   * @protected
   * @param {string} _mode
   * @returns {ChatThreadSurface}
   */
  _createSurface(_mode) {
    const surface = new ChatThreadSurface(this)
    const owed = this.#revealing
    this.#revealing = null
    if (owed && Date.now() - owed.at <= ChatLens.REVEAL_OWED_MS) surface.reveal(owed.leaf, owed.seek)
    return surface
  }

  /**
   * @override — brings the exchange `leaf` into view in the thread showing, and in
   * the thread presented next when that follows at once: the host asks at the
   * activation an open causes, which is followed by the lens being presented
   * again in a new mount. `seek` chooses which message of the exchange is
   * brought into view and marked (ChatThreadSurface.reveal).
   * @param {string} leaf an exchange id
   * @param {string} [seek] the text looked for in the exchange
   */
  reveal(leaf, seek) {
    if (typeof leaf !== 'string' || !leaf) return
    this.#revealing = { leaf: leaf, seek: seek, at: Date.now() }
    const surface = this.surface
    if (surface instanceof ChatThreadSurface) surface.reveal(leaf, seek)
  }

  /**
   * Asks `question` of the chat as a new exchange, verbatim. Only an ask is
   * answered: a chat explains nothing. What the question quotes it carries as its own blocks. The
   * exchange is placed by the chat, after its last.
   * @param {{type: 'ask'|'explain', question?: string|ReadonlyArray<import('../../contract/chat-container-provider.js').ChatQuestionBlock>,
   *   context?: {blockId?: string|null, selectedText?: string|null}|null}} job
   *   `question` is the list of blocks a composer harvested; a question given
   *   as a string, or as an empty list, asks nothing. `context` is the
   *   selection context the asker showed, which the ask does not read
   * @returns {Promise<void>}
   */
  askAi({ type, question }) {
    if (type !== 'ask' || !Array.isArray(question) || question.length === 0) return Promise.resolve()
    this.provider.requestAsk(question)
    return Promise.resolve()
  }

  /**
   * The questions asked of the chat, oldest first: each exchange's `question` as
   * it was asked, an exchange whose question gives no element left out.
   * @returns {ReadonlyArray<ReadonlyArray<Readonly<import('../../renderers/question-list.js').QuestionElement>>>}
   */
  questionsAsked() {
    return Object.freeze(this.provider.getExchanges()
      .map((/** @type {any} */ exchange) => QuestionList.written(exchange && exchange.attrs && exchange.attrs.question))
      .filter((question) => question.length > 0))
  }

  /**
   * Asks the chat to run this exchange's job again. The chat declines, silently,
   * an exchange that has an answer or is being answered.
   * @param {string} exchangeId
   */
  retry(exchangeId) { this.provider.requestRetry(exchangeId) }

  /**
   * Puts `text` on the clipboard. Called from a control's click, which is the
   * user gesture the clipboard requires.
   * @param {string} text
   * @returns {Promise<void>} settles once the clipboard took it or refused
   */
  copy(text) {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
    if (!clipboard || typeof clipboard.writeText !== 'function') return Promise.resolve()
    return clipboard.writeText(text).catch((err) => { console.warn('[chat] the clipboard did not take the copy', err) })
  }
}
