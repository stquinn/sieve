// @ts-check
// insert-dialogs.js — the URL-derived insert dialogs as a Workspace child.
// Holds BOTH URL dialogs — the smart-card one ("Insert Link Card") and the
// four-rung ladder ("Insert from URL") — as two lazily-built <dialog> elements,
// because the ladder's "Card" rung routes to the SAME smart-card create path.
//
// TWO insert paths, because there are genuinely two kinds of outcome:
//   • Card / Summarise / Fetch MAKE BLOCKS → AbstractEditor.createBlock(kind, attrs)
//     via workspace.activeTab.editor, which derives the caret block index itself.
//   • Link is an INLINE MARK at the caret, which has no block to create →
//     AbstractEditor.insertLink(url), the Go paste round-trip that fetches the title.

// Dialog copy that more than one rung needs.
const MSG = Object.freeze({
  invalidURL: 'Please enter a valid http:// or https:// URL',
  linkNeedsRichText: 'A link needs the rich-text editor — in markdown mode, type [text](url).',
})

export class InsertDialogs {
  /** @type {import('./workspace.js').SieveWorkspace} */
  #ws
  /** @type {HTMLDialogElement|null} lazily created smart-card <dialog> */
  #cardDialog = null
  /** @type {HTMLDialogElement|null} lazily created web-clip <dialog> */
  #clipDialog = null

  /** @param {import('./workspace.js').SieveWorkspace} ws */
  constructor(ws) {
    // NO DOM in the constructor (vitest-safe): built lazily on first open.
    this.#ws = ws
  }

  /** @param {string} [prefillUrl] */
  openUrlCard(prefillUrl) {
    const dialog = this.#ensureCard()
    if (!dialog) return
    const urlInput = dialog.querySelector('input')
    if (urlInput) urlInput.value = prefillUrl || ''
    if (!dialog.open) dialog.showModal()
    if (urlInput) urlInput.focus()
  }

  /** @param {string} [prefillUrl] */
  openWebClip(prefillUrl) {
    const dialog = this.#ensureClip()
    if (!dialog) return
    const urlInput = dialog.querySelector('input')
    if (urlInput) urlInput.value = prefillUrl || ''
    if (!dialog.open) dialog.showModal()
    if (urlInput) urlInput.focus()
  }

  /** @returns {any} the live active editor, or null */
  #activeEditor() {
    return (this.#ws.activeTab && this.#ws.activeTab.editor) || null
  }

