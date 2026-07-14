// @ts-check
// search-overlay.js — the document search overlay as a Workspace child (P4.C).
//
// A find/next/prev/clear overlay over the live editor. It owns its own JS-created
// overlay DOM (document.body.appendChild, lazily on first toggle — faithful to
// the old ensureOverlays laziness); it is NOT wired from index.html markup. Backs
// workspace.toggleSearch().
//
// The overlay drives the ACTIVE EDITOR'S search verbs (searchTerm / searchNext /
// searchPrev / clearSearch), which return the current match stats and delegate to
// the mounted surface (D-3). It no longer reaches the editor's live TipTap handle:
// the Search
// extension + its `storage.search` match set are surface-private (WysiwygSurface's
// OWN #editor). The null-editor guard stays; markdown mode is a local stub (its
// surface's search verbs no-op).
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
      const ed = this.#activeEditor()
      if (ed) ed.clearSearch()
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────────

  /** @returns {any} the workspace's active editor, or null. */
  #activeEditor() {
    return (this.#ws.activeTab && this.#ws.activeTab.editor) || null
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
      if (this.#mode() === 'markdown') { this.#renderStats(null) }
      else { const ed = this.#activeEditor(); if (ed) this.#renderStats(ed.searchPrev()) }
    })

    const btnNext = this.#makeBtn('editor-search__btn', '↓', () => {
      if (this.#mode() === 'markdown') { this.#renderStats(null) }
      else { const ed = this.#activeEditor(); if (ed) this.#renderStats(ed.searchNext()) }
    })

    const btnClose = this.#makeBtn('editor-search__close', '✕', () => {
      overlay.style.display = 'none'
      const ed = this.#activeEditor()
      if (ed) ed.clearSearch()
    })

    bottomRow.appendChild(btnPrev); bottomRow.appendChild(btnNext); bottomRow.appendChild(btnClose)
    overlay.appendChild(topRow); overlay.appendChild(bottomRow)

    input.addEventListener('input', () => {
      const term = input.value
      if (this.#mode() === 'markdown') {
        // Placeholder
      } else {
        const ed = this.#activeEditor()
        if (ed) this.#renderStats(ed.searchTerm(term))
      }
    })

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const ed = this.#activeEditor()
        if (e.shiftKey) {
          if (ed) this.#renderStats(ed.searchPrev())
        } else {
          if (ed) this.#renderStats(ed.searchNext())
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        overlay.style.display = 'none'
        const ed = this.#activeEditor()
        if (ed) ed.clearSearch()
      }
    })

    document.body.appendChild(overlay)
    this.#overlay = overlay
    this.#input = input
    this.#stats = stats
    return overlay
  }

  /**
   * Refreshes the n/N match count from a stats object the editor's search verb
   * returned (`{current,total}`). Markdown mode has no matches → '0/0'; a falsy
   * stats (no results yet) leaves the count unchanged, as the old storage read did.
   * @param {{current:number,total:number}|null|false} stats
   */
  #renderStats(stats) {
    if (!this.#stats) return
    if (this.#mode() === 'markdown') {
      this.#stats.textContent = '0/0'
      return
    }
    if (stats && typeof stats.total === 'number') {
      this.#stats.textContent = stats.current + '/' + stats.total
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
