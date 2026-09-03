// @ts-check
// find-dialog.js — FindDialog: the find-and-replace bar, as a Workspace child.
// It owns its own JS-created overlay DOM, built lazily on first open and hung in
// the editor pane it searches.
//
// THE SEARCH RUNS IN GO. This sends the find feature's control frame on the
// container's own channel and nothing else: the matching, the case folding and
// every replacement are the server's, and what arrives back are marks the lens
// draws. Nothing here reads the document.
//
// THE TWO REPLACES ARE DIFFERENT SPECIES. Replace-one SPENDS the match the
// reader is standing on — one anchored write, answered — so it disarms until the
// answer comes back. Replace-all is not a spend at all: it rides the control
// frame as a parameter the find feature obeys against the live document, so it
// is idempotent and unanswered, and needs no ack gate. Both are offered only
// while the lens is drawing something to replace.
//
// WHERE THE READER STANDS IS THE LENS'S. The count and the current match are
// read off what the lens has drawn, because a match nothing could resolve on
// screen is not a match the reader can be sent to.

import { Feature } from '../generated/protocol.js'

/** How long typing settles before the search is sent. Long enough that a typed
 *  word is one search, short enough that the highlights feel like typing. */
const TERM_DEBOUNCE_MS = 200

export class FindDialog {
  /** @type {import('./workspace.js').SieveWorkspace} */ #ws
  /** @type {HTMLElement|null} lazily created <div.editor-find-bar> */ #bar = null
  /** @type {HTMLInputElement|null} */ #term = null
  /** @type {HTMLInputElement|null} */ #replacement = null
  /** @type {HTMLButtonElement|null} */ #caseToggle = null
  /** @type {HTMLButtonElement|null} */ #replaceButton = null
  /** @type {HTMLButtonElement|null} */ #replaceAllButton = null
  /** @type {HTMLElement|null} */ #count = null
  /** @type {boolean} */ #open = false
  /** @type {boolean} */ #caseSensitive = false
  /** @type {any} the pending debounce handle */ #pending = null
  /** @type {boolean} whether a replace-one is in flight */ #spending = false
  /** @type {(() => void)|null} the editor-event unsubscribe for the watched mount */ #unsub = null
  /** @type {any} the mount the feature is currently switched on for. It is the
   *  BINDING and not its uuid, so the switch can always be turned off where it
   *  was turned on — including after the reader has moved to another tab. */
  #armedMount = null

