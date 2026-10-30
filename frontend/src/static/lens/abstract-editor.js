// @ts-check
// The stable identity for one open document's editing session: the uuid, dirty
// state, the save/destroy contract, and the document's INPUT SURFACE.
//
// Mode is DERIVED from the mounted surface, so there is no stored mode to fall
// out of sync. WHICH modes there are is the concrete lens's vocabulary: this
// class names none of them.

import { Lens } from './lens.js'
import { ContractViolation } from '../contract/sieve-block.js'
import { LensCapability } from '../contract/lens-capabilities.js'
import { SelectionModel } from './document-editor/selection-model.js'
import { AddressStatus } from '../renderers/address-status.js'

/**
 * @typedef {import('./document-editor/surfaces/abstract-surface.js').AbstractSurface} AbstractSurface
 * @typedef {import('./document-editor/surfaces/abstract-surface.js').SurfaceEventMsg} SurfaceEventMsg
 * @typedef {import('../contract/container-provider.js').BlockContainerProvider} BlockContainerProvider
 * @typedef {import('../contract/lens-capabilities.js').LensCapabilities} LensCapabilities
 */

/** The one kind whose whole payload is text, so an empty one carries nothing. */
const PROSE_KIND = 'prose'

/** The full repertoire of an editing lens, before a subclass's identity or a
 *  missing dependency narrows it. */
const EVERY_CAPABILITY = Object.freeze({
  [LensCapability.MARKDOWN]: true,
  [LensCapability.MENTIONS]: true,
  [LensCapability.COMMANDS]: true,
  [LensCapability.BLOCKS]: true,
})

