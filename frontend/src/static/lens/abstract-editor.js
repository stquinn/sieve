// @ts-check
// The stable identity for one open document's editing session: the uuid, dirty
// state, the save/destroy contract, and the document's INPUT SURFACE.
//
// Mode and the TipTap handle are DERIVED from the mounted surface, so there is
// no stored mode to fall out of sync. Nothing here computes a document position
// for Go: every anchor is a BLOCK ID.

import { Lens } from './lens.js'
import { ContractViolation } from '../contract/sieve-block.js'
import { AbstractSurface } from './document-editor/surfaces/abstract-surface.js'
import { EditorMode } from './document-editor/editor-mode.js'
import { SelectionModel } from './document-editor/selection-model.js'
import { blockInsertPos } from './document-editor/surfaces/ai-target.js'
import { emptyParagraphAnchor, blockIndexForInsert, blockIndexAt, docPosForBlockIndex } from './document-editor/surfaces/block-position.js'
import { buildAiContext, applyTargetHighlight } from './extensions.js'
import { resolveEntriesForKind } from './document-editor/surfaces/sieve-block-extension.js'
import { AddressStatus } from '../renderers/address-status.js'

/**
 * @typedef {import('./document-editor/surfaces/abstract-surface.js').SurfaceEventMsg} SurfaceEventMsg
 * @typedef {import('./document-editor/editor-mode.js').EditorModeValue} EditorModeValue
 * @typedef {import('../contract/container-provider.js').BlockContainerProvider} BlockContainerProvider
 */

/**
 * @typedef {object} AbstractEditorOptions
 * @property {any} [provider]
 *   the mounted container's provider, pre-bound to one container by the host.
 *   REQUIRED: possession of a provider is what authorizes a lens to present a
 *   container at all.
 * @property {() => Promise<{body?: string, version?: number, scroll?: number}>} [loadContainer]
 *   the HOST's loader for this container; `reload()` invokes it and repaints from
 *   the model it reseeded. Absent means this editor cannot reload.
 * @property {object} [mentionService]
 *   the `@`-picker peer the WYSIWYG surface hosts. Optional: without it the
 *   editor simply has no `@` picker.
 */

export class AbstractEditor extends Lens {
  /** @type {string} */
  #uuid

  /** @type {boolean} */
  #dirty = false

  /** @type {AbstractSurface|null} */
  #surface = null

  /** @type {Array<(event: SurfaceEventMsg) => void>} surface-event registrants */
  #eventListeners = []

  /** @type {SelectionModel} the editor-private authority on selection/caret
   *  context OUTSIDE the surface. Fed via #feedSelectionModel, pulled through
   *  getSelectionContext. */
  #selectionModel

  /** @type {boolean} whether this container's provider carries the BLOCK
   *  extension. A lens's capability is what its provider offers. */
  #blockCapable = false

  /** @type {(() => Promise<{body?: string, version?: number, scroll?: number}>)|null} */
  #loadContainer = null

  /** @type {object|null} the `@` picker's peer, held for the WYSIWYG surface. */
  #mentionService = null

  /** @type {AddressStatus|null} built on demand over the mention peer. */
  #addressStatus = null

  /** @type {Promise<boolean>|null} the in-flight mode flip; reentrant setMode coalesces onto it */
  #modeFlip = null

  /** @type {boolean} AI-block visibility for THIS editor (mirrored as a CSS class on the root) */
  #showAiBlocks = true

  /** @type {boolean} set while a whole-container LOAD is mid-flight. A save
   *  would race the re-render, and a cue names blocks against a model halfway
   *  through being reset; the repaint at the end answers both. */
  #reloadInProgress = false

  /** @type {(e: Event) => void} the `sieve:container-saved` subscription, kept so destroy() can drop it. */
  #onContainerSaved

  /** @type {number} the newest document version this editor has evidence of, and
   *  the baseline saveAndSettle compares against. Only ever rises. 0 means "no
   *  version known", which is what an unversioned container reports forever. */
  #version = 0

