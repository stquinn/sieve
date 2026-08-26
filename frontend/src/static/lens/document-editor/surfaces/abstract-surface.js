// @ts-check
// A Surface is one PRIVATE input surface of an editor: the TipTap WYSIWYG island
// or the raw-markdown textarea. The editor swaps surfaces in place via setMode;
// the surface owns its own DOM subtree, its debounced doc-sync, and how a
// container change lands in its representation. The editor never reaches into a
// surface's DOM — it drives only this contract.

/**
 * A server render-back op message (WS shape, frozen).
 * @typedef {object} ServerOp
 * @property {string} type — insert-block | replace-block | block-attrs-updated
 */

/**
 * An editor-domain event a surface REPORTS OUTWARD via the host editor's
 * `onSurfaceEvent` handler — producer-named plain data, never a consumer name: a
 * surface must not know an Ask panel or toolbar exists.
 * @typedef {{type: string}} SurfaceEventMsg
 */
export const SurfaceEvent = Object.freeze({
  /** The document content changed (a user edit settled into the surface). */
  DOC_CHANGED: Object.freeze({ type: 'doc-changed' }),
  /**
   * The document content changed WITHOUT the user authoring anything: the
   * framework projected the server's own truth into the doc. It grows the
   * document, so anything measuring it must follow — but it is not an edit, and
   * treating it as one shows the dirty dot on every freshly opened note.
   */
  DOC_PROJECTED: Object.freeze({ type: 'doc-projected' }),
  /** The selection/caret moved. */
  SELECTION_CHANGED: Object.freeze({ type: 'selection-changed' }),
  /** A ProseMirror transaction applied (selection may or may not have moved). */
  TRANSACTION: Object.freeze({ type: 'transaction' }),
  /** Focus moved within the surface (e.g. into a block's inner form control). */
  FOCUS_CHANGED: Object.freeze({ type: 'focus-changed' }),
  /**
   * The surface's OWN scroller moved, debounced before it fires. Routes to the
   * SelectionModel's setScroll silently, and NOT through SELECTION_CHANGED, which
   * re-derives the whole descriptor.
   */
  SCROLL_CHANGED: Object.freeze({ type: 'scroll-changed' }),
})

export class AbstractSurface {
  /**
   * The editing mode this surface presents. Fixed per concrete class: the editor's
   * mode IS the mounted surface's mode, which is what makes a torn-down-limbo mode
   * unrepresentable.
   * @abstract
   * @returns {string}
   */
  get mode() {
    throw new Error(this.constructor.name + ' must implement get mode()')
  }

  /** @returns {unknown|null} the live TipTap instance, or null for surfaces with none */
  get editorPane() { return null }

  /** @returns {string|null} the raw markdown body, or null for surfaces that hold
   *  none — wysiwyg never serialises the document, because Go owns markdown */
  get body() { return null }

  /** The surface's current document stats, from its OWN plain-text view. The
   *  editor delegates here so ALL TipTap access stays surface-private.
   *  @returns {{ chars: number, lines: number, blockCount: number }} */
  stats() {
    const text = this.body || ''
    const lines = text === '' ? 0 : text.split('\n').length
    return { chars: text.length, lines, blockCount: lines }
  }

  // The editor's search verbs delegate here, so all TipTap and search-extension
  // access stays surface-private. A surface with no search returns false.

  /** @param {string} term @returns {{current:number,total:number}|false} */
  searchTerm(term) { return false }

  /** @returns {{current:number,total:number}|false} */
  searchNext() { return false }

  /** @returns {{current:number,total:number}|false} */
  searchPrev() { return false }

  /** @returns {false} */
  clearSearch() { return false }

  /**
   * Mounts the surface into the editor's root element and seeds it with content.
   * The root is owned by the editor; the DOM the surface builds under it is
   * private to the surface.
   * @abstract
   * @param {HTMLElement} rootEl
   * @param {unknown}     content — surface-specific seed
   */
  mount(rootEl, content) {
    throw new Error(this.constructor.name + ' must implement mount()')
  }

  /** Tears down the surface's DOM and timers. After unmount the surface is inert;
   *  a fresh instance is created for the next mount. @abstract */
  unmount() {
    throw new Error(this.constructor.name + ' must implement unmount()')
  }

