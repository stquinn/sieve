// @ts-check
// NoteEditor's whole definition: the lens that DEMANDS a block-capable container and
// edits it through the mode-swappable surfaces. Its constructor signature is its
// capability declaration — hand it a container that only speaks whole-content and
// the block verbs are simply absent, which is why a prompt gets a different type
// rather than a flag.

import { ProseMirrorEditor } from './prosemirror-editor.js'
import { EditorMode } from './editor-mode.js'
import { EditorToolbar } from './editor-toolbar.js'
import { blockIndexAt, docPosForBlockIndex } from './surfaces/block-position.js'
import { buildAiContext, applyTargetHighlight } from '../extensions.js'
import { resolveEntriesForKind } from './surfaces/sieve-block-extension.js'
import { QuestionList } from '../../renderers/question-list.js'
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

/** Both surfaces, the block one first. */
const NOTE_MODES = Object.freeze([EditorMode.WYSIWYG, EditorMode.MARKDOWN])

export class NoteEditor extends ProseMirrorEditor {
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

  /** @protected @returns {ReadonlyArray<import('./editor-mode.js').EditorModeValue>} */
  get _modes() { return NOTE_MODES }

  /** @protected @returns {import('./editor-mode.js').EditorModeValue} */
  get _defaultMode() { return EditorMode.WYSIWYG }

  /**
   * Requests a block extraction/transform: stamps the caller context onto the
   * first entry, resolves the entries for the target kind, then names the SOURCE
   * BLOCK and the operation. Where the result lands is Go's — an additive extract
   * follows its source, a transform keeps the source's slot.
   *
   * RANGE SOURCES (`sourceRange`). A prose link is a mark over a text range, not a
   * block, so an in-place TRANSFORM has nothing to replace and would destroy the
   * surrounding sentence. Its playback is #consumeSourceRange instead — an
   * ordinary additive create, so the wire verb stays `extract`.
   * @param {{blockId: string, targetKind: string, operation: string, sourceNode?: object, entries: object[], context?: object, sourceRange?: {from: number, to: number}}} payload
   * @returns {Promise<void>}
   */
  extract({ blockId, targetKind, operation, sourceNode, entries, context, sourceRange }) {
    entries = entries || []
    if (entries.length > 0 && context && Object.keys(context).length > 0) {
      entries[0].context = context
    }
    let wireOp = operation
    if (sourceRange) {
      wireOp = 'extract'
      this.#consumeSourceRange(sourceRange)
    }
    const res = resolveEntriesForKind ? resolveEntriesForKind(targetKind, sourceNode, entries, this.uuid) : entries
    return Promise.resolve(res).then((resolved) => {
      if (this.canEditBlocks) this.provider.requestTransform(blockId, targetKind, wireOp, resolved)
    })
  }

  /**
   * Consumes a RANGE SOURCE and returns the block index its replacement is created
   * at: delete the range, then the enclosing paragraph too if that emptied it
   * (never the doc's sole child — schema-invalid). Both are TRACKED prose edits,
   * never addToHistory:false, because converting a link must be ONE undoable step.
   * The anchor derives from the RANGE, not a block id: a freshly typed paragraph
   * may not have been minted one yet.
   * @param {{from: number, to: number}} range
   */
  #consumeSourceRange(range) {
    const ed = this.editorPane
    if (!ed) return
    // Stale range: tr.delete THROWS out of range, and a throw here would take the
    // whole conversion with it.
    if (range.to > ed.state.doc.content.size || range.from < 0) return
    const paraIdx = blockIndexAt(ed.state.doc, range.from)
    if (paraIdx < 0) return
    if (range.to > range.from) ed.view.dispatch(ed.state.tr.delete(range.from, range.to))

    const doc = ed.state.doc
    const para = paraIdx < doc.childCount ? doc.child(paraIdx) : null
    if (para && doc.childCount > 1 && para.type.name === 'paragraph' && para.textContent.trim() === '') {
      const from = docPosForBlockIndex(doc, paraIdx)
      ed.view.dispatch(ed.state.tr.delete(from, from + para.nodeSize))
    }
    this.flushEdits()
  }

  /**
   * The SINGLE AI-job seam, for every entry point. PURE over `context` — the
   * SelectionContext the panel LAST RENDERED, i.e. the label the user saw. It
   * NEVER re-reads the live selection on write: that would race the label (panel
   * shows target C1, editor acts on a drifted C2).
   *
   * MINTS THE QUESTION AS A LIST OF BLOCKS, in gesture order: what the message is
   * about (the resolved target, or the parent exchange of a follow-up), the text
   * as prose, then what the `@` picker attached. Every reference it mints
   * declares its role.
   *
   * Applies the == target highlight, anchors the insert AFTER the target's
   * top-level block, flushes the pending sync, creates the ai-block, and
   * collapses the caret to the target end. EXPLAIN in markdown is a no-op; ASK
   * still works.
   * @param {{ type: 'ask'|'explain', question?: string|ReadonlyArray<import('../../renderers/question-list.js').QuestionElement>, context?: import('./selection-model.js').SelectionContext, attachments?: Array<{uri: string, title?: string}> }} job
   *   `question` is either the text of a one-line ask or the element list a
   *   composer authored; both land in the body slot, between the target and the
   *   attachments. `attachments` is the composer's manifest; each entry becomes a
   *   reference element of the question declaring `attach`.
   * @returns {Promise<void>}
   */
  askAi({ type, question, context, attachments }) {
    // EXPLAIN needs an inline target; markdown mode has none → nothing to explain.
    if (type === 'explain' && this.mode === EditorMode.MARKDOWN) return Promise.resolve()
    const ctx = context || this.getSelectionContext()
    const aiCtx = buildAiContext(ctx)
    const blockType = type === 'explain' ? 'EXPLAIN' : 'ASK'
    const target = ctx && ctx.target
    const ed = this.editorPane
    // Anchor AFTER the target's LAST block from the CONTEXT's ids, not the live
    // selection, so it survives a caret that drifted after the label rendered.
    const ids = (ctx.blockIds && ctx.blockIds.length) ? ctx.blockIds : (ctx.blockId ? [ctx.blockId] : [])
    const anchorId = ids[ids.length - 1]
    if (ed) {
      // Protocol-significant: the == mark tells Go which words the answer is
      // about. Only a ranged wysiwyg selection marks.
      if (target && target.kind === 'selection' && this.mode !== EditorMode.MARKDOWN && target.range) {
        applyTargetHighlight(ed, target.range)
      }
      ed.commands.focus()
    }
    const done = this.flushSave()
      .then(() => {
        const list = new QuestionList(this.uuid)
          .about((aiCtx && aiCtx.blockRef) || 'doc')
        if (Array.isArray(question)) list.body(question)
        else list.ask(/** @type {string|undefined} */ (question))
        list.attach(attachments)
        this.createBlock('ai-block', { type: blockType, question: list.elements }, anchorId)
      })
      .catch((err) => { console.error('[editor] askAi flush error:', err) })
    // Editor owns its cursor: collapse focus to the target end.
    if (ed && ed.view) {
      try { ed.commands.setTextSelection(ed.state.selection.to) } catch (e) { /* best-effort */ }
    }
    return done
  }
}
