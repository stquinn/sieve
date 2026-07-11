// @ts-check
// search-overlay.js — the document search overlay as a Workspace child (P4.C).
//
// A find/next/prev/clear overlay over the live editor. It owns its own JS-created
// overlay DOM (document.body.appendChild, lazily on first toggle — faithful to
// the old ensureOverlays laziness); it is NOT wired from index.html markup. Backs
// workspace.toggleSearch().
//
// TRANSITIONAL ed.tiptap reach: the search commands (setSearchTerm / nextSearchResult
// / prevSearchResult / clearSearch) and the storage.search stats are SURFACE TipTap
// (the search extension lives in editor/extensions.js), so this reaches
// workspace.activeTab.editor.tiptap directly — a transitional reach, null-guarded,
// that retires with the window.TipTap bus in P4.E (a surface-command forward is a
// P4.D/E concern). NO window.TipTap here; ed.tiptap is not the window bus.
//
// Dual-use ES module: imported by workspace.js (which constructs it). No window.*
// export — reached via window.sieveWorkspace.searchOverlay.

export class SearchOverlay {
  /** @type {import('./workspace.js').SieveWorkspace} */
  #ws
  /** @type {HTMLElement|null} lazily created <div.editor-search-overlay> */
  #overlay = null
  /** @type {HTMLInputElement|null} */
  #input = null
  /** @type {HTMLElement|null} */
  #stats = null

  /** @param {import('./workspace.js').SieveWorkspace} ws */
  constructor(ws) {
    // NO DOM in the constructor (vitest-safe; the overlay is built lazily on the
    // first toggle, mirroring the old ensureOverlays laziness).
    this.#ws = ws
  }

  // ── Public verb the Workspace delegates to ──────────────────────────────────────

  /**
   * Shows/hides the search overlay (was toggleSearch).
   *
   * PRESERVED QUIRK (intentional, do NOT "fix"): a freshly JS-created overlay has
   * style.display === '' (empty, not 'none'), so the FIRST press falls into the
   * hide branch (sets display='none' + clearSearch) and only the SECOND press
   * shows it. #ensure() deliberately does not initialise display, preserving this.
   */
  toggle() {
    const overlay = this.#ensure()
    if (!overlay) return
    if (overlay.style.display === 'none') {
      overlay.style.display = 'flex'
      if (this.#input) { this.#input.focus(); this.#input.select() }
    } else {
      overlay.style.display = 'none'
      const tiptap = this.#tiptap()
      if (tiptap) tiptap.commands.clearSearch()
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────────

  /** @returns {any} the active editor's surface tiptap, or null (transitional reach). */
  #tiptap() {
    const ed = (this.#ws.activeTab && this.#ws.activeTab.editor) || null
    return (ed && ed.tiptap) || null
  }

  /** @returns {string} the active editor's mode, or 'wysiwyg' when none. */
  #mode() {
    const ed = (this.#ws.activeTab && this.#ws.activeTab.editor) || null
    return ed ? ed.mode : 'wysiwyg'
  }

  /**
   * Lazily builds the overlay on first toggle (was createSearchOverlay). Does NOT
   * initialise style.display — see the toggle() quirk note.
   * @returns {HTMLElement|null}
   */
  #ensure() {
    if (this.#overlay) return this.#overlay
    if (typeof document === 'undefined') return null
    const overlay = document.createElement('div')
    overlay.className = 'editor-search-overlay'

    const topRow = document.createElement('div')
    topRow.className = 'editor-search__top-row'

    const input = document.createElement('input')
    input.placeholder = 'Search...'
    input.className = 'editor-search__input'

    const stats = document.createElement('span')
    stats.className = 'editor-search__stats'
    stats.textContent = '0/0'

    topRow.appendChild(input); topRow.appendChild(stats)

    const bottomRow = document.createElement('div')
    bottomRow.className = 'editor-search__bottom-row'

    const btnPrev = this.#makeBtn('editor-search__btn', '↑', () => {
      if (this.#mode() === 'markdown') { /* TODO */ }
      else { const t = this.#tiptap(); if (t) t.commands.prevSearchResult() }
      this.#updateStats()
    })

    const btnNext = this.#makeBtn('editor-search__btn', '↓', () => {
      if (this.#mode() === 'markdown') { /* TODO */ }
      else { const t = this.#tiptap(); if (t) t.commands.nextSearchResult() }
      this.#updateStats()
    })

    const btnClose = this.#makeBtn('editor-search__close', '✕', () => {
      overlay.style.display = 'none'
      const t = this.#tiptap()
      if (t) { t.commands.clearSearch(); t.commands.focus() }
    })

    bottomRow.appendChild(btnPrev); bottomRow.appendChild(btnNext); bottomRow.appendChild(btnClose)
    overlay.appendChild(topRow); overlay.appendChild(bottomRow)

    input.addEventListener('input', () => {
      const term = input.value
      if (this.#mode() === 'markdown') {
        // Placeholder
      } else {
        const t = this.#tiptap()
        if (t) { t.commands.setSearchTerm(term); this.#updateStats() }
      }
    })

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const t = this.#tiptap()
        if (e.shiftKey) {
          if (t) t.commands.prevSearchResult()
        } else {
          if (t) t.commands.nextSearchResult()
        }
        this.#updateStats()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        overlay.style.display = 'none'
        const t = this.#tiptap()
        if (t) { t.commands.clearSearch(); t.commands.focus() }
      }
    })

    document.body.appendChild(overlay)
    this.#overlay = overlay
    this.#input = input
    this.#stats = stats
    return overlay
  }

  /** Refreshes the n/N match count from the surface search storage. */
  #updateStats() {
    if (!this.#stats) return
    if (this.#mode() === 'markdown') {
      this.#stats.textContent = '0/0'
      return
    }
    const t = this.#tiptap()
    if (!t) return
    const s = t.storage.search
    if (s && s.results) {
      this.#stats.textContent = (s.results.length > 0 ? (s.currentIndex + 1) : 0) + '/' + s.results.length
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