  /**
   * The container changed: place what the cue names. ABSTRACT — a surface is a way
   * of showing a container, so how a change reaches the screen is what a concrete
   * surface is for.
   * @param {{blockIds: ReadonlyArray<string>, orderChanged: boolean}} change
   * @param {any} provider the mounted container's provider (reads only)
   */
  applyContainerChange(change, provider) {
    throw new Error(this.constructor.name + ' must implement applyContainerChange()')
  }

  /** Paints the WHOLE container — the bootstrap cue, and a genuine LOAD. Abstract
   *  for the same reason. @param {any} provider */
  paintContainer(provider) {
    throw new Error(this.constructor.name + ' must implement paintContainer()')
  }

  /** Pastes plain text through this surface's paste path. The base has none, so it
   *  reports that nothing was made of it and the caller falls back to a local
   *  insert. @param {string} text @returns {Promise<'block'|'content'|'none'>} */
  pasteText(text) { return Promise.resolve('none') }

  /** Flushes any pending debounced edit so Go's shadow is current before a save or
   *  a mode flip. Idempotent. @abstract */
  flushPending() {
    throw new Error(this.constructor.name + ' must implement flushPending()')
  }

  /**
   * Inserts `url` at the caret as a hyperlink, via the Go paste round-trip that
   * fetches its title. NOT abstract: a surface with no inline marks has nothing to
   * insert into and honestly reports that it did not act. In the markdown SOURCE
   * surface the document is raw text, where writing `[x](url)` is the native
   * affordance.
   * @param {string} url
   * @returns {Promise<boolean>} whether a link was inserted
   */
  insertLink(url) { return Promise.resolve(false) }

  /**
   * The surface's OWN formatting button groups for the editor toolbar. The editor
   * composes these AFTER its persistent editor-level groups and re-renders ONLY
   * this section on a mode flip. A surface with no rich commands returns [], so
   * its formatting buttons are ABSENT rather than dimmed. Each button's
   * onClick/active closure runs on the surface's OWN live view.
   * @returns {import('../toolbar-button.js').ButtonGroup[]}
   */
  toolbarContents() { return [] }

  /**
   * Raw selection/focus feed — the SelectionModel hook. Declared so the contract
   * is stable; base surfaces inherit this empty stub.
   * @returns {null}
   */
  feedSelection() { return null }

  /**
   * Restores focus/selection from a SelectionContext coordinate — the symmetric
   * WRITE side of feedSelection. The concrete surface turns the plain coordinate
   * back into a PM selection / block-inner focus / textarea focus. Base surfaces
   * have no live view, so the default is a no-op focus fallback.
   * @param {import('../selection-model.js').SelectionContext} ctx
   */
  applyPosition(ctx) { /* base: nothing to focus */ }

  /**
   * The surface's own scroller position — the SCROLL_CHANGED feed hook, mirroring
   * feedSelection. `null` when the surface has no live scroller yet; the model
   * treats null as "nothing to report".
   * @returns {number|null}
   */
  feedScroll() { return null }

  /**
   * Restores (or parks) the surface's scroller position — the symmetric WRITE side
   * of feedScroll. Called both on a fresh document load and via applyPosition, to
   * preserve scroll across a same-session reload. `null`/`undefined` means leave
   * it alone; 0 is a real, valid park-at-top value.
   * @param {number|null|undefined} value
   */
  applyScroll(value) { /* base: nothing to scroll */ }

  /**
   * Quote and truncate a snippet on a word boundary near 20 chars — the ONE
   * content-blind label helper both surfaces share. String-only: no PM or block
   * knowledge, so it belongs on the shared base.
   * @param {string} text
   * @returns {string}
   */
  quoteSnippet(text) {
    const s = (text || '').replace(/\s+/g, ' ').trim()
    if (!s) return 'Selection'
    if (s.length > 20) {
      let cut = s.slice(0, 20)
      const sp = cut.lastIndexOf(' ')
      if (sp > 8) cut = cut.slice(0, sp)
      return '"' + cut + '…"'
    }
    return '"' + s + '"'
  }
}

// Expose on window for classic-script access from editor.js.
window.SieveSurface = AbstractSurface
