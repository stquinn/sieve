// @ts-check
// NoteEditor's whole definition: the lens that DEMANDS a block-capable container and
// edits it through the mode-swappable surfaces. Its constructor signature is its
// capability declaration — hand it a container that only speaks whole-content and
// the block verbs are simply absent, which is why a prompt gets a different type
// rather than a flag.

import { AbstractEditor } from '../abstract-editor.js'
import { EditorMode } from './editor-mode.js'
import { EditorToolbar } from './editor-toolbar.js'
// Importing these modules also assigns their window.* handles as a side effect,
// still read by the remaining classic-script consumers.
import { WysiwygSurface } from './surfaces/wysiwyg-surface.js'
import { MarkdownSurface } from './surfaces/markdown-surface.js'

/**
 * @typedef {object} NoteEditorOptions
 * @property {any} [provider] — the container's provider; a note demands the block extension
 * @property {() => Promise<{body?: string, version?: number, scroll?: number}>} [loadContainer] — the host's loader (see AbstractEditor)
 * @property {import('./editor-toolbar.js').EditorToolbar|null} [toolbar] — injected toolbar (tests); defaults to a live EditorToolbar
 */

export class NoteEditor extends AbstractEditor {
  /**
   * The editor-owned toolbar, mounted lazily on the first present into the
   * #editor-toolbar host. Injectable for tests.
   * @type {EditorToolbar|null}
   */
  #toolbar = null

  /**
   * @param {string}           uuid
   * @param {NoteEditorOptions} [options]
   */
  constructor(uuid, options = {}) {
    super(uuid, options)
    // The toolbar is a NoteEditor concern (PromptEditor has none). A null host
    // (headless, or ShowToolbar off) makes every toolbar method a no-op.
    this.#toolbar = options.toolbar !== undefined ? options.toolbar : new EditorToolbar(this)
  }

  /**
   * Presents the surface (inherited behaviour) then binds the toolbar: mount it on
   * the first present, else re-render its surface section for the new surface (a
   * same-mode re-init that does not fire mode-changed). The flip's surface swap is
   * handled by the toolbar's own mode-changed subscription.
   * @override
   * @param {import('./editor-mode.js').EditorModeValue} mode
   * @param {HTMLElement} rootEl
   * @param {unknown}     content
   */
  presentSurface(mode, rootEl, content) {
    const surface = super.presentSurface(mode, rootEl, content)
    if (this.#toolbar) {
      if (this.#toolbar.mounted) this.#toolbar.refreshSurfaceSection()
      else this.#toolbar.mount()
    }
    return surface
  }

  /** @override — tears down the toolbar subscription alongside the surface. */
  destroy() {
    if (this.#toolbar) { this.#toolbar.destroy(); this.#toolbar = null }
    super.destroy()
  }

  /**
   * NoteEditor's repertoire: BOTH surfaces, mode-mapped. Each surface receives THIS
   * editor as its single constructor arg and calls its public API directly.
   * @protected
   * @param {import('./editor-mode.js').EditorModeValue} mode
   * @returns {import('./surfaces/abstract-surface.js').AbstractSurface}
   */
  _createSurface(mode) {
    if (mode === EditorMode.MARKDOWN) return new MarkdownSurface(this)
    return new WysiwygSurface(this)
  }
}