  /** @returns {HTMLDialogElement|null} */
  #ensureCard() {
    if (this.#cardDialog) return this.#cardDialog
    if (typeof document === 'undefined') return null
    const dialog = /** @type {HTMLDialogElement} */ (document.createElement('dialog'))
    dialog.className = 'internalize-popup ask-popup'

    const header = document.createElement('div'); header.className = 'ask-popup__header'
    const label = document.createElement('span'); label.className = 'ask-popup__label'; label.textContent = 'Insert Link Card'
    const closeBtn = this.#makeBtn('ask-popup__close', '✕', () => dialog.close())
    closeBtn.title = 'Close (Esc)'
    header.appendChild(label); header.appendChild(closeBtn)

    const urlInput = document.createElement('input')
    urlInput.type = 'url'
    urlInput.className = 'internalize-popup__input'
    urlInput.placeholder = 'https://…'

    const errorMsg = document.createElement('div')
    errorMsg.className = 'internalize-popup__error'
    errorMsg.textContent = MSG.invalidURL
    errorMsg.style.display = 'none'

    urlInput.addEventListener('input', () => { errorMsg.style.display = 'none' })

    const trySubmit = () => {
      const url = urlInput.value.trim()
      if (!this.#isValidURL(url)) { errorMsg.style.display = ''; return }
      this.#createCard(url)
      dialog.close()
    }

    const footer = document.createElement('div'); footer.className = 'ask-popup__footer'
    footer.appendChild(this.#makeBtn('internalize-popup__btn', 'Insert Card', trySubmit))

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); dialog.close() }
      if (e.key === 'Enter') { e.preventDefault(); trySubmit() }
    })

    dialog.appendChild(header)
    dialog.appendChild(urlInput)
    dialog.appendChild(errorMsg)
    dialog.appendChild(footer)
    document.body.appendChild(dialog)
    this.#cardDialog = dialog
    return dialog
  }

  /**
   * Lazily builds the "Insert from URL" <dialog> on first open. Card routes to
   * the smart-card create path, Summarise/Fetch to the web-clip one, and Link to
   * the editor's inline insert — the only rung that makes no block.
   * @returns {HTMLDialogElement|null}
   */
  #ensureClip() {
    if (this.#clipDialog) return this.#clipDialog
    if (typeof document === 'undefined') return null
    const dialog = /** @type {HTMLDialogElement} */ (document.createElement('dialog'))
    dialog.className = 'internalize-popup ask-popup'

    const header = document.createElement('div'); header.className = 'ask-popup__header'
    // "Insert from URL", not "Insert Web Clip": the dialog offers four outcomes and
    // only two of them are web clips.
    const label = document.createElement('span'); label.className = 'ask-popup__label'; label.textContent = 'Insert from URL'
    const closeBtn = this.#makeBtn('ask-popup__close', '✕', () => dialog.close())
    closeBtn.title = 'Close (Esc)'
    header.appendChild(label); header.appendChild(closeBtn)

    const urlInput = document.createElement('input')
    urlInput.type = 'url'
    urlInput.className = 'internalize-popup__input'
    urlInput.placeholder = 'https://…'

    const errorMsg = document.createElement('div')
    errorMsg.className = 'internalize-popup__error'
    errorMsg.textContent = MSG.invalidURL
    errorMsg.style.display = 'none'

    urlInput.addEventListener('input', () => { errorMsg.style.display = 'none' })

    /** @param {string} message */
    const fail = (message) => { errorMsg.textContent = message; errorMsg.style.display = '' }

    /** @param {string} rung — 'link' | 'card' | 'summarise' | 'fetch' */
    const trySubmit = (rung) => {
      const url = urlInput.value.trim()
      if (!this.#isValidURL(url)) { fail(MSG.invalidURL); return }
      if (rung === 'link') {
        // The one rung that needs a live rich-text surface (a mark has nowhere to go
        // in raw markdown source). Say so rather than closing on a silent no-op.
        if (!this.#insertLink(url)) { fail(MSG.linkNeedsRichText); return }
      } else if (rung === 'card') {
        this.#createCard(url)
      } else {
        this.#internalize(url, rung)
      }
      dialog.close()
    }

    // THE LADDER: ordered by how much of the page ends up in the document — a bare
    // titled link, then a card's metadata, then a summary, then the whole article.
    const footer = document.createElement('div'); footer.className = 'ask-popup__footer'
    footer.appendChild(this.#makeBtn('internalize-popup__btn', 'Link', () => trySubmit('link')))
    footer.appendChild(this.#makeBtn('internalize-popup__btn', 'Card', () => trySubmit('card')))
    footer.appendChild(this.#makeBtn('internalize-popup__btn', 'Summarise', () => trySubmit('summarise')))
    footer.appendChild(this.#makeBtn('internalize-popup__btn', 'Fetch', () => trySubmit('fetch')))

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); dialog.close() }
      // Enter stays FETCH: this dialog is reached from "Insert Web Clip…", so the
      // default rung is the one the entry point named.
      if (e.key === 'Enter') { e.preventDefault(); trySubmit('fetch') }
    })

    dialog.appendChild(header)
    dialog.appendChild(urlInput)
    dialog.appendChild(errorMsg)
    dialog.appendChild(footer)
    document.body.appendChild(dialog)
    this.#clipDialog = dialog
    return dialog
  }

  /**
   * Inserts a smart-card block at the caret. Requires an active editor with
   * either an editorPane or markdown mode.
   * @param {string} href
   */
  #createCard(href) {
    const ed = this.#activeEditor()
    if (!ed) return
    if (!ed.editorPane && ed.mode !== 'markdown') return
    ed.createBlock('smart-card', { href })
  }

  /**
   * Inserts `href` at the caret as a titled hyperlink — the ladder's first rung.
   * NOT a block create: a link is an inline mark, so it goes through the editor's
   * insertLink, which runs the SAME Go round-trip a paste of that URL takes and
   * is what fetches the title. Never build an anchor locally — that is the
   * title-less second path insertLink exists to prevent.
   *
   * Requires the rich-text surface, so it REPORTS whether it could act.
   * @param {string} href
   * @returns {boolean} whether the insert was dispatched
   */
  #insertLink(href) {
    const ed = this.#activeEditor()
    if (!ed || !ed.editorPane) return false
    ed.insertLink(href)
    return true
  }

  /**
   * Inserts a web-clip block at the caret.
   * @param {string} source
   * @param {string} mode
   */
  #internalize(source, mode) {
    const ed = this.#activeEditor()
    if (!ed) return
    if (!ed.editorPane && ed.mode !== 'markdown') return
    ed.createBlock('web-clip', { source, mode })
  }

  /**
   * http/https URL gate, shared by both dialogs.
   * @param {string} url
   * @returns {boolean}
   */
  #isValidURL(url) {
    try {
      const u = new URL(url)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch (e) {
      return false
    }
  }

  /**
   * @param {string} cls
   * @param {string} text
   * @param {(e: Event) => void} onClick
   * @returns {HTMLButtonElement}
   */
  #makeBtn(cls, text, onClick) {
    const btn = document.createElement('button')
    btn.className = cls; btn.textContent = text
    btn.addEventListener('click', onClick)
    return btn
  }
}
