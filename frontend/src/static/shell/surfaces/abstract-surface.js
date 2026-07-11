// @ts-check
// abstract-surface.js — the input-surface interface (P2.B).
//
// A Surface is one PRIVATE input surface of an editor: either the TipTap
// WYSIWYG island (WysiwygSurface) or the raw-markdown textarea
// (MarkdownSurface). The editor swaps surfaces in place via
// NoteEditor.setMode; the surface owns its own DOM subtree, its debounced
// doc-sync, and how server render-back ops (insert-block / replace-block /
// block-attrs-updated) land in its representation. The editor never reaches
// into a surface's DOM — it drives only this contract.
//
// The concrete surfaces are standalone ES modules with their collaborators
// injected via constructor DI (docs/how-to-idiomatic-js.md): the editor
// constructs its own surfaces (_createSurface owns the mode→surface repertoire),
// merging editor.js's transitional surfaceCollaborators content pipelines
// (paste/drop, save, insert-pos, reload) into the deps. State that used to be
// editor.js module vars (lastSyncedBody, docUpdateTimer, docSyncFlush,
// currentMarkdownTextarea, the noteServerBlock/reconcilePendingToken seams) is
// #private surface state.
//
// Dual-use ES module: `export` for vitest imports; `window.SieveSurface` for
// the classic-script editor.js.

/**
 * A server render-back op message (WS shape, frozen).
 * @typedef {object} ServerOp
 * @property {string} type — insert-block | replace-block | block-attrs-updated
 */

/**
 * An editor-domain event a surface REPORTS OUTWARD via its injected
 * `deps.notify` — producer-named plain data, never a consumer name (a surface
 * must not know an Ask panel or toolbar exists). The editor forwards these to
 * its registered listeners (AbstractEditor.onEvent); the seed of P3's
 * SelectionModel stream. Frozen shared values (docs/how-to-idiomatic-js.md).
 * @typedef {{type: string}} SurfaceEventMsg
 */
export const SurfaceEvent = Object.freeze({
  /** The document content changed (a user edit settled into the surface). */
  DOC_CHANGED: Object.freeze({ type: 'doc-changed' }),
  /** The selection/caret moved. */
  SELECTION_CHANGED: Object.freeze({ type: 'selection-changed' }),
  /** A ProseMirror transaction applied (selection may or may not have moved). */
  TRANSACTION: Object.freeze({ type: 'transaction' }),
  /** Focus moved within the surface (e.g. into a block's inner form control). */
  FOCUS_CHANGED: Object.freeze({ type: 'focus-changed' }),
})

export class AbstractSurface {
  /**
   * The editing mode this surface presents ('wysiwyg' | 'markdown'). Fixed per
   * concrete class — the editor's mode IS the mounted surface's mode, which is
   * what makes a torn-down-limbo mode unrepresentable.
   * @abstract
   * @returns {string}
   */
  get mode() {
    throw new Error(this.constructor.name + ' must implement get mode()')
  }

  /**
   * The live TipTap instance, or null for surfaces that have none (markdown).
   * @returns {unknown|null}
   */
  get tiptap() { return null }

  /**
   * The raw markdown body, or null for surfaces that do not hold one (wysiwyg
   * never serialises the document — Go owns markdown).
   * @returns {string|null}
   */
  get body() { return null }

  /**
   * Mounts the surface into the editor's root element and seeds it with content.
   * The root element is owned by the editor; the DOM the surface builds under it
   * is private to the surface.
   * @abstract
   * @param {HTMLElement} rootEl
   * @param {unknown}     content — surface-specific seed (markdown string, or {body, blocks})
   */
  mount(rootEl, content) {
    throw new Error(this.constructor.name + ' must implement mount()')
  }

  /**
   * Tears down the surface's DOM + timers. After unmount the surface is inert;
   * a fresh surface instance is created for the next mount.
   * @abstract
   */
  unmount() {
    throw new Error(this.constructor.name + ' must implement unmount()')
  }

  /**
   * Applies a server render-back op to this surface's representation. The
   * placement logic is mode-specific and authoritative-index-driven (backend is
   * the document source of truth; undo-history semantics are sacred — see
   * CLAUDE.md Non-Obvious Rules).
   * @abstract
   * @param {ServerOp} msg
   */
  applyServerOp(msg) {
    throw new Error(this.constructor.name + ' must implement applyServerOp()')
  }

  /**
   * Flushes any pending debounced edit immediately so Go's shadow is current
   * before a save or a mode flip. Idempotent — a no-op when nothing is pending.
   * @abstract
   */
  flushPending() {
    throw new Error(this.constructor.name + ' must implement flushPending()')
  }

  /**
   * Raw selection/focus feed — the SelectionModel hook wired in P3. Declared so
   * the contract is stable; P2.B surfaces inherit this empty stub.
   * @returns {null}
   */
  feedSelection() { return null }

  /**
   * Restores focus/selection from a SelectionContext coordinate — the symmetric
   * WRITE side of feedSelection (P3.E). The concrete surface turns the plain
   * coordinate back into a PM selection / block-inner focus / textarea focus.
   * Base surfaces have no live view; the default is a no-op focus fallback.
   * @param {import('../selection-model.js').SelectionContext} ctx
   */
  applyPosition(ctx) { /* base: nothing to focus */ }

  /**
   * Quote + truncate a snippet on a word boundary near 20 chars — the ONE
   * content-blind label helper both surfaces share (MarkdownSurface for its
   * textarea sub-range label; WysiwygSurface's block-label path). String-only:
   * no PM/block knowledge, so it belongs on the shared base.
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