/**
 * @typedef {object} AbstractEditorOptions
 * @property {any} [provider]
 *   the mounted container's provider, pre-bound to one container by the host.
 *   REQUIRED: possession of a provider is what authorizes a lens to present a
 *   container at all.
 * @property {() => Promise<{body?: string, version?: number, scroll?: number}>} [loadContainer]
 *   the HOST's loader for this container; `reload()` invokes it and repaints from
 *   the model it reseeded. Absent means this editor cannot reload.
 * @property {object|null} [mentionService]
 *   the `@`-picker peer the WYSIWYG surface hosts. Optional: without it the
 *   editor simply has no `@` picker.
 * @property {object|null} [macroCatalog]
 *   what the HOST offers the `{` picker — the block kinds and the host verbs a
 *   surface composes its own presets onto. Optional: without it a surface's
 *   picker offers its presets alone.
 * @property {object|null} [commandService]
 *   the `/` picker's peer, enumerating the backend verbs this mount may dispatch.
 *   Optional: without it the editor simply has no `/` picker.
 * @property {object|null} [codeFormattingService]
 *   what a code menu asks to pretty-print source. Optional: without it no Format
 *   is offered.
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

  /** @type {Readonly<LensCapabilities>} this lens's published specification:
   *  what its class can innately do, narrowed by the dependencies it was
   *  actually given. Computed once in the constructor and frozen — the lens
   *  instance is the single authority on it. */
  #capabilities

  /** @type {(() => Promise<{body?: string, version?: number, scroll?: number}>)|null} */
  #loadContainer = null

  /** @type {object|null} the `@` picker's peer, held for the WYSIWYG surface. */
  #mentionService = null

  /** @type {object|null} the `{` picker's host half, held for the surface that
   *  composes its own presets onto it. */
  #macroCatalog = null

  /** @type {object|null} the `/` picker's peer, held for the WYSIWYG surface. */
  #commandService = null
  /** @type {import('../shell/trigger-host.js').TriggerPlacement|null} where the
   *  host wants this editor's trigger picker placed; null leaves it to the surface. */
  #triggerPlacement = null

  /** @type {object|null} what a code menu asks to pretty-print source. */
  #codeFormattingService = null

  /** @type {AddressStatus|null} built on demand over the mention peer. */
  #addressStatus = null

  /** @type {Promise<boolean>|null} the in-flight mode flip; reentrant setMode coalesces onto it */
  #modeFlip = null

  /** @type {boolean} AI-block visibility for THIS editor (mirrored as a CSS class on the root) */
  #showAiBlocks = true

  /** @type {boolean} whether THIS editor is presenting (mirrored as a CSS class on the root) */
  #presenting = false

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
    this.#loadContainer = options.loadContainer || null
    this.#mentionService = options.mentionService || null
    this.#macroCatalog = options.macroCatalog || null
    this.#commandService = options.commandService || null
    this.#triggerPlacement = options.triggerPlacement || null
    this.#codeFormattingService = options.codeFormattingService || null
    this.#capabilities = this.#deriveCapabilities()

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

  /**
   * The abilities of this CLASS, before any dependency narrows them. A subclass
   * whose identity forbids one says so here, and no dependency can grant it back.
   * @protected
   * @returns {Readonly<LensCapabilities>}
   */
  get _innateCapabilities() { return /** @type {any} */ (EVERY_CAPABILITY) }

  /**
   * The ONE artifact a consumer reads to know what this lens can do. The SAME
   * frozen object for the lens's whole life: a mount cannot renegotiate it, and
   * nothing outside may author one.
   * @returns {Readonly<LensCapabilities>}
   */
  getCapabilities() { return this.#capabilities }

  /** Innate abilities narrowed by what this lens was actually given. Called ONCE,
   *  from the constructor, against the options already stored.
   *  @returns {Readonly<LensCapabilities>} */
  #deriveCapabilities() {
    const innate = /** @type {any} */ (this._innateCapabilities)
    return Object.freeze({
      [LensCapability.MARKDOWN]: !!innate[LensCapability.MARKDOWN],
      [LensCapability.MENTIONS]: !!innate[LensCapability.MENTIONS] && !!this.#mentionService,
      [LensCapability.COMMANDS]: !!innate[LensCapability.COMMANDS] && !!this.#commandService,
      [LensCapability.BLOCKS]: !!innate[LensCapability.BLOCKS]
        && typeof this.provider.requestAddBlock === 'function',
    })
  }

  /** @returns {boolean} */
  get canEditBlocks() { return this.#capabilities.blocks }

  /** What this lens invites you to write in it while it is empty. A fact of the
   *  class, like its mode and its capabilities — a mount does not name it.
   *  @returns {string} */
  get placeholder() { return 'Start writing…' }

  /**
   * This MOUNT's key claims: keys the lens takes before its surface, its
   * interaction policy and the editor core ever see them. Asked from the
   * surface's pre-core keydown hook, so the claim composes with the Enter
   * family's existing ordering rather than bypassing it.
   *
   * PRECEDENCE IS FOCUS, and by construction: the hook fires on the view the
   * keystroke landed in, so two live editors on one page never contend.
   *
   * The base claims NOTHING — an editing lens that has not said otherwise wants
   * the ordinary editor behaviour for every key.
   * @param {KeyboardEvent} _event
   * @returns {boolean} whether the keypress was consumed
   */
  claimKey(_event) { return false }

  /**
   * A `@` candidate was accepted in a mount that cannot hold a block, so the
   * echo went into the text and the candidate itself has nowhere to be. A lens
   * whose host keeps a manifest overrides this to pass it on; the base drops it,
   * which is the right answer for a document — there the mention became a block.
   * @param {import('../shell/mention-service.js').MentionCandidate} _candidate
   */
  onMentionAccepted(_candidate) {}

  /** The mounted surface's text as ONE string, blocks joined by newlines — the
   *  read half of the coordinate space `deletePlainRange` cuts in.
   *  @returns {string} */
  plainText() { return this.#surface ? this.#surface.plainText() : '' }

  /** Cuts `[start, end)` out of that text as one tracked edit.
   *  @param {number} start @param {number} end */
  deletePlainRange(start, end) {
    if (this.#surface) this.#surface.deletePlainRange(start, end)
  }

  /**
   * The documents this lens's host says are attached, by title: every `@Title`
   * token naming one is marked where it is written.
   *
   * IT IS THE HOST'S ANSWER, NOT THE LENS'S. A lens holds no manifest — the
   * arrangement it sits in does — so a mount that keeps none simply never calls
   * this and nothing is marked, which is the correct reading of a document
   * where a mention became a block instead.
   * @param {ReadonlyArray<string|undefined>} titles
   */
  setMentionTitles(titles) {
    if (this.#surface) this.#surface.setMentionTitles(titles)
  }

  /**
   * The command this lens's host says the draft currently resolves to: the
   * leading `/verb` token is marked where it is written.
   *
   * IT IS THE HOST'S ANSWER, NOT THE LENS'S, for the reason `setMentionTitles`
   * is: the registry of verbs belongs to the arrangement, so a mount that keeps
   * none never calls this and nothing is marked.
   * @param {string|null} verb the command name, without its slash
   */
  setCommandVerb(verb) {
    if (this.#surface) this.#surface.setCommandVerb(verb)
  }

  /** The title of the marked `@Title` token at `pos`, or null where none is
   *  marked — which is every position of a lens whose host keeps no manifest.
   *  @param {number} pos @returns {string|null} */
  mentionTitleAt(pos) {
    return this.#surface ? this.#surface.mentionTitleAt(pos) : null
  }

  get mentionService() { return this.#mentionService }

  /** What the host offers this editor's `/` picker, or null.
   *  @returns {object|null} */
  get commandService() { return this.#commandService }

  /** What the host offers this editor's `{` picker, or null.
   *  @returns {object|null} */
  get macroCatalog() { return this.#macroCatalog }

  /** The placement the host chose for this editor's trigger picker, or null when
   *  the surface decides for itself.
   *  @returns {import('../shell/trigger-host.js').TriggerPlacement|null} */
  get triggerPlacement() { return this.#triggerPlacement }

  /** What a code menu in this editor asks to pretty-print source, or null.
   *  @returns {object|null} */
  get codeFormattingService() { return this.#codeFormattingService }

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
   *  @returns {string} */
  get mode() { return this.#surface ? this.#surface.mode : this._defaultMode }

  /**
   * The modes this lens can be presented in. ABSTRACT: the repertoire is the
   * concrete lens's vocabulary, and `setMode` refuses any target outside it.
   * @protected
   * @returns {ReadonlyArray<string>}
   */
  get _modes() {
    throw new ContractViolation('AbstractEditor: _modes must be declared by the concrete editor type')
  }

  /**
   * The mode in force before any surface mounts. ABSTRACT, for the reason
   * `_modes` is.
   * @protected
   * @returns {string}
   */
  get _defaultMode() {
    throw new ContractViolation('AbstractEditor: _defaultMode must be declared by the concrete editor type')
  }

  /**
   * The one mode whose surface presents the container AS BLOCKS, reading the
   * model on its bootstrap cue. Every other mode of the repertoire is a verbatim
   * buffer, seeded by the container's own projection. Null for a lens that never
   * presents blocks.
   * @protected
   * @returns {string|null}
   */
  get _blockMode() { return null }

  /** @returns {unknown|null} the mounted surface's own editing engine, opaque to
   *  this class; null when no surface is mounted or the surface exposes none. */
  get editorPane() { return this.#surface ? this.#surface.editorPane : null }

  /** @returns {boolean} */
  get isDirty() { return this.#dirty }

  markDirty() { this.#dirty = true }

  clearDirty() { this.#dirty = false }

  /**
   * Registers a listener for the editor-domain event stream: the mounted
   * surface's events plus the editor's OWN mode-changed / mode-change-failed /
   * presenting-changed.
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
      document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true, uuid: this.#uuid } }))
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
   *  'markdown' for a verbatim buffer, 'block-inner' for an inner form control
   *  inside a sieve block, else 'editor'.
   *  @returns {import('./document-editor/selection-model.js').SelectionContext['focusZone']} */
  #deriveFocusZone() {
    if (this.mode !== this._blockMode) return 'markdown'
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
   * @param {string} mode
   * @returns {AbstractSurface}
   */
  _createSurface(mode) {
    throw new ContractViolation('AbstractEditor: _createSurface must be implemented by the concrete editor type')
  }

  /**
   * Presents the input surface for a mode. The ONE place surfaces are swapped.
   * @param {string} mode
   * @param {HTMLElement} rootEl  — the editor's root
   * @param {unknown}     content — surface seed (markdown string, or {body, blocks})
   * @returns {AbstractSurface} the mounted surface
   */
  presentSurface(mode, rootEl, content) {
    if (this.isMounted) this.unmount()
    const next = this._createSurface(mode)
    if (!next || typeof next.mount !== 'function' || typeof next.unmount !== 'function') {
      throw new ContractViolation('AbstractEditor: _createSurface must return a surface')
    }
    // A mount root can arrive pre-classed by a PREVIOUS editor's toggle.
    rootEl.classList.toggle('hide-ai-blocks', !this.#showAiBlocks)
    rootEl.classList.toggle('presenting', this.#presenting)
    next.mount(rootEl, content)
    next.setPresenting(this.#presenting)
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
   * Presents a mode with the seed that mode requires — the ONE way a HOST puts a
   * container on screen. Which seed a surface needs is this lens's knowledge, so
   * a caller supplies a mode and a root and nothing else: a host that also
   * supplied the content could seed a verbatim buffer with something the
   * container never said.
   *
   * A markdown projection that never arrives leaves the buffer unpresentable. A
   * container with a block tree is then presented as blocks — the shape it can
   * always be read in — and one without has nothing else to be, so the failure
   * reaches the caller.
   * @param {string} mode
   * @param {HTMLElement} rootEl — the editor's root
   * @returns {Promise<AbstractSurface>} the mounted surface
   */
  async presentMode(mode, rootEl) {
    let seed
    try {
      seed = await this.#seedFor(mode)
    } catch (err) {
      if (!this.canEditBlocks) throw err
      console.error('[editor] the container did not project its text; presenting its blocks instead', err)
      return this.presentSurface(/** @type {string} */ (this._blockMode), rootEl, null)
    }
    return this.presentSurface(mode, rootEl, seed)
  }

  /**
   * The seed a surface needs to be presented in `mode`.
   *
   * A verbatim buffer is seeded by the container's own projection — the ask that
   * also hands the container's text over to that buffer, which is why a buffer
   * surface is never presented without it. The block mode reads the model on its
   * bootstrap cue and needs no seed at all.
   *
   * REJECTS when the projection does not arrive: an unseeded verbatim buffer
   * would state that the container is empty.
   * @param {string} mode
   * @returns {Promise<string|null>}
   */
  #seedFor(mode) {
    if (mode === this._blockMode) return Promise.resolve(null)
    return this.provider.getContents()
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
   * @param {Readonly<{blockIds: ReadonlyArray<string>, orderChanged: boolean, replaced?: ReadonlyArray<string>}>} change
   */
  paint(change) {
    if (this.#reloadInProgress) return
    const surface = this.#surface
    if (!surface) return
    surface.applyContainerChange(change || { blockIds: [], orderChanged: false, replaced: [] }, this.provider)
  }

  /**
   * The contract's optional marks cue: one feature's COMPLETE set of text marks
   * for one block, replacing what is drawn for that pair. Unlike `paint` it
   * carries its answer, because marks are the host's derived reading of a block
   * and not container state there is anything to read back.
   *
   * WHICH producer's findings these are is passed through rather than judged
   * here: the surface owns the drawing, so it owns knowing which of its
   * decoration sets a feature belongs to.
   *
   * It is NOT suppressed during a load. A mark is placed by finding its quote in
   * what is drawn, so one arriving against a half-replaced document simply
   * resolves against the document that ends up there.
   * @param {string} feature
   * @param {string} blockId
   * @param {ReadonlyArray<import('../contract/container-update-listener.js').SieveTextMark>} marks
   */
  onMarksChanged(feature, blockId, marks) {
    if (this.#surface) this.#surface.setTextMarks(feature, blockId, marks || [])
    // What a producer found changes what is DRAWN, and chrome that counts what is
    // drawn — a find bar's "n of m" — has no other way to learn that the count
    // moved. The feature word is passed through, not judged: which producers a
    // listener cares about is the listener's business.
    this.#emitEvent({ type: 'marks-changed', feature: feature })
  }

  /**
   * Asks for what belongs in a marked run's place. The mark is one the surface
   * is drawing — the host resolves its anchor in the block's current text — so
   * this lens computes no position and writes nothing itself: the corrected
   * block arrives as an ordinary container change, and a run that has moved on
   * arrives as nothing.
   *
   * The surface is FLUSHED first. The host rewrites the block text it holds and
   * echoes the whole block back, so anything typed since the last debounced sync
   * must reach it before the rewrite is computed — otherwise the echo places
   * text that predates the typing, and the typing is gone.
   *
   * A container that cannot be written to this way simply does not offer the
   * verb, the way `setRawContent` treats its own.
   * @param {Record<string, any>} mark a mark from `getSelectionContext().textMarks`
   * @param {string} replacement
   */
  replaceText(mark, replacement) {
    if (!mark || !mark.blockId) return
    if (typeof this.provider.requestReplaceText !== 'function') return
    if (this.#surface) this.#surface.flushPending()
    this.provider.requestReplaceText(mark.blockId, /** @type {any} */ (mark), replacement)
  }

  #emitStats() { this.#emitEvent({ type: 'stats', ...this.stats() }) }

  /** The current document stats, DELEGATED to the active surface. A PULL seam, so
   *  a consumer arriving after the initial seed reads the current value.
   *  @returns {{ chars: number, lines: number, blockCount: number }} */
  stats() {
    return this.#surface ? this.#surface.stats() : { chars: 0, lines: 0, blockCount: 0 }
  }

  // Each find verb DELEGATES to the mounted surface, which is where the matches
  // are drawn and therefore the only place that knows where the reader stands
  // among them. Nothing here searches: the matches arrive as the host's find
  // marks, so a surface that draws none stands on nothing.

  /** @returns {{current:number,total:number}} */
  findPosition() { return this.#surface ? this.#surface.findPosition() : { current: 0, total: 0 } }

  /** @param {number} delta +1 for the next match, -1 for the previous
   *  @returns {{current:number,total:number}} */
  findStep(delta) { return this.#surface ? this.#surface.findStep(delta) : { current: 0, total: 0 } }

  /** The match the reader is standing on, as the anchor a replace is spent
   *  through — `replaceText` takes exactly this.
   *  @returns {Record<string, any>|null} */
  currentFindMark() { return this.#surface ? this.#surface.currentFindMark() : null }

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
    document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false, uuid: this.#uuid } }))
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

  /** Pastes a clipboard's text views through the mounted surface's paste path, so
   *  it produces the same document a Mod+V of a clipboard holding only them would.
   *  @param {string} text its text/plain view @param {string} [html] its text/html view
   *  @returns {Promise<'block'|'content'|'none'>} */
  pasteText(text, html) {
    return this.#surface ? this.#surface.pasteText(text, html) : Promise.resolve('none')
  }

  /** Pastes text literally at the caret of the mounted surface: no smart paste, no
   *  markdown parse. @param {string} text @returns {boolean} true when pasted */
  pastePlainText(text) {
    return this.#surface ? this.#surface.pastePlainText(text) : false
  }

  /** Places clipboard-shaped entries at the caret through the mounted surface's
   *  paste path, as a `place` paste.
   *  @param {import('../contract/container-provider.js').ContentEntry[]} entries
   *  @returns {Promise<'block'|'content'|'none'>} */
  pasteEntries(entries) {
    return this.#surface ? this.#surface.pasteEntries(entries) : Promise.resolve('none')
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
   * @param {string} target
   * @returns {Promise<boolean>} whether the mode changed
   */
  setMode(target) {
    if (!this._modes.includes(target)) return Promise.resolve(false)
    // A container with no block extension has one shape to be in — a prompt IS
    // its text.
    if (!this.canEditBlocks) return Promise.resolve(false)
    if (!this.#surface || target === this.mode) return Promise.resolve(false)
    if (this.#modeFlip) return this.#modeFlip
    this.#modeFlip = this.#flipTo(target).finally(() => { this.#modeFlip = null })
    this.#modeFlip.then(
      (changed) => { if (changed) this.#emitEvent({ type: 'mode-changed', mode: this.mode }) },
      (err) => { this.#emitEvent({ type: 'mode-change-failed', mode: this.mode, error: err }) },
    )
    return this.#modeFlip
  }

  /** Sugar over setMode: steps to the mode after the current one in the
   *  repertoire, wrapping round — with two modes, a flip.
   *  @returns {Promise<boolean>} whether the mode changed */
  toggleMode() {
    const modes = this._modes
    return this.setMode(modes[(modes.indexOf(this.mode) + 1) % modes.length])
  }

  /**
   * @param {string} target
   * @returns {Promise<boolean>}
   */
  async #flipTo(target) {
    const old = /** @type {import('./document-editor/surfaces/abstract-surface.js').AbstractSurface} */ (this.#surface)
    // Flush pending edits BEFORE the handshake so Go's shadow is current.
    old.flushPending()

    // Both directions speak WHOLE-CONTENT through the same provider.
    const provider = this.provider
    let payload
    if (target !== this._blockMode) {
      // The frontend never serialises a document; that stays Go's job.
      payload = await this.#seedFor(target)
    } else {
      // Hand the whole buffer back; Go re-parses and its blocks become the truth
      // again. That reset reaches this lens as the bootstrap cue of the new
      // surface, so nothing is passed through here.
      const buffer = old.body || ''
      if (!buffer.trim() && this.#containerHoldsContent()) {
        // Handing this over would have the container re-parse itself into
        // nothing, and this lens paint the nothing. The buffer is what is wrong,
        // so the container is not told about it and the flip does not happen.
        console.error('[editor] refusing to hand over an empty buffer: the container holds content', this.uuid)
        throw new ContractViolation('empty buffer over a container that holds content')
      }
      await provider.setContents(buffer)
      payload = null
    }

    // Success only — the swap is unreachable on timeout/error.
    this.presentSurface(target, /** @type {HTMLElement} */ (this.host), payload)
    return true
  }

  /**
   * Whether the container holds anything a whole-document buffer would have to
   * carry. Prose carries its text and an empty paragraph carries none; every
   * structured kind carries its payload in attrs and so always counts.
   *
   * A container that holds nothing is a document a reader may legitimately have
   * emptied, which is why emptiness alone is never the test.
   * @returns {boolean}
   */
  #containerHoldsContent() {
    const provider = this.provider
    for (const id of provider.getOrder()) {
      const node = provider.getBlock(id)
      if (!node) continue
      if (node.kind && node.kind !== PROSE_KIND) return true
      if (String((node.attrs && node.attrs.content) || '').trim() !== '') return true
    }
    return false
  }

  /** Toggles AI-block visibility for THIS editor, mirrored as the
   *  `hide-ai-blocks` class on the editor-owned root.
   *  @returns {boolean} whether AI blocks are now shown */
  toggleAiBlocks() {
    this.#showAiBlocks = !this.#showAiBlocks
    if (this.host) this.host.classList.toggle('hide-ai-blocks', !this.#showAiBlocks)
    return this.#showAiBlocks
  }

  /** @returns {boolean} whether THIS editor is in Presentation Mode */
  get presenting() { return this.#presenting }

  /** Toggles Presentation Mode; see setPresenting.
   *  @returns {Promise<boolean>} whether the editor is now presenting */
  togglePresentation() { return this.setPresenting(!this.#presenting) }

  /** Sets Presentation Mode for THIS editor: only the slide holding the caret
   *  is drawn, mirrored as the `presenting` class on the editor-owned root.
   *  Presenting is a view of blocks, so turning it on from a buffer flips to the
   *  block mode first; a flip that fails leaves presenting off. A document with no
   *  slide markers has nothing to present: turning on does nothing. Idempotent:
   *  exactly one 'presenting-changed' is emitted per actual change.
   *  @param {boolean} presenting
   *  @returns {Promise<boolean>} whether the editor is now presenting */
  async setPresenting(presenting) {
    const want = !!presenting
    if (want === this.#presenting) return this.#presenting
    if (want && !(this.#surface && this.#surface.hasSlideMarkers())) return false
    if (want && this.mode !== this._blockMode) {
      await this.setMode(/** @type {string} */ (this._blockMode))
      if (this.mode !== this._blockMode) return false
    }
    this.#presenting = want
    if (this.host) this.host.classList.toggle('presenting', want)
    if (this.#surface) this.#surface.setPresenting(want)
    this.#emitEvent({ type: 'presenting-changed', presenting: want })
    return want
  }

  /**
   * The ONE create path: asks the container for a new block, anchored after a
   * BLOCK ID. Callers pass a stable id or nothing, NEVER a document position.
   * `null` means the front; OMITTED, or a stale or unknown id, appends.
   * @param {string} kind
   * @param {object} [attrs]
   * @param {string|null} [afterBlockId] — a stable block id, never a position
   */
  createBlock(kind, attrs, afterBlockId) {
    attrs = attrs || {}
    // diagram default: an empty (source-less) diagram opens straight into edit mode.
    if (kind === 'diagram' && !attrs.source) attrs.mode = 'edit'
    if (!this.canEditBlocks) return
    this.provider.requestAddBlock(kind, attrs, afterBlockId)
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
    if (!this._modes.includes(mode)) return
    const painted = mode === this._blockMode
    if (painted && !this.#surface) return
    if (!this.#loadContainer) return // no loader: nothing to reload from
    this.#reloadInProgress = true
    // Pull the focus coordinate before the async load so the caret survives.
    const focus = this.getSelectionContext()
    try {
      const data = (await this.#loadContainer()) || {}
      this.seedVersion(data.version || 0)
      const surface = this.#surface
      if (painted && surface) {
        // The container model is the truth the repaint reads — the same reads
        // every cue uses, so a load and a change paint from ONE source.
        surface.paintContainer(this.provider)
        this.#reloadInProgress = false
        this.applyPosition(focus)
      } else if (surface) {
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
   * Hands over anything the surface's debounced observer is still holding, so the
   * host's copy of the text is current. It is the NARROW half of `flushSave`:
   * nothing is persisted, because a caller that is about to have Go rewrite the
   * text needs the host to hold what the reader typed, not disk to hold it.
   */
  flushEdits() {
    if (this.#surface) this.#surface.flushPending()
  }

  /**
   * Puts the caret back in the surface. Chrome that took the keyboard — a find
   * bar, a dialog — calls it on the way out; where the caret goes is the
   * surface's own answer, so nothing here says.
   */
  focus() {
    if (this.#surface) this.#surface.focusEditor()
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
