// @ts-check
// insert-dialogs.js — the URL-derived insert dialogs as a Workspace child (P4.C).
//
// Holds BOTH URL dialogs — the smart-card ("Insert URL Card") and the web-clip
// ("Insert Web Clip") popups. They are near-identical: same .internalize-popup
// .ask-popup shell, same url input + error row + isValidURL gate + Enter/Escape
// wiring, same insert path (captureInsertPos(kindIsInline(kind)) → applyBlockOps
// [create-block]). They differ only in label text, footer buttons, and target
// kind — one cohesive concern ("insert a URL-derived block"), so ONE class with
// two lazily-built <dialog> elements (faithful to the old ensureOverlays laziness).
//
// The web-clip dialog's "Card" footer button routes to the SAME smart-card create
// path — they are one intertwined concern, which is why they share a class.
//
// It inserts through PUBLIC AbstractEditor methods only (kindIsInline /
// captureInsertPos / setInsertPos / commitInsertIndex / takeInsertPos /
// applyBlockOps via workspace.activeTab.editor) — NO tiptap reach, NO shared bus.
// Backs workspace.openUrlCardDialog(url?) / openWebClipDialog(url?).
//
// Dual-use ES module: imported by workspace.js (which constructs it). No window.*
// export — reached via window.sieveWorkspace.insertDialogs.

export class InsertDialogs {
  /** @type {import('./workspace.js').SieveWorkspace} */
  #ws
  /** @type {HTMLDialogElement|null} lazily created smart-card <dialog> */
  #cardDialog = null
  /** @type {HTMLDialogElement|null} lazily created web-clip <dialog> */
  #clipDialog = null

  /** @param {import('./workspace.js').SieveWorkspace} ws */
  constructor(ws) {
    // NO DOM in the constructor (vitest-safe; DOM is built lazily on first open,
    // mirroring the old ensureOverlays laziness).
    this.#ws = ws
  }

  // ── Public verbs the Workspace delegates to ─────────────────────────────────────

  /**
   * Opens the Insert URL Card dialog (was openSmartCardDialog): lazy-build,
   * prefill, showModal, focus.
   * @param {string} [prefillUrl]
   */
  openUrlCard(prefillUrl) {
    const dialog = this.#ensureCard()
    if (!dialog) return
    const urlInput = dialog.querySelector('input')
    if (urlInput) urlInput.value = prefillUrl || ''
    if (!dialog.open) dialog.showModal()
    if (urlInput) urlInput.focus()
  }

  /**
   * Opens the Insert Web Clip dialog (was openInternalizeDialog).
   * @param {string} [prefillUrl]
   */
  openWebClip(prefillUrl) {
    const dialog = this.#ensureClip()
    if (!dialog) return
    const urlInput = dialog.querySelector('input')
    if (urlInput) urlInput.value = prefillUrl || ''
    if (!dialog.open) dialog.showModal()
    if (urlInput) urlInput.focus()
  }

  // ── Private ─────────────────────────────────────────────────────────────────────

  /** @returns {any} the live active editor, or null */
  #activeEditor() {
    return (this.#ws.activeTab && this.#ws.activeTab.editor) || null
  }

  /**
   * Lazily builds the smart-card <dialog> on first open (was createSmartCardDialog).
   * @returns {HTMLDialogElement|null}
   */
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
    errorMsg.textContent = 'Please enter a valid http:// or https:// URL'
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
   * Lazily builds the web-clip <dialog> on first open (was createInternalizeDialog).
   * Three footer buttons — Fetch / Summarise / Card; Card routes to the smart-card
   * create path, Fetch/Summarise to the web-clip internalize path.
   * @returns {HTMLDialogElement|null}
   */
  #ensureClip() {
    if (this.#clipDialog) return this.#clipDialog
    if (typeof document === 'undefined') return null
    const dialog = /** @type {HTMLDialogElement} */ (document.createElement('dialog'))
    dialog.className = 'internalize-popup ask-popup'

    const header = document.createElement('div'); header.className = 'ask-popup__header'
    const label = document.createElement('span'); label.className = 'ask-popup__label'; label.textContent = 'Insert Web Clip'
    const closeBtn = this.#makeBtn('ask-popup__close', '✕', () => dialog.close())
    closeBtn.title = 'Close (Esc)'
    header.appendChild(label); header.appendChild(closeBtn)

    const urlInput = document.createElement('input')
    urlInput.type = 'url'
    urlInput.className = 'internalize-popup__input'
    urlInput.placeholder = 'https://…'

    const errorMsg = document.createElement('div')
    errorMsg.className = 'internalize-popup__error'
    errorMsg.textContent = 'Please enter a valid http:// or https:// URL'
    errorMsg.style.display = 'none'

    urlInput.addEventListener('input', () => { errorMsg.style.display = 'none' })

    /** @param {string} mode */
    const trySubmit = (mode) => {
      const url = urlInput.value.trim()
      if (!this.#isValidURL(url)) { errorMsg.style.display = ''; return }
      if (mode === 'card') {
        this.#createCard(url)
      } else {
        this.#internalize(url, mode)
      }
      dialog.close()
    }

    const footer = document.createElement('div'); footer.className = 'ask-popup__footer'
    footer.appendChild(this.#makeBtn('internalize-popup__btn', 'Fetch', () => trySubmit('fetch')))
    footer.appendChild(this.#makeBtn('internalize-popup__btn', 'Summarise', () => trySubmit('summarise')))
    footer.appendChild(this.#makeBtn('internalize-popup__btn', 'Card', () => trySubmit('card')))

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); dialog.close() }
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
   * Inserts a smart-card block at the caret (was doCreateSmartCard). Guards an
   * active editor exists + (has tiptap OR markdown mode) — the old currentUuid
   * guard collapses into "an active editor exists".
   * @param {string} href
   */
  #createCard(href) {
    const ed = this.#activeEditor()
    if (!ed) return
    if (!ed.tiptap && ed.mode !== 'markdown') return
    ed.setInsertPos(ed.captureInsertPos(ed.kindIsInline('smart-card')))
    this.#insertBlock('smart-card', { href })
  }

  /**
   * Inserts a web-clip block at the caret (was doInternalize).
   * @param {string} source
   * @param {string} mode
   */
  #internalize(source, mode) {
    const ed = this.#activeEditor()
    if (!ed) return
    if (!ed.tiptap && ed.mode !== 'markdown') return
    ed.setInsertPos(ed.captureInsertPos(ed.kindIsInline('web-clip')))
    this.#insertBlock('web-clip', { source, mode })
  }

  /**
   * The ONE create path for these two kinds (was sendCreateBlock, scoped here): a
   * create-block block-op carrying kind, attrs, and the document index from the
   * editor's captured insert position. All through public AbstractEditor methods.
   * @param {string} kind
   * @param {object} attrs
   */
  #insertBlock(kind, attrs) {
    const ed = this.#activeEditor()
    if (!ed) return
    ed.applyBlockOps([
      { type: 'create-block', kind, attrs: attrs || {}, index: ed.commitInsertIndex(ed.takeInsertPos()) },
    ])
  }

  /**
   * http/https URL gate (was isValidURL), shared by both dialogs.
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