  /**
   * @param {string}                uuid    — document uuid; the editor's fixed identity
   * @param {AbstractEditorOptions} [options]
   */
  constructor(uuid, options = {}) {
    super(options.provider)
    if (!uuid) throw new ContractViolation('AbstractEditor: uuid is required')
    this.#uuid = uuid
    this.#selectionModel = new SelectionModel(uuid)
    // Bridge the SelectionModel push onto the editor's ONE onEvent stream.
    this.#selectionModel.onUpdate((ctx) => {
      this.#emitEvent({ type: 'selection-update', context: ctx })
      // An ADVERT, not a request: nothing here waits for or reads an answer.
      this.advertiseSelection(ctx)
    })
    this.#blockCapable = typeof this.provider.requestAddBlock === 'function'
    this.#loadContainer = options.loadContainer || null
    this.#mentionService = options.mentionService || null

    // Subscribed before any surface mounts, so a save landing during the initial
    // load is not missed. A prompt has no channel and still gets this: the fact
    // rides the workspace wire.
    this.#onContainerSaved = (e) => {
      const detail = /** @type {CustomEvent} */ (e).detail
      if (detail && detail.uuid === this.#uuid) this.#markSaved(Number(detail.version) || 0)
    }
    document.addEventListener('sieve:container-saved', this.#onContainerSaved)
  }

  /**
   * @override — the editor's OWN uuid, fixed at construction and outliving any
   * one mount, so saveAndSettle recognises its own facts before a surface has
   * ever been presented.
   * @returns {string}
   */
  get uuid() { return this.#uuid }

  /**
   * @override — the base's provider, WIDENED: which verbs are present IS the
   * capability declaration this class probes for, so a narrower type would make
   * every probe an error.
   * @returns {any}
   */
  get provider() { return super.provider }

  /** @returns {boolean} */
  get canEditBlocks() { return this.#blockCapable }

  get mentionService() { return this.#mentionService }

  /** What this editor has learned about whether the coordinates its blocks render
   *  still resolve; null in bare constructions. Owned HERE, not by the workspace,
   *  so its memory dies with the editor and reopening asks again.
   *  @returns {AddressStatus|null} */
  get addressStatus() {
    if (!this.#addressStatus && this.#mentionService) {
      this.#addressStatus = new AddressStatus(/** @type {any} */ (this.#mentionService))
    }
    return this.#addressStatus
  }

  /** @returns {AbstractSurface|null} The mounted input surface, or null. */
  get surface() { return this.#surface }

  /** Current editing mode, DERIVED from the mounted surface; the subclass default
   *  applies before any surface mounts.
   *  @returns {EditorModeValue} */
  get mode() { return this.#surface ? /** @type {EditorModeValue} */ (this.#surface.mode) : this._defaultMode }

  /**
   * @protected
   * @returns {EditorModeValue}
   */
  get _defaultMode() { return EditorMode.WYSIWYG }

  /** @returns {unknown|null} The live TipTap instance, or null (markdown / unmounted). */
  get editorPane() { return this.#surface ? this.#surface.editorPane : null }

  /** @returns {boolean} */
  get isDirty() { return this.#dirty }

  markDirty() { this.#dirty = true }

  clearDirty() { this.#dirty = false }

  /**
   * Registers a listener for the editor-domain event stream: the mounted
   * surface's events plus the editor's OWN mode-changed / mode-change-failed.
   * @param {(event: SurfaceEventMsg) => void} fn
   * @returns {() => void} unsubscribe
   */
  onEvent(fn) {
    this.#eventListeners.push(fn)
    return () => {
      this.#eventListeners = this.#eventListeners.filter((l) => l !== fn)
    }
  }

  /** @param {SurfaceEventMsg} event */
  #emitEvent(event) {
    for (const fn of this.#eventListeners) {
      try { fn(event) } catch (e) { console.error('[editor] surface-event listener threw', e) }
    }
  }

  /**
   * The SurfaceListener handler. Feeds the SelectionModel FIRST, so an onEvent
   * handler pulling getSelectionContext() sees the fresh context.
   * @param {SurfaceEventMsg} event
   */
  onSurfaceEvent(event) {
    this.#feedSelectionModel(event)
    this.#emitEvent(event)
    const type = event && event.type
    // Both kinds of content change refresh what MEASURES the document; only an
    // authored one dirties it.
    if (type === 'doc-changed' || type === 'doc-projected') this.#emitStats()
    if (type === 'doc-changed') {
      this.markDirty()
      document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
    }
  }

  /** The current frozen SelectionContext — the pull path for actions needing the
   *  caret/selection context WITHOUT reaching into PM or the DOM.
   *  @returns {import('./document-editor/selection-model.js').SelectionContext} */
  getSelectionContext() { return this.#selectionModel.getContext() }

  /** Subscribes to `selection-update`, fired on meaningful change only.
   *  @param {(ctx: import('./document-editor/selection-model.js').SelectionContext) => void} fn
   *  @returns {() => void} unsubscribe */
  onSelectionUpdate(fn) { return this.#selectionModel.onUpdate(fn) }

  /** The ONE place the SelectionModel is fed. Called BEFORE #emitEvent.
   *  @param {SurfaceEventMsg} event */
  #feedSelectionModel(event) {
    const s = this.#surface
    if (!s) return
    const t = event && event.type
    if (t === 'selection-changed' || t === 'transaction' || t === 'focus-changed') {
      const raw = s.feedSelection()
      if (raw) this.#selectionModel.ingest(raw)
    } else if (t === 'scroll-changed') {
      // Its OWN channel: a raw selection descriptor carries no scroll field and
      // must not be able to reset it.
      this.#selectionModel.setScroll(s.feedScroll())
    }
    if (t === 'focus-changed') {
      this.#selectionModel.setFocusZone(this.#deriveFocusZone())
    }
  }

  /** Derives the focus zone from live DOM focus plus the mounted surface:
   *  'block-inner' for an inner form control inside a sieve block, 'markdown' for
   *  the markdown surface, else 'editor'.
   *  @returns {import('./document-editor/selection-model.js').SelectionContext['focusZone']} */
  #deriveFocusZone() {
    if (this.mode === EditorMode.MARKDOWN) return 'markdown'
    const active = (typeof document !== 'undefined') ? document.activeElement : null
    if (active && typeof active.closest === 'function' && active.closest('.sieve-block__edit')) {
      return 'block-inner'
    }
    return 'editor'
  }

  /**
   * Builds the input surface for a mode. ABSTRACT: which surface classes an
   * editor can present is TYPE-DEFINING knowledge on the concrete editor, which
   * hands the surface THIS editor (`host`) — no services bag.
   * @protected
   * @param {EditorModeValue} mode
   * @returns {AbstractSurface}
   */
  _createSurface(mode) {
    throw new ContractViolation('AbstractEditor: _createSurface must be implemented by the concrete editor type')
  }

  /**
   * Presents the input surface for a mode. The ONE place surfaces are swapped.
   * @param {EditorModeValue} mode
   * @param {HTMLElement} rootEl  — the editor's root
   * @param {unknown}     content — surface seed (markdown string, or {body, blocks})
   * @returns {AbstractSurface} the mounted surface
   */
  presentSurface(mode, rootEl, content) {
    if (this.isMounted) this.unmount()
    const next = this._createSurface(mode)
    if (!(next instanceof AbstractSurface)) throw new ContractViolation('AbstractEditor: _createSurface must return an AbstractSurface')
    // A mount root can arrive pre-classed by a PREVIOUS editor's toggle.
    rootEl.classList.toggle('hide-ai-blocks', !this.#showAiBlocks)
    next.mount(rootEl, content)
    this.#surface = next
    // Mount LAST: subscribing cues immediately with the whole container, so the
    // surface mounts empty and the bootstrap cue paints it. Painting the WHOLE
    // container is only safe here, at open — no undo history yet to lose.
    super.mount(rootEl)
    // Seed stats for the new surface; doc-changed emits them thereafter.
    this.#emitStats()
    return next
  }

  /**
   * @override — tears the surface down BEFORE the base drops the subscription and
   * empties the root. The order is load-bearing: a WysiwygSurface destroys a live
   * ProseMirror view, which must still own its DOM when it does.
   */
  unmount() {
    if (this.#surface) {
      this.#surface.unmount()
      this.#surface = null
    }
    super.unmount()
  }

  /**
   * @override — the container changed. WHO changed it is deliberately unsayable.
   * Re-READS, since nothing is carried in the cue. Suppressed during a
   * host-driven load, which repaints anyway.
   * @param {Readonly<{blockIds: ReadonlyArray<string>, orderChanged: boolean}>} change
   */
  paint(change) {
    if (this.#reloadInProgress) return
    const surface = this.#surface
    if (!surface) return
    surface.applyContainerChange(change || { blockIds: [], orderChanged: false }, this.provider)
  }

  #emitStats() { this.#emitEvent({ type: 'stats', ...this.stats() }) }

  /** The current document stats, DELEGATED to the active surface. A PULL seam, so
   *  a consumer arriving after the initial seed reads the current value.
   *  @returns {{ chars: number, lines: number, blockCount: number }} */
  stats() {
    return this.#surface ? this.#surface.stats() : { chars: 0, lines: 0, blockCount: 0 }
  }

  // Each search verb DELEGATES to the mounted surface. A surface with no search
  // returns false, which the overlay reads as "no matches".

  /** @param {string} term @returns {{current:number,total:number}|false} */
  searchTerm(term) { return this.#surface ? this.#surface.searchTerm(term) : false }

  /** @returns {{current:number,total:number}|false} */
  searchNext() { return this.#surface ? this.#surface.searchNext() : false }

  /** @returns {{current:number,total:number}|false} */
  searchPrev() { return this.#surface ? this.#surface.searchPrev() : false }

  /** @returns {false} */
  clearSearch() { return this.#surface ? this.#surface.clearSearch() : false }

  /**
   * This document's content reached disk: drop the dirty state and tell the
   * chrome. Runs for EVERY save, and the editor never learns which kind it was.
   * The version only ever rises — facts from two writers can arrive out of order,
   * and adopting the lower would hand saveAndSettle a baseline older than disk.
   * @param {number} version the version this save produced, 0 if unversioned
   */
  #markSaved(version) {
    if (version > this.#version) this.#version = version
    this.clearDirty()
    document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false } }))
    document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: this.#uuid } }))
  }

  /**
   * Hands the container the whole raw buffer this lens holds — the whole-content
   * flavour of `flush`. Deliberately NOT `setContents`: that means "re-parse
   * this", and a half-typed break-glass buffer must not be re-parsed.
   * @param {string} raw
   */
  setRawContent(raw) {
    if (typeof this.provider.flushContents === 'function') {
      this.provider.flushContents(raw)
    }
  }

  /**
   * Requests a block extraction/transform: clears any stale insert position,
   * stamps the caller context onto the first entry, resolves the target block
   * index (skipped for transform and undo-smart-paste, which mutate in place) and
   * the entries for the target kind, then hands the payload to the transport.
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
    const res = resolveEntriesForKind ? resolveEntriesForKind(targetKind, sourceNode, entries) : entries
    return Promise.resolve(res).then((resolved) => {
      if (this.#blockCapable) this.provider.requestTransform(blockId, targetKind, wireOp, resolved)
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
    const ed = /** @type {any} */ (this.editorPane)
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
    if (this.#surface) this.#surface.flushPending()
  }

  /** Pastes plain text through the mounted surface's paste path, so it produces
   *  the same document a Mod+V of the same clipboard would.
   *  @param {string} text @returns {Promise<'block'|'content'|'none'>} */
  pasteText(text) {
    return this.#surface ? this.#surface.pasteText(text) : Promise.resolve('none')
  }

  /** Restores focus/selection from a SelectionContext coordinate — the WRITE side
   *  of getSelectionContext. Safe no-op when no surface is mounted.
   *  @param {import('./document-editor/selection-model.js').SelectionContext} ctx */
  applyPosition(ctx) {
    if (!this.#surface) return
    this.#surface.applyPosition(ctx)
    // ctx is the PRE-reload pulled context, so a null scroll (never reported yet)
    // is correctly a no-op rather than a forced park.
    this.#surface.applyScroll(ctx && ctx.scroll)
  }

  /** Restores (or parks) the scroller position on a FRESH load, right after the
   *  surface presents its content; 0 is the park-at-top floor.
   *  @param {number} value */
  restoreScroll(value) {
    if (this.#surface) this.#surface.applyScroll(value)
  }

  /**
   * Switches the editing mode in place with stay-on-failure semantics:
   *
   *   1. flush the current surface (pending edits reach Go's shadow first)
   *   2. send enter-markdown / enter-wysiwyg and AWAIT the reply (5s)
   *   3. only on the reply, swap the surface — the mode getter flips because the
   *      surface did.
   *
   * On timeout/error the promise rejects and NOTHING was unmounted. A late reply
   * finds no awaiter. A reentrant call coalesces onto the in-flight promise.
   *
   * Exactly ONE 'mode-changed' is emitted per ACTUAL flip however many callers
   * coalesced, and ONE 'mode-change-failed' per failure; their handlers attach
   * here so a caller that ignores the promise never produces an unhandled
   * rejection.
   * @param {EditorModeValue} target
   * @returns {Promise<boolean>} whether the mode changed
   */
  setMode(target) {
    if (target !== EditorMode.WYSIWYG && target !== EditorMode.MARKDOWN) return Promise.resolve(false)
    // A container with no block extension has one shape to be in — a prompt IS
    // its text.
    if (!this.#blockCapable) return Promise.resolve(false)
    if (!this.#surface || target === this.mode) return Promise.resolve(false)
    if (this.#modeFlip) return this.#modeFlip
    this.#modeFlip = this.#flipTo(target).finally(() => { this.#modeFlip = null })
    this.#modeFlip.then(
      (changed) => { if (changed) this.#emitEvent({ type: 'mode-changed', mode: this.mode }) },
      (err) => { this.#emitEvent({ type: 'mode-change-failed', mode: this.mode, error: err }) },
    )
    return this.#modeFlip
  }

  /** BINARY-FLIP SUGAR over setMode, the N-mode primitive: a third mode adds
   *  setMode call sites rather than growing this.
   *  @returns {Promise<boolean>} whether the mode changed */
  toggleMode() {
    const target = this.mode === EditorMode.MARKDOWN ? EditorMode.WYSIWYG : EditorMode.MARKDOWN
    return this.setMode(target)
  }

  /**
   * @param {EditorModeValue} target
   * @returns {Promise<boolean>}
   */
  async #flipTo(target) {
    const old = /** @type {import('./document-editor/surfaces/abstract-surface.js').AbstractSurface} */ (this.#surface)
    // Flush pending edits BEFORE the handshake so Go's shadow is current.
    old.flushPending()

    // Both directions speak WHOLE-CONTENT through the same provider.
    const provider = this.provider
    let payload
    if (target === EditorMode.MARKDOWN) {
      // The frontend never serialises a document; that stays Go's job.
      payload = await provider.getContents()
    } else {
      // Hand the whole buffer back; Go re-parses and its blocks become the truth
      // again. That reset reaches this lens as the bootstrap cue of the new
      // surface, so nothing is passed through here.
      await provider.setContents(old.body || '')
      payload = null
    }

    // Success only — the swap is unreachable on timeout/error.
    this.presentSurface(target, /** @type {HTMLElement} */ (this.host), payload)
    return true
  }

  /** Toggles AI-block visibility for THIS editor, mirrored as the
   *  `hide-ai-blocks` class on the editor-owned root.
   *  @returns {boolean} whether AI blocks are now shown */
  toggleAiBlocks() {
    this.#showAiBlocks = !this.#showAiBlocks
    if (this.host) this.host.classList.toggle('hide-ai-blocks', !this.#showAiBlocks)
    return this.#showAiBlocks
  }

  /**
   * The ONE create path: asks the container for a new block, anchored after a
   * BLOCK ID. Callers pass a stable id or nothing, NEVER a document position.
   * OMITTED derives the anchor from the caret with the empty-paragraph consume;
   * `null` means the front; a stale or unknown id appends, as markdown mode
   * always does, having no caret to read.
   * @param {string} kind
   * @param {object} [attrs]
   * @param {string|null} [afterBlockId] — a stable block id, never a position
   */
  createBlock(kind, attrs, afterBlockId) {
    attrs = attrs || {}
    // diagram default: an empty (source-less) diagram opens straight into edit mode.
    if (kind === 'diagram' && !attrs.source) attrs.mode = 'edit'
    if (!this.#blockCapable) return
    const anchor = (afterBlockId === undefined) ? this.#anchorFromCaret() : afterBlockId
    this.provider.requestAddBlock(kind, attrs, anchor)
  }

  /**
   * Inserts `url` at the caret as a titled hyperlink — the INLINE sibling of
   * createBlock, separate because a link is a mark over text, not a member of the
   * document list. The work is the surface's.
   * @param {string} url
   * @returns {Promise<boolean>} whether a link was inserted (false in a surface
   *   with no inline marks)
   */
  insertLink(url) {
    return this.#surface ? this.#surface.insertLink(url) : Promise.resolve(false)
  }

  /**
   * Stashes the caret's insert ANCHOR for an async insert that outlives the caret:
   * the image insert opens a file dialog, which blurs the editor. NON-consuming,
   * because a cancelled upload must leave the blank line.
   * @returns {string|null|undefined} the block the upload should follow
   */
  captureImageInsert() {
    if (!this.editorPane) return undefined
    const ed = /** @type {any} */ (this.editorPane)
    return this.#anchorAtIndex(blockIndexForInsert(ed.state.doc, this.captureInsertPos()))
  }

  /**
   * The SINGLE AI-job seam, for every entry point. PURE over `context` — the
   * SelectionContext the panel LAST RENDERED, i.e. the label the user saw. It
   * NEVER re-reads the live selection on write: that would race the label (panel
   * shows target C1, editor acts on a drifted C2).
   *
   * Builds the ai-block ref, applies the == target highlight, anchors the insert
   * AFTER the target's top-level block, flushes the pending sync, creates the
   * ai-block, and collapses the caret to the target end. EXPLAIN in markdown is a
   * no-op; ASK still works.
   * @param {{ type: 'ask'|'explain', question?: string, context?: import('./document-editor/selection-model.js').SelectionContext, attachments?: Array<{uri: string, title?: string}> }} job
   *   `attachments` is the composer's manifest — a plain attr on the ai-block,
   *   leaving `ref` untouched.
   * @returns {Promise<void>}
   */
  askAi({ type, question, context, attachments }) {
    // EXPLAIN needs an inline target; markdown mode has none → nothing to explain.
    if (type === 'explain' && this.mode === EditorMode.MARKDOWN) return Promise.resolve()
    const ctx = context || this.getSelectionContext()
    const aiCtx = buildAiContext(ctx)
    const ref = (aiCtx && aiCtx.blockRef) || 'doc'
    const blockType = type === 'explain' ? 'EXPLAIN' : 'ASK'
    const target = ctx && ctx.target
    const ed = /** @type {any} */ (this.editorPane)
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
        const attrs = /** @type {Record<string, any>} */ ({ type: blockType, ref: ref, question: question || '' })
        // Absent IS the empty case (Go's InitAttrs deletes an empty list).
        if (attachments && attachments.length) attrs.attachments = attachments
        this.createBlock('ai-block', attrs, anchorId)
      })
      .catch((err) => { console.error('[editor] askAi flush error:', err) })
    // Editor owns its cursor: collapse focus to the target end.
    if (ed && ed.view) {
      try { ed.commands.setTextSelection(ed.state.selection.to) } catch (e) { /* best-effort */ }
    }
    return done
  }

  // The anchor vocabulary is three-valued: `undefined` = "no anchor, append";
  // `null` = "the front"; an id = "after that one".

  /** Resolves WHERE the next inserted block goes — the single way every additive
   *  creation path stamps the insert position. Block answers always land after the
   *  top-level block, never at the caret.
   *  @returns {number|null} */
  captureInsertPos() {
    const ed = /** @type {any} */ (this.editorPane)
    return ed ? blockInsertPos(ed.state) : null
  }

  /** The block id a new child taking top-level index `index` should follow. Walks
   *  BACK past any node with no id: the trailing editing surface is not a block Go
   *  knows about, so it cannot anchor anything.
   *  @param {number} index @returns {string|null|undefined} */
  #anchorAtIndex(index) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed || index < 0) return undefined     // no document / no anchor → append
    if (index === 0) return null               // the front of the container
    const doc = ed.state.doc
    for (let i = Math.min(index, doc.childCount) - 1; i >= 0; i--) {
      const id = doc.child(i).attrs && doc.child(i).attrs.id
      if (id) return id
    }
    return null
  }

  /**
   * Maps a captured insert position to the anchor a new block should follow,
   * applying the empty-paragraph placement rule AT COMMIT TIME — never at capture,
   * because a cancelled dialog must not eat the blank line. A bare empty paragraph
   * there is deleted and the new block anchored where it was, then the sync is
   * flushed so Go's shadow applies the delete BEFORE the create arrives.
   *
   * UNDO SANCTITY: a PLAIN TRACKED prose edit — never addToHistory:false.
   * @param {number|null} pos
   * @returns {string|null|undefined}
   */
  #commitAnchor(pos) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed) return undefined
    const anchor = emptyParagraphAnchor(ed.state.doc, pos)
    if (!anchor) return this.#anchorAtIndex(blockIndexForInsert(ed.state.doc, pos))
    // Sole-block doc: keep the paragraph (deleting the doc's only child is
    // schema-invalid).
    if (ed.state.doc.childCount > 1) {
      ed.view.dispatch(ed.state.tr.delete(anchor.from, anchor.to))
      if (this.#surface) this.#surface.flushPending()
    }
    return this.#anchorAtIndex(anchor.index)
  }

  /** The caret-derived anchor, with the empty-paragraph consume. createBlock's
   *  default. @returns {string|null|undefined} */
  #anchorFromCaret() { return this.#commitAnchor(this.captureInsertPos()) }

  /** The caret-derived anchor, for a surface that creates blocks of its own.
   *  @returns {string|null|undefined} */
  insertAnchorForBlock() { return this.#anchorFromCaret() }

  /** @param {number} pos @returns {string|null|undefined} */
  insertAnchorAt(pos) { return this.#commitAnchor(pos) }

  // #commitAnchor eats the empty-paragraph anchor EAGERLY, which is right when
  // the call point IS the confirmation (a dialog). A paste commits BEFORE it knows
  // the server matched, and on a no-match the eager delete has already remapped
  // the orphaned caret into the adjacent block. So: peek, ask Go, and consume ONLY
  // on the `block` outcome.

  /** The SIDE-EFFECT-FREE half: the anchor plus a HANDLE to the empty paragraph,
   *  to consume once the server confirms. Null handle when there is none, or it is
   *  the doc's sole child.
   *  @param {number|null} pos
   *  @returns {{ afterBlockId: string|null|undefined, anchor: {id: string}|null }} */
  peekInsertAnchor(pos) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed) return { afterBlockId: undefined, anchor: null }
    const anchor = emptyParagraphAnchor(ed.state.doc, pos)
    if (!anchor) {
      return { afterBlockId: this.#anchorAtIndex(blockIndexForInsert(ed.state.doc, pos)), anchor: null }
    }
    if (ed.state.doc.childCount <= 1) return { afterBlockId: this.#anchorAtIndex(anchor.index), anchor: null }
    const node = ed.state.doc.child(anchor.index)
    const id = ((node && node.attrs) || {}).id || ''
    // The anchor sits AT `anchor.index`, so the new block follows whatever
    // precedes it.
    return { afterBlockId: this.#anchorAtIndex(anchor.index), anchor: id ? { id: id } : null }
  }

  /** @returns {{ afterBlockId: string|null|undefined, anchor: {id: string}|null }} */
  peekInsertAnchorForBlock() { return this.peekInsertAnchor(this.captureInsertPos()) }

  /** @param {number} pos
   *  @returns {{ afterBlockId: string|null|undefined, anchor: {id: string}|null }} */
  peekInsertAnchorAt(pos) { return this.peekInsertAnchor(pos) }

  /**
   * The DEFERRED second half: once the server CONFIRMED the insert, delete the
   * empty paragraph that held its place, as a TRACKED prose edit, and flush.
   * Located BY ID, never by a captured position — the arrival can shift positions
   * first. No-op when the handle is absent, not found, the doc's sole child, or no
   * longer empty.
   * @param {{id: string}|null} anchor
   */
  consumeInsertAnchor(anchor) {
    if (!anchor || !anchor.id) return
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed || ed.state.doc.childCount <= 1) return
    let pos = -1
    let node = null
    ed.state.doc.forEach((child, offset) => {
      if (pos >= 0) return
      if (child && child.attrs && child.attrs.id === anchor.id) {
        pos = offset
        node = child
      }
    })
    if (pos < 0 || !node) return
    // Only ever consume a still-empty paragraph: a stray blank line is benign,
    // losing typed content is not.
    if ((/** @type {any} */ (node).textContent || '').trim() !== '') return
    ed.view.dispatch(ed.state.tr.delete(pos, pos + (/** @type {any} */ (node).nodeSize)))
    if (this.#surface) this.#surface.flushPending()
  }

  /**
   * @returns {boolean} whether a save should be suppressed (a whole-container
   * load is mid-flight; a save now would race the re-render).
   */
  isSaveSuppressed() { return this.#reloadInProgress }

  /**
   * Re-reads the whole container from disk and repaints, preserving the caret.
   * ONLY for genuine LOADS — never for an ordinary change, which arrives as a cue
   * and is placed as a tracked transaction. A whole repaint is
   * `addToHistory:false` by construction and WIPES UNDO HISTORY.
   *
   * The load itself is the HOST's; what belongs here is the pair either side of
   * it — hold the cues while the model is mid-reset, and paint once at the end.
   * @returns {Promise<void>}
   */
  async reload() {
    const mode = this.mode
    if (mode !== 'wysiwyg' && mode !== 'markdown') return
    if (mode === 'wysiwyg' && !this.editorPane) return
    if (!this.#loadContainer) return // no loader: nothing to reload from
    this.#reloadInProgress = true
    // Pull the focus coordinate before the async load so the caret survives.
    const focus = this.getSelectionContext()
    try {
      const data = (await this.#loadContainer()) || {}
      this.seedVersion(data.version || 0)
      const surface = this.#surface
      if (mode === 'wysiwyg' && this.editorPane && surface) {
        // The container model is the truth the repaint reads — the same reads
        // every cue uses, so a load and a change paint from ONE source.
        surface.paintContainer(this.provider)
        this.#reloadInProgress = false
        this.applyPosition(focus)
      } else if (mode === 'markdown' && surface) {
        surface.replaceBody(data.body || '')
        this.#reloadInProgress = false
      } else {
        this.#reloadInProgress = false
      }
    } catch (err) {
      this.#reloadInProgress = false
      console.error('[editor] reload failed', err)
    }
  }

  /**
   * Flushes any pending debounced edit, then asks Go to persist. Both halves are
   * FIRE-AND-FORGET: the save announces itself as `container-saved`. The returned
   * promise is already settled and exists only so a caller can chain work after
   * the frames are on the wire — Go serves one socket's frames in order.
   * PromptEditor overrides this with the awaited HTTP save path.
   * @returns {Promise<unknown>}
   */
  flushSave() {
    const s = this.#surface
    if (s) s.flushPending()
    if (typeof this.provider.requestPersist === 'function') {
      this.provider.requestPersist()
    }
    return Promise.resolve()
  }

  /**
   * Seeds the version this editor knows its content to be at. Without it the FIRST
   * saveAndSettle of an editor's life has no baseline and would settle on any fact
   * at all, including one for a write that predates the ask.
   * @param {number} version 0 for a container that keeps no version history
   */
  seedVersion(version) {
    this.#version = Number(version) || 0
  }

  /**
   * Saves, and resolves when the save LANDS — this uuid's `container-saved` fact,
   * not the request that provoked it. Needed by work performed ELSEWHERE on what
   * is on disk: frames on two sockets have no order between them, so "I sent a
   * flush" is not "the bytes are down".
   *
   * "Lands" means a version NEWER than the one this editor already knew. A uuid
   * match alone is not enough: a debounce write already in flight would settle the
   * wait against bytes that exclude these edits. An unversioned container reports
   * version 0 and so has only the uuid to go on; that window is empty in practice,
   * since a prompt has no shadow and therefore no debounce timer.
   *
   * Always RESOLVES, never rejects.
   * @param {number} [graceMs] how long to wait for the fact before giving up on it
   * @returns {Promise<void>}
   */
  saveAndSettle(graceMs = 3000) {
    const knownVersion = this.#version
    const landed = new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout>} */ let timer
      const finish = () => {
        clearTimeout(timer)
        document.removeEventListener('sieve:container-saved', heard)
        resolve()
      }
      const heard = (e) => {
        const detail = /** @type {CustomEvent} */ (e).detail
        if (!detail || detail.uuid !== this.#uuid) return
        if (detail.version && detail.version <= knownVersion) return
        finish()
      }
      timer = setTimeout(finish, graceMs)
      document.addEventListener('sieve:container-saved', heard)
    })
    // Listen BEFORE asking: a loopback save can land inside the same tick.
    this.flushSave()
    return landed
  }

  /**
   * Tears the editor session down: unmounts the surface and closes the document's
   * live channel. Subclasses that extend destroy() must call super.destroy().
   */
  destroy() {
    // A lens hands back only what it took: the surface, the subscription, the
    // element.
    this.unmount()
    document.removeEventListener('sieve:container-saved', this.#onContainerSaved)
    this.setSelectionListener(null)
  }
}