  /** @param {import('./workspace.js').SieveWorkspace} ws */
  constructor(ws) {
    // NO DOM in the constructor (vitest-safe): the bar is built lazily on first
    // open.
    this.#ws = ws
    ws.onActiveTabChanged(() => { this.#follow(); this.#renderCount() })
  }

  /** @returns {boolean} whether the bar is showing */
  get isOpen() { return this.#open }

  /** Opens the bar if it is closed, closes it if it is open. */
  toggle() {
    if (this.#open) this.close()
    else this.open()
  }

  /**
   * Shows the bar, focuses the term, and searches for whatever is already in it.
   * Idempotent: opening an open bar re-focuses rather than re-arming.
   */
  open() {
    const bar = this.#ensure()
    if (!bar) return
    this.#hang(bar)
    bar.style.display = 'flex'
    if (!this.#open) {
      this.#open = true
      this.#send()
    }
    this.#renderCount()
    if (this.#term) { this.#term.focus(); this.#term.select() }
  }

  /**
   * Hides the bar and switches the feature off, which is what clears every
   * highlight: the server pushes the empty mark set and the lens stops drawing.
   * Idempotent.
   */
  close() {
    if (this.#bar) this.#bar.style.display = 'none'
    if (!this.#open) return
    this.#open = false
    this.#cancelPending()
    this.#disarm()
    this.#renderCount()
    // The bar took the keyboard; closing gives it back. Without this the reader
    // presses Escape and types into nothing.
    const editor = this.#activeEditor()
    if (editor && typeof editor.focus === 'function') editor.focus()
  }

  /** Moves to the next match, opening the bar first when it is closed. */
  next() { this.#walk(1) }

  /** Moves to the previous match, opening the bar first when it is closed. */
  prev() { this.#walk(-1) }

  /**
   * Replaces the match the reader is standing on.
   *
   * ACK-GATED, NEVER RATE-LIMITED: the verb is disarmed while the write is in
   * flight and re-armed when the answer arrives, whatever the answer says. A run
   * that had moved on comes back stale, which is not an error — nothing was
   * written, and the refreshed marks re-offer whatever is really there.
   */
  replaceOne() {
    if (this.#spending) return
    this.#follow()
    const editor = this.#activeEditor()
    const mount = this.#activeMount()
    if (!editor || !mount) return
    const mark = editor.currentFindMark()
    if (!mark) return
    // The host is about to rewrite the block's text, so anything typed since the
    // last debounced sync has to reach it first — otherwise the echo places text
    // that predates the typing, and the typing is gone. Handing the text over is
    // the whole requirement; a write to disk per press of Replace is not.
    editor.flushEdits()
    // The gate drops only once the write is actually in flight. A spend that
    // refuses where it stands — a violated contract — has nothing to answer it,
    // and a gate dropped before the call would never be lifted.
    const spent = mount.replaceText(mark, this.#replacementText())
    this.#spending = true
    this.#renderCount()
    Promise.resolve(spent)
      .catch(() => {})
      .then(() => { this.#spending = false; this.#renderCount() })
  }

  /**
   * Replaces every match the document currently holds, server-side, by sending
   * the search again with the imperative attached.
   *
   * NOT ACK-GATED: it is idempotent, so a repeat finds nothing left and the worst
   * a second press can do is nothing. It is offered on the same condition
   * replace-one is — that the lens is drawing something to replace — because a
   * surface that resolves no marks is a surface where the reader can see neither
   * what would change nor that anything did.
   */
  replaceAll() {
    this.#follow()
    const mount = this.#activeMount()
    if (!mount || !this.#searchTerm() || !this.#matchCount()) return
    this.#cancelPending()
    this.#arm(mount)
    mount.setFeature(Feature.FIND, true, {
      term: this.#searchTerm(),
      caseSensitive: this.#caseSensitive,
      replacement: this.#replacementText(),
      replaceAll: true,
    })
  }

  /** @returns {string} */
  #searchTerm() { return this.#term ? this.#term.value : '' }

  /** @returns {string} */
  #replacementText() { return this.#replacement ? this.#replacement.value : '' }

  /** @returns {any} the workspace's active editor lens, or null */
  #activeEditor() { return (this.#ws.activeTab && this.#ws.activeTab.editor) || null }

  /** @returns {any} the active tab's mount binding, or null */
  #activeMount() { return (this.#ws.activeTab && this.#ws.activeTab.mount) || null }

  /**
   * Walks to the next or previous match. A closed bar opens instead of walking:
   * the reader asked to find, and there is nothing to walk yet.
   * @param {number} delta
   */
  #walk(delta) {
    if (!this.#open) { this.open(); return }
    this.#follow()
    const editor = this.#activeEditor()
    if (editor) editor.findStep(delta)
    this.#renderCount()
  }

  /**
   * Makes sure the bar is searching the container the reader is now looking at.
   *
   * It runs on ACTIVATION — the host announces the new tab and the bar moves
   * with it, so the document on screen is the one highlighted and the count is
   * about what the reader can see. Every verb asks again before acting, because
   * a verb is what makes acting on the wrong container irreversible.
   */
  #follow() {
    if (!this.#open) return
    const mount = this.#activeMount()
    if (!mount || mount === this.#armedMount) return
    this.#send()
  }

  /**
   * Schedules the search after the typing settles. Every parameters change goes
   * through here, so a term and a case flip are one debounce apart rather than
   * two frames.
   */
  #schedule() {
    this.#cancelPending()
    this.#pending = setTimeout(() => { this.#pending = null; this.#send() }, TERM_DEBOUNCE_MS)
  }

  #cancelPending() {
    if (this.#pending) { clearTimeout(this.#pending); this.#pending = null }
  }

  /**
   * Sends the current search on the active container's channel. An empty term
   * still goes as an ENABLED search: the feature finds nothing and pushes the
   * clears, which is how erasing the box removes what it highlighted.
   */
  #send() {
    const mount = this.#activeMount()
    if (!mount) return
    this.#arm(mount)
    mount.setFeature(Feature.FIND, true, { term: this.#searchTerm(), caseSensitive: this.#caseSensitive })
  }

  /**
   * Makes mount the one this bar is searching, switching the feature off on
   * whichever container it was searching before. A reader who moves to another
   * tab with the bar open is asking to search THAT document, and leaving the
   * previous one switched on would leave its highlights behind.
   * @param {any} mount
   */
  #arm(mount) {
    if (this.#armedMount === mount) return
    this.#disarm()
    this.#armedMount = mount
    this.#watchEditor()
  }

  /** Switches the feature off where it was switched on, and stops following it. */
  #disarm() {
    if (this.#armedMount) this.#armedMount.setFeature(Feature.FIND, false, {})
    this.#armedMount = null
    if (this.#unsub) { this.#unsub(); this.#unsub = null }
  }

  /** Follows the armed mount's marks: the count is what the lens drew, and it
   *  only changes when a producer's findings do. */
  #watchEditor() {
    const editor = this.#activeEditor()
    if (!editor || typeof editor.onEvent !== 'function') return
    this.#unsub = editor.onEvent((/** @type {{type: string, feature?: string}} */ e) => {
      if (e && e.type === 'marks-changed' && e.feature === Feature.FIND) this.#renderCount()
    })
  }

  /** How many matches the lens is drawing right now. It is the only count there
   *  is: a match nothing resolved on screen is not one a reader can be sent to,
   *  and not one either replace offers to write.
   *  @returns {number} */
  #matchCount() {
    const editor = this.#activeEditor()
    return (this.#open && editor) ? editor.findPosition().total : 0
  }

  /** Repaints the count and the armed state of the verbs that depend on it. */
  #renderCount() {
    const editor = this.#activeEditor()
    const at = (this.#open && editor) ? editor.findPosition() : { current: 0, total: 0 }
    if (this.#count) this.#count.textContent = at.current + ' of ' + at.total
    const nothingToReplace = this.#spending || at.total === 0
    if (this.#replaceButton) this.#replaceButton.disabled = nothingToReplace
    if (this.#replaceAllButton) this.#replaceAllButton.disabled = nothingToReplace
  }

  /**
   * Hangs the bar in the pane it searches, on every open — the pane element is
   * re-rendered under it and a tab switch changes which lens is in it, and both
   * are answered by asking again rather than by watching for either.
   *
   * IT IS STILL AN OVERLAY: it is positioned against the pane and lays out over
   * it, so no editor chrome is restructured and nothing in the editor's own
   * layout moves. What being in the pane buys is that it is the EDITOR's
   * top-right rather than the window's — clear of the meta panel, and tracking
   * that panel's width without measuring anything.
   * @param {HTMLElement} bar
   */
  #hang(bar) {
    const pane = document.getElementById('editor-col') || document.body
    if (bar.parentNode !== pane) pane.appendChild(bar)
  }

  /**
   * Lazily builds the bar on first open. Built detached: `#hang` decides where
   * it lives.
   * @returns {HTMLElement|null}
   */
  #ensure() {
    if (this.#bar) return this.#bar
    if (typeof document === 'undefined') return null

    const bar = document.createElement('div')
    bar.className = 'editor-find-bar'
    bar.setAttribute('role', 'search')

    // ROW 1 IS THE TERM. What the reader types is the widest thing in the bar
    // and shares its row with nothing but the way out.
    const findRow = document.createElement('div')
    findRow.className = 'editor-find__row'
    const term = this.#input('Find', 'editor-find__input')
    findRow.append(term, this.#button('editor-find__btn', '✕', 'Close find', () => this.close()))

    // ROW 2 IS THE SEARCH ITSELF: how it matches, where it goes, and how it is
    // going. The count ends the row, under the way out, because it is the answer
    // and the rest are the asking.
    const navRow = document.createElement('div')
    navRow.className = 'editor-find__row'
    const caseToggle = this.#button('editor-find__toggle', 'Aa', 'Match case', () => this.#flipCase())
    caseToggle.setAttribute('aria-pressed', 'false')
    const count = document.createElement('span')
    count.className = 'editor-find__count'
    count.textContent = '0 of 0'
    // The count is the whole answer to "did that find anything", and a reader
    // who is not looking at it — typing, or on a screen reader — is the reader
    // who most needs it said.
    count.setAttribute('aria-live', 'polite')
    count.setAttribute('role', 'status')
    navRow.append(
      caseToggle,
      this.#button('editor-find__btn', '↑', 'Find previous', () => this.prev()),
      this.#button('editor-find__btn', '↓', 'Find next', () => this.next()),
      count,
    )

    // ROW 3 IS THE WRITE, kept apart from the reading by the one hairline in
    // the bar.
    const replaceRow = document.createElement('div')
    replaceRow.className = 'editor-find__row'
    const replacement = this.#input('Replace with', 'editor-find__input')
    const replaceButton = this.#button('editor-find__btn', 'Replace', 'Replace this match', () => this.replaceOne())
    const replaceAllButton = this.#button('editor-find__btn', 'All', 'Replace every match', () => this.replaceAll())
    replaceRow.append(replacement, replaceButton, replaceAllButton)

    bar.append(findRow, navRow, replaceRow)
    term.addEventListener('input', () => this.#schedule())
    term.addEventListener('keydown', (e) => this.#onKeyDown(e))
    replacement.addEventListener('keydown', (e) => this.#onKeyDown(e, () => this.replaceOne()))

    this.#bar = bar
    this.#term = term
    this.#replacement = replacement
    this.#caseToggle = caseToggle
    this.#replaceButton = replaceButton
    this.#replaceAllButton = replaceAllButton
    this.#count = count
    this.#renderCount()
    return bar
  }

  /** Flips case sensitivity and re-runs the search. */
  #flipCase() {
    this.#caseSensitive = !this.#caseSensitive
    if (this.#caseToggle) this.#caseToggle.setAttribute('aria-pressed', String(this.#caseSensitive))
    this.#schedule()
  }

  /**
   * The bar's own keys, handled on its own inputs and never reaching the editor:
   * Enter walks forward, Shift+Enter walks back, Escape closes.
   *
   * TAB IS LEFT ALONE. WebKitGTK delivers Shift+Tab as ISO_Left_Tab, so `key`
   * reads as neither 'Tab' nor a shifted 'Tab' — the keyCode is the only reliable
   * tell, and this checks it so a tab chord is passed on to the browser's own
   * focus order rather than half-handled here.
   * @param {KeyboardEvent} e
   * @param {(() => void)} [onEnter] what Enter does instead of walking
   */
  #onKeyDown(e, onEnter) {
    if (e.keyCode === 9) return
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
      return
    }
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (onEnter && !e.shiftKey) { onEnter(); return }
    if (e.shiftKey) this.prev()
    else this.next()
  }

  /**
   * @param {string} label accessible name — sets aria-label + placeholder
   * @param {string} cls
   * @returns {HTMLInputElement}
   */
  #input(label, cls) {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = cls
    input.placeholder = label
    input.setAttribute('aria-label', label)
    return input
  }

  /**
   * @param {string} cls
   * @param {string} text
   * @param {string} label accessible name — sets aria-label + title
   * @param {(e: Event) => void} onClick
   * @returns {HTMLButtonElement}
   */
  #button(cls, text, label, onClick) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = cls
    button.textContent = text
    button.setAttribute('aria-label', label)
    button.title = label
    button.addEventListener('click', onClick)
    return button
  }
}
