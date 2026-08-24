// @ts-check
// abstract-editor.js — base of the editor component hierarchy (P2.A, P2.B, P2.B.2).
// AbstractEditor is the stable identity for one open document's editing session:
// it owns the uuid (identity), dirty state, the save/destroy contract, and the
// document's INPUT SURFACE (a WysiwygSurface or MarkdownSurface).
//
// Mode and the TipTap handle are DERIVED from the mounted surface: there is no
// stored mode to fall out of sync, which is what makes the old torn-down-limbo
// mode-toggle state unrepresentable.
//
// ONE BUSINESS DEPENDENCY (issue #96). The editor is a LENS: it is constructed
// against a container PROVIDER — the whole of the Lens↔Host wall — and there is
// no transport in its hands, its surfaces' hands, or its renderers'. It cannot
// name a socket, a document service or a frame, because it holds no object that
// has one.
//
// INBOUND IS A SUBSCRIPTION. The editor registers as the provider's
// ContainerUpdateListener; every change to the container — its own verb's
// effect, another lens's edit, a finished AI job, the watcher — arrives as ONE
// origin-blind `onChanged({blockIds, orderChanged})`. It re-reads the named
// blocks and places the SERVER's nodes with the existing tracked-transaction
// machinery. There is no per-origin repaint path left to keep in step.
//
// OUTBOUND IS THE PROVIDER'S VERBS. Structure leaves as `request*`, in-flight
// text as `flush`, a clipboard as the `paste` query. Nothing here computes a
// document position for Go: every anchor is a BLOCK ID, and the host resolves it
// against its own follower model.
//
// Dual-use ES module (block-position.js pattern): `export` for vitest imports;
// window.* assignment happens in editor-shell.js (which re-exports this as the
// P1 `SieveEditor` name for backward compatibility).

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
 *   — the mounted container's provider: the ONE business dependency, pre-bound
 *   to one container by the host. A NoteEditor demands the block extension; a
 *   PromptEditor demands only the whole-content one. A bare construction (tests)
 *   may omit it entirely, in which case every verb is a safe no-op — callers
 *   never probe for one.
 * @property {() => Promise<{body?: string, version?: number, scroll?: number}>} [loadContainer]
 *   — the HOST's loader for this container. A whole-container LOAD is a host
 *   concern (it decides mode, and it owns the markdown body), so the editor is
 *   handed the act rather than the means: `reload()` invokes this and repaints
 *   from the model it reseeded. Absent ⇒ this editor cannot reload.
 * @property {object} [mentionService]
 *   — the session plane's `@`-picker tenant (#74 P4), handed down by the same
 *   composition root as the provider so the WYSIWYG surface can host the
 *   picker in the document (#38). OPTIONAL: without it the editor simply has no
 *   `@` picker — the affordance is absent, nothing is broken.
 */

export class AbstractEditor {
  // ── Identity + surface state ─────────────────────────────────────────────────

  /** @type {string} */
  #uuid

  /** @type {boolean} */
  #dirty = false

  /** @type {AbstractSurface|null} */
  #surface = null

  /** @type {HTMLElement|null} the editor-owned root the surfaces mount under */
  #rootEl = null

  /** @type {Array<(event: SurfaceEventMsg) => void>} surface-event registrants */
  #eventListeners = []

  /**
   * The editor-private authority on selection/caret/context OUTSIDE the surface
   * (P3.A). Fed from the surface events (selection-changed / transaction /
   * focus-changed) via #feedSelectionModel; pulled through getSelectionContext.
   * The push up to Tab/Workspace is P3.B — the model emits to its own onUpdate
   * registry only for now.
   * @type {SelectionModel}
   */
  #selectionModel

  // ── The wall (bare constructions keep these null/false) ─────────────────────

  /** @type {any} the mounted container's provider — the ONE business
   * dependency. Null in bare constructions, where every verb is a safe no-op. */
  #provider = null

  /** @type {boolean} whether this container's provider carries the BLOCK
   * extension. It replaces the old `connect` declaration: a lens's capability is
   * what its provider offers, not a flag it was handed. */
  #blockCapable = false

  /** @type {(() => Promise<{body?: string, version?: number, scroll?: number}>)|null}
   * the host's loader for this container (see AbstractEditorOptions). */
  #loadContainer = null

  /** @type {{onSelectionChanged: (ctx: any) => void}|null} the host's presence
   * seam — the one channel that flows lens→host outside the facade's verbs. */
  #selectionListener = null

  /** @type {boolean} whether this editor is currently registered as its
   * provider's ContainerUpdateListener (true only while a surface is mounted). */
  #subscribed = false

  /** @type {object|null} the `@` picker's protocol peer (#38). Held, never
   * called from here: the WYSIWYG surface hosts the picker, and this is the
   * composition root's handle reaching it. */
  #mentionService = null

  /** @type {AddressStatus|null} built on demand over the mention peer; see the
   * accessor for why it is the EDITOR that owns one. */
  #addressStatus = null

  /** @type {Promise<boolean>|null} the in-flight mode flip; reentrant setMode coalesces onto it */
  #modeFlip = null

  // ── Editor-bound command state (P2.C) ─────────────────────────────────────────

  /** @type {boolean} AI-block visibility for THIS editor (mirrored as a CSS class on the root) */
  #showAiBlocks = true

  /**
   * Set while a whole-container LOAD is mid-flight. It does two jobs, and they
   * are the same job: a save during the load would race the re-render (so
   * PromptEditor.flushSave checks isSaveSuppressed), and a container cue during
   * the load names blocks against a model that is halfway through being reset —
   * reacting to those piecemeal would author tracked edits the user never made.
   * The repaint at the end of the load is the whole answer to both.
   * @type {boolean}
   */
  #reloadInProgress = false

  /**
   * The `sieve:container-saved` subscription, kept so destroy() can drop it. A
   * torn-down editor that stayed subscribed would keep clearing dirty state for
   * a uuid it no longer presents.
   * @type {(e: Event) => void}
   */
  #onContainerSaved

  /**
   * The newest document version this editor has evidence of: seeded by the load
   * that mounted the content, raised by every `container-saved` fact for this
   * uuid. It is the baseline saveAndSettle compares against, so that a debounce
   * write already in flight when the caller asked cannot be mistaken for the
   * caller's own save. 0 means "no version known", which is also what a
   * container with no version history (every prompt) reports forever.
   * @type {number}
   */
  #version = 0

  /**
   * @param {string}                uuid    — document uuid; the editor's fixed identity
   * @param {AbstractEditorOptions} [options]
   */
  constructor(uuid, options = {}) {
    if (!uuid) throw new Error('AbstractEditor: uuid is required')
    this.#uuid = uuid
    this.#selectionModel = new SelectionModel(uuid)
    // P3.B: bridge the SelectionModel's own push onto the editor's ONE onEvent
    // stream so the Tab/Workspace republish (and editor.js's legacy fan-out, which
    // ignores the new type) receive selection updates through the same channel the
    // spec prescribes. SurfaceEventMsg is {type}-minimum, so the extra `context`
    // field is fine; the model already fires only on a meaningful change.
    this.#selectionModel.onUpdate((ctx) => {
      this.#emitEvent({ type: 'selection-update', context: ctx })
      // The presence seam: the host hears what this lens is looking at. It is
      // an ADVERT, not a request — nothing here waits for or reads an answer.
      if (this.#selectionListener) this.#selectionListener.onSelectionChanged(ctx)
    })
    this.#provider = options.provider || null
    this.#blockCapable = !!(this.#provider && typeof this.#provider.requestAddBlock === 'function')
    this.#loadContainer = options.loadContainer || null
    this.#mentionService = options.mentionService || null

    // The saved-signal, for EVERY editor type — a prompt has no channel and
    // still gets one, because the fact rides the workspace wire rather than the
    // document's. Subscribed before any surface mounts so a save that lands
    // during the initial load is not missed.
    this.#onContainerSaved = (e) => {
      const detail = /** @type {CustomEvent} */ (e).detail
      if (detail && detail.uuid === this.#uuid) this.#markSaved(Number(detail.version) || 0)
    }
    document.addEventListener('sieve:container-saved', this.#onContainerSaved)
  }

  // ── Identity + surface accessors ─────────────────────────────────────────────

  /** @returns {string} The document uuid this editor session is for. */
  get uuid() { return this.#uuid }

  /**
   * The mounted container's provider — the whole of this lens's business
   * surface. Surfaces and renderers reach their verbs through it; there is
   * nothing else to reach. Null in bare constructions.
   */
  get provider() { return this.#provider }

  /** Whether this container's provider carries the block extension (a note
   *  does; a prompt does not). @returns {boolean} */
  get canEditBlocks() { return this.#blockCapable }

  /**
   * Registers the HOST's presence listener. It flows the other way from every
   * other channel here — the host subscribes to the lens — which is why it is
   * SET on the lens rather than asked for through the provider.
   * @param {{onSelectionChanged: (ctx: any) => void}|null} listener
   */
  setSelectionListener(listener) { this.#selectionListener = listener || null }

  /** The `@` picker's protocol peer, or null in bare constructions. */
  get mentionService() { return this.#mentionService }

  /**
   * What this editor has learned about whether the coordinates its blocks
   * render still resolve — DERIVED from the mention peer exactly as
   * the provider is. Null in bare constructions:
   * with nothing to ask, a chip simply never learns its target is gone.
   *
   * IT IS OWNED HERE, not by the workspace, so its memory dies with the editor:
   * reopening a document asks again, which is how a container that came back
   * stops looking dangling. Built on demand because most editors render no
   * coordinate at all.
   * @returns {AddressStatus|null}
   */
  get addressStatus() {
    if (!this.#addressStatus && this.#mentionService) {
      this.#addressStatus = new AddressStatus(/** @type {any} */ (this.#mentionService))
    }
    return this.#addressStatus
  }

  /** @returns {AbstractSurface|null} The mounted input surface, or null. */
  get surface() { return this.#surface }

  /**
   * Current editing mode — DERIVED from the mounted surface; the subclass
   * default applies before any surface mounts.
   * @returns {EditorModeValue}
   */
  get mode() { return this.#surface ? /** @type {EditorModeValue} */ (this.#surface.mode) : this._defaultMode }

  /**
   * The pre-mount default mode. PromptEditor overrides to EditorMode.MARKDOWN (fixed).
   * @protected
   * @returns {EditorModeValue}
   */
  get _defaultMode() { return EditorMode.WYSIWYG }

  /** @returns {unknown|null} The live TipTap instance, or null (markdown / unmounted). */
  get editorPane() { return this.#surface ? this.#surface.editorPane : null }

  /** @returns {boolean} Whether the document has unsaved changes. */
  get isDirty() { return this.#dirty }

  /**
   * The editor-owned root element, for subclasses (setMode remounts into it).
   * @protected
   * @returns {HTMLElement|null}
   */
  get _rootEl() { return this.#rootEl }

  /** Marks the document dirty (unsaved changes present). */
  markDirty() { this.#dirty = true }

  /** Clears the dirty flag (called when a save is acknowledged). */
  clearDirty() { this.#dirty = false }

  // ── Surface events ───────────────────────────────────────────────────────────

  /**
   * Registers a listener for the editor-domain event stream: the mounted
   * surface's events (doc-changed / selection-changed / transaction /
   * focus-changed — see SurfaceEvent) plus the editor's OWN producer events
   * (mode-changed / mode-change-failed, emitted by the setMode flip path —
   * P2.C). This is the seed of the P3 SelectionModel stream; today its one
   * production registrant is editor.js's transitional legacy-chrome fan-out.
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
   * The Editor's SurfaceListener handler — the mounted surface FIRES its events
   * (doc-changed / selection-changed / transaction / focus-changed) here and the
   * Editor HANDLES them. P3.A: feed the SelectionModel from the event FIRST (so an
   * onEvent handler that pulls getSelectionContext() sees the fresh context), then
   * emit on the editor stream. P4.D: a doc-changed also produces a `stats` event
   * (the retired editor.js dispatchStats — now editor-owned) and marks the document
   * dirty. The retired legacyChromeFanout dispatched sieve:meta-dirty{dirty:true} on
   * doc-changed; the container-saved reaction (#markSaved) dispatches the
   * {dirty:false} counterpart + clearDirty(). Consumers: StatusBar #onDirty (the meta-dirty-dot +
   * status-bar save slot). A freshly loaded document stays green until the first
   * real edit: the initial render is suppressed at the surface, and the deferred
   * body projection that follows it reports doc-projected, which refreshes stats
   * only (issue #90).
   * @param {SurfaceEventMsg} event
   */
  onSurfaceEvent(event) {
    this.#feedSelectionModel(event)
    this.#emitEvent(event)
    const type = event && event.type
    // Both kinds of content change refresh what MEASURES the document; only an
    // authored one dirties it. doc-projected is the framework writing the server's
    // own truth into the doc (SurfaceEvent.DOC_PROJECTED) — see issue #90.
    if (type === 'doc-changed' || type === 'doc-projected') this.#emitStats()
    if (type === 'doc-changed') {
      this.markDirty()
      document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
    }
  }

  // ── Selection context (P3.A: the SelectionModel pull + subscribe) ─────────────

  /**
   * The current frozen SelectionContext — the pull path for actions that need
   * the caret/selection/block context (AI target, chrome glow, …) WITHOUT
   * reaching into PM or the DOM. Delegates to the editor-private SelectionModel,
   * fed from the surface events.
   * @returns {import('./document-editor/selection-model.js').SelectionContext}
   */
  getSelectionContext() { return this.#selectionModel.getContext() }

  /**
   * Subscribes to the SelectionModel's `selection-update` (fired on meaningful
   * change only; the frozen context is the payload). A passthrough to the
   * model's own registry — the Tab/Workspace republish of this stream is P3.B;
   * in P3.A only the editor's own tests/consumers subscribe here.
   * @param {(ctx: import('./document-editor/selection-model.js').SelectionContext) => void} fn
   * @returns {() => void} unsubscribe
   */
  onSelectionUpdate(fn) { return this.#selectionModel.onUpdate(fn) }

  /**
   * Interposes on a surface event to feed the SelectionModel: on a selection /
   * transaction / focus event, pull the surface's raw descriptor and ingest it;
   * on focus, also derive + set the focus zone (minimal for P3.A: 'block-inner'
   * when focus sits in an inner form control, else the surface's editing zone).
   * The ONE place the model is fed. Called BEFORE the legacy #emitEvent fan-out
   * so a subscriber reading getSelectionContext() in an onEvent handler sees the
   * fresh context.
   * @param {SurfaceEventMsg} event
   */
  #feedSelectionModel(event) {
    const s = this.#surface
    if (!s) return
    const t = event && event.type
    if (t === 'selection-changed' || t === 'transaction' || t === 'focus-changed') {
      const raw = s.feedSelection()
      if (raw) this.#selectionModel.ingest(raw)
    } else if (t === 'scroll-changed') {
      // issue #51: its OWN channel — never through ingest (a raw selection
      // descriptor carries no scroll field and must not be able to reset it).
      this.#selectionModel.setScroll(s.feedScroll())
    }
    if (t === 'focus-changed') {
      this.#selectionModel.setFocusZone(this.#deriveFocusZone())
    }
  }

  /**
   * Derives the focus zone from the live DOM focus + the mounted surface
   * (minimal for P3.A; refined for the Ask panel in P3.D and snapshot/restore in
   * P3.E). 'block-inner' when the active element is an inner form control inside
   * a sieve block; 'markdown' for the markdown surface; else 'editor'.
   * @returns {import('./document-editor/selection-model.js').SelectionContext['focusZone']}
   */
  #deriveFocusZone() {
    if (this.mode === EditorMode.MARKDOWN) return 'markdown'
    const active = (typeof document !== 'undefined') ? document.activeElement : null
    if (active && typeof active.closest === 'function' && active.closest('.sieve-block__edit')) {
      return 'block-inner'
    }
    return 'editor'
  }

  // ── Surface lifecycle ────────────────────────────────────────────────────────

  /**
   * Builds the input surface for a mode. ABSTRACT: the surface repertoire (which
   * surface classes this editor can present) is TYPE-DEFINING knowledge that
   * lives on the concrete editor types, alongside the channel declaration —
   * nothing outside the editor decides or constructs what lives under its root.
   * The concrete type hands the surface THIS editor (`host`) — the surface calls
   * the editor's public API directly (onSurfaceEvent / setRawContent /
   * flushSave / the insert-anchor family / reload). No services bag.
   * @protected
   * @param {EditorModeValue} mode
   * @returns {AbstractSurface}
   */
  _createSurface(mode) {
    throw new Error('AbstractEditor: _createSurface must be implemented by the concrete editor type')
  }

  /**
   * Presents the input surface for a mode: unmounts the current surface (if
   * any), asks the concrete type to build a fresh one (`_createSurface`), and
   * mounts it on the root. The ONE place surfaces are swapped — initEditor's
   * initial mount and setMode's in-place flip both land here.
   * @param {EditorModeValue} mode
   * @param {HTMLElement} rootEl  — the editor's root (today: #tiptap-mount)
   * @param {unknown}     content — surface seed (markdown string, or {body, blocks})
   * @returns {AbstractSurface} the mounted surface
   */
  presentSurface(mode, rootEl, content) {
    this.#unsubscribeFromContainer()
    if (this.#surface) this.#surface.unmount()
    this.#rootEl = rootEl
    const next = this._createSurface(mode)
    if (!(next instanceof AbstractSurface)) throw new Error('AbstractEditor: _createSurface must return an AbstractSurface')
    // A mount root can arrive pre-classed by a PREVIOUS editor's toggle — sync
    // the class to THIS editor's state so DOM and #showAiBlocks never desync.
    rootEl.classList.toggle('hide-ai-blocks', !this.#showAiBlocks)
    next.mount(rootEl, content)
    this.#surface = next
    // Subscribe AFTER the mount, because subscribing cues immediately with the
    // whole container: the surface mounts empty and the bootstrap cue paints it
    // from the model the host has already seeded. That is the ONE painting path
    // — there is no separate "initial render" to keep in step with the repaint.
    //
    // Painting the whole container is only safe HERE, at open, and that is the
    // reason this subscription is tied to the surface rather than to the editor:
    // there is no undo history yet to lose, and every later cue is a delta.
    this.#subscribeToContainer()
    // Seed the document stats for the new surface (initial present + mode flip);
    // doc-changed emits them thereafter. The retired editor.js dispatchStats seed.
    this.#emitStats()
    return next
  }

  // ── Inbound: the ONE channel (ContainerUpdateListener) ───────────────────────

  /**
   * The container changed. WHAT changed is `blockIds` (blocks that arrived,
   * changed or left) and whether the order did; WHO changed it is deliberately
   * unsayable — this lens's own verb, another lens, a finished job and the file
   * watcher all arrive here identically, so there is one repaint story rather
   * than one per origin.
   *
   * The handler re-READS: the cue names ids, and the current truth for each is
   * whatever the provider answers now. Nothing is carried in the event, so a
   * burst of cues cannot paint stale state.
   *
   * Suppressed during a host-driven load, which ends in a full repaint anyway
   * (see #reloadInProgress).
   * @param {{blockIds: ReadonlyArray<string>, orderChanged: boolean}} change
   */
  onChanged(change) {
    if (this.#reloadInProgress) return
    const surface = this.#surface
    if (!surface || !this.#provider) return
    surface.applyContainerChange(change || { blockIds: [], orderChanged: false }, this.#provider)
  }

  /** Registers this editor as its provider's update listener. Idempotent. */
  #subscribeToContainer() {
    if (this.#subscribed || !this.#provider) return
    this.#subscribed = true
    this.#provider.subscribe(this)
  }

  /** Drops the subscription so a torn-down surface is never cued. Idempotent. */
  #unsubscribeFromContainer() {
    if (!this.#subscribed || !this.#provider) return
    this.#subscribed = false
    this.#provider.unsubscribe(this)
  }

  /**
   * Emits a `stats` event on the editor stream: chars + lines from the active
   * surface's plain-text view and the top-level block count. Folds editor.js's
   * dispatchStats + getMarkdown (P4.D). The StatusBar consumer paints
   * chars/lines and the --line-digits gutter width; unsaved/saved paint rides
   * sieve:meta-dirty.
   */
  #emitStats() { this.#emitEvent({ type: 'stats', ...this.stats() }) }

  /**
   * The current document stats — DELEGATED to the active surface (which owns the
   * TipTap/buffer read; no AbstractEditor.editorPane reach here — the epic's
   * TipTap-only-in-surface discipline). A PULL seam: a consumer that points at this
   * editor AFTER the initial-present seed already emitted (the StatusBar on cold
   * boot) reads the current value instead of waiting for the next doc-changed emit.
   * #emitStats pushes exactly this shape on the `stats` event.
   * @returns {{ chars: number, lines: number, blockCount: number }}
   */
  stats() {
    return this.#surface ? this.#surface.stats() : { chars: 0, lines: 0, blockCount: 0 }
  }

  // ── Document search (D-3: SearchOverlay drives these; surface owns TipTap) ─────
  //
  // The search overlay reaches the active editor's search verbs (never a surface
  // #private or `.editorPane`); each DELEGATES to the mounted surface, mirroring
  // stats(). The Search extension + its match storage live on WysiwygSurface's
  // OWN #editor — so search stays surface-private, like every other TipTap read.
  // A surface with no search returns false; the overlay treats that as "no matches".

  /**
   * Set the search term; returns the surface's current match stats (or false).
   * @param {string} term
   * @returns {{current:number,total:number}|false}
   */
  searchTerm(term) { return this.#surface ? this.#surface.searchTerm(term) : false }

  /**
   * Advance to the next match; returns the current match stats (or false).
   * @returns {{current:number,total:number}|false}
   */
  searchNext() { return this.#surface ? this.#surface.searchNext() : false }

  /**
   * Step to the previous match; returns the current match stats (or false).
   * @returns {{current:number,total:number}|false}
   */
  searchPrev() { return this.#surface ? this.#surface.searchPrev() : false }

  /**
   * Clear the active search and return focus to the editing view.
   * @returns {false}
   */
  clearSearch() { return this.#surface ? this.#surface.clearSearch() : false }

  // ── Saved-signal reaction ────────────────────────────────────────────────────

  /**
   * This document's content reached disk: drop the dirty state and tell the
   * chrome. It runs for EVERY save — the one the user asked for, the debounce
   * autosave, a finished job's write — because they are all the same fact, and
   * the editor never learns which kind it was.
   *
   * The version only ever rises. Facts from two writers can arrive out of order
   * (a job's write and a debounce write are separate goroutines), and adopting
   * the lower of them would hand saveAndSettle a baseline older than the disk.
   * @param {number} version the version this save produced, 0 if unversioned
   */
  #markSaved(version) {
    if (version > this.#version) this.#version = version
    this.clearDirty()
    document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false } }))
    document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: this.#uuid } }))
  }

  // ── Raw-content command (the markdown surface's outbound channel) ─────────────

  /**
   * Hands the container the whole raw buffer this lens is holding — the
   * whole-content flavour of `flush`, and like every flush it always lands and
   * asks nothing. Deliberately NOT `setContents`: that one means "re-parse this,
   * the text is the document now", and a half-typed break-glass buffer is
   * exactly what must not be re-parsed. Bare constructions: no-op.
   * @param {string} raw
   */
  setRawContent(raw) {
    if (this.#provider && typeof this.#provider.flushContents === 'function') {
      this.#provider.flushContents(raw)
    }
  }

  /**
   * Requests a block extraction/transform. ABSORBS the prep the retired extract event
   * handler did (P4.F Brief C): clears any stale insert position (additive ops land
   * via insert-block at the op's own index), stamps the caller context onto the first
   * entry, resolves the target block index from `blockId` (top-level-only scan; skipped
   * for transform / undo-smart-paste, which mutate in place), and resolves the entries
   * for the target kind (sync or async) before handing the prepared payload to
   * the ContainerTransport (the wire owner frames + routes it; the shape is frozen:
   * {type:'extract', blockId, targetKind, operation, entries, index} — no uuid;
   * the server resolves the document from the channel). Disconnected editors:
   * no-op send.
   *
   * RANGE SOURCES (`sourceRange`, #67). A prose link is not a block: it is a mark
   * over a text range, so there is nothing for an in-place TRANSFORM to replace —
   * the enclosing block is the whole paragraph, and replacing THAT would destroy
   * the surrounding sentence. Its playback is instead the one the owner decided
   * on: consume the link's range, create the block after the paragraph, drop the
   * paragraph if the delete emptied it (#consumeSourceRange). That is the
   * existing additive create plus an ordinary prose edit — so the wire verb
   * becomes `extract` with the freed index, with NO new server operation. The
   * MENU keeps the user-facing verb it was offered ("Convert to …"); which wire
   * op carries it is not the user's concern. Frontend twin of Go's own
   * SupportedActions.asAdditive demotion for a source nested inside a composite.
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
      const p = this.#provider
      if (p && this.#blockCapable) p.requestTransform(blockId, targetKind, wireOp, resolved)
    })
  }

  /**
   * Consumes a RANGE SOURCE and returns the block index its replacement is
   * created at. Two ordinary TRACKED prose edits (never addToHistory:false —
   * converting a link must be one undoable step, the same UNDO SANCTITY rule
   * commitInsertIndex carries):
   *
   *   1. delete the range — the link leaves the sentence, the sentence survives;
   *   2. if that left the enclosing paragraph empty, delete the paragraph too and
   *      let the new block take its slot (so a link alone in its own paragraph —
   *      the common case after a URL paste — behaves exactly like the in-place
   *      Transform it replaces, with no blank line left behind). Never the doc's
   *      sole child: deleting that is schema-invalid.
   *
   * Then flush the block-sync so Go's shadow applies BOTH deletes before the
   * create arrives on the same socket — the ordering commitInsertIndex relies on.
   * The anchor is derived from the RANGE, not from a block id: a freshly typed
   * paragraph may not have been minted one yet.
   *
   * It computes NO index. Where the replacement lands is the host's arithmetic,
   * from the source block id the transform names; both edits below either leave
   * that block in place or remove it, and Go's own ordering across one socket
   * makes the flush below enough to keep the two in step.
   * @param {{from: number, to: number}} range
   */
  #consumeSourceRange(range) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed) return
    // Stale range (the doc moved under a slow offer round-trip) → touch nothing.
    // tr.delete THROWS out of range, and a throw here would take the whole
    // conversion with it.
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

  /**
   * Pastes plain text through the mounted surface's paste path — the entry point
   * a menu Paste calls, so it produces the same document a Mod+V of the same
   * clipboard would.
   * @param {string} text
   * @returns {Promise<'block'|'content'|'none'>}
   */
  pasteText(text) {
    return this.#surface ? this.#surface.pasteText(text) : Promise.resolve('none')
  }

  /**
   * Restores focus/selection from a SelectionContext coordinate — the WRITE side of
   * getSelectionContext (P3.E). Delegates straight to the #private surface, which
   * owns the PM/DOM (TipTap lives ONLY in the surface — no `tiptap` read here).
   * Safe no-op when no surface is mounted.
   * @param {import('./document-editor/selection-model.js').SelectionContext} ctx
   */
  applyPosition(ctx) {
    if (!this.#surface) return
    this.#surface.applyPosition(ctx)
    // issue #51: a same-session reload preserves scroll the same
    // way it preserves the caret — ctx is the PRE-reload pulled context, so a
    // null scroll (never reported yet) is correctly a no-op (applyScroll's
    // null-guard), not a forced park.
    this.#surface.applyScroll(ctx && ctx.scroll)
  }

  /**
   * Restores (or parks) the document's scroller position on a FRESH load — the
   * cross-session counterpart to applyPosition's reload-time preserve (issue
   * #51). Called once, right after the surface presents its content, with the
   * scroll offset the session had persisted for this document (0 for a
   * never-scrolled / never-seen tab, which is exactly the park-at-top floor).
   * Safe no-op when no surface is mounted.
   * @param {number} value
   */
  restoreScroll(value) {
    if (this.#surface) this.#surface.applyScroll(value)
  }

  // ── Mode flip (P2.B: the awaited in-place surface swap) ──────────────────────

  /**
   * Switches the editing mode in place with stay-on-failure semantics:
   *
   *   1. flush the current surface (pending edits reach Go's shadow first)
   *   2. send enter-markdown / enter-wysiwyg and AWAIT the markdown-content /
   *      wysiwyg-content reply (5s, the existing awaiter machinery)
   *   3. only on the reply: unmount the old surface, mount the new one with the
   *      server's payload — the mode getter flips because the surface did.
   *
   * On timeout/error the promise rejects and NOTHING was unmounted — the editor
   * stays in its current mode, fully functional. A reply arriving after the
   * timeout finds no awaiter and is dropped (never a stale mount). A reentrant
   * call while a flip is in flight coalesces onto the in-flight promise.
   * Socketless editors (PromptEditor): base no-op resolving false (mode is fixed).
   * A value not in EditorMode resolves false (the no-op family) and sends nothing.
   *
   * The EDITOR is the producer of the mode events wherever the flip happens
   * (P2.C): exactly ONE {type:'mode-changed', mode} is emitted per ACTUAL flip
   * — however many callers coalesced onto it — and ONE
   * {type:'mode-change-failed', mode, error} per failed flip. The handlers are
   * attached here, where the flip is created, so a caller that ignores the
   * promise (the native menu) never produces an unhandled rejection. No-op
   * paths emit nothing.
   * @param {EditorModeValue} target
   * @returns {Promise<boolean>} whether the mode changed
   */
  setMode(target) {
    if (target !== EditorMode.WYSIWYG && target !== EditorMode.MARKDOWN) return Promise.resolve(false)
    // A container with no block extension has one shape to be in — a prompt IS
    // its text — so there is no other mode to flip to.
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

  /**
   * BINARY-FLIP SUGAR over setMode: derives the target from the current mode
   * (EditorMode.WYSIWYG ⇄ EditorMode.MARKDOWN) and returns setMode's own
   * promise. setMode(mode) is the N-mode primitive — a future third mode adds
   * explicit setMode call sites; it does not grow this method. All flip
   * mechanics, coalescing, and the mode-changed / mode-change-failed producer
   * emissions live in setMode; no state or chrome lives here. Fixed-mode
   * editors (PromptEditor) resolve false polymorphically.
   * @returns {Promise<boolean>} whether the mode changed
   */
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
    // Flush pending edits BEFORE the handshake so Go's shadow is current
    // (wysiwyg: pending block-ops; markdown: pending whole-buffer handoff).
    old.flushPending()

    // Both directions speak WHOLE-CONTENT through the same provider — the flip is
    // one lens using both of its container's vocabularies, not two providers.
    const provider = this.#provider
    let payload
    if (target === EditorMode.MARKDOWN) {
      // The container's authoritative serialized form. The frontend never
      // serialises a document — that stays a processor's job on the Go side.
      payload = await provider.getContents()
    } else {
      // Hand the whole buffer back; Go re-parses it and the container's blocks
      // become the truth again. The reparse reaches this lens as the model reset
      // it causes, so the new surface's bootstrap cue paints from THOSE blocks
      // (ids from the markers survive) — nothing is passed through here.
      await provider.setContents(old.body || '')
      payload = null
    }

    // Success only — the swap is unreachable on timeout/error.
    this.presentSurface(target, /** @type {HTMLElement} */ (this.#rootEl), payload)
    return true
  }

  // ── Editor-bound commands (P2.C: the component API the menu/toolbar calls) ────

  /**
   * Toggles AI-block visibility for THIS editor: flips #showAiBlocks and
   * mirrors it as the `hide-ai-blocks` class on the editor-owned root element
   * (editor.css does the hiding). Editor-scoped state — no app chrome here.
   * @returns {boolean} whether AI blocks are now shown
   */
  toggleAiBlocks() {
    this.#showAiBlocks = !this.#showAiBlocks
    if (this.#rootEl) this.#rootEl.classList.toggle('hide-ai-blocks', !this.#showAiBlocks)
    return this.#showAiBlocks
  }

  /**
   * The ONE create path: asks the container for a new block of `kind`+`attrs`,
   * anchored after a BLOCK ID. Callers pass a stable id (or nothing), NEVER a
   * document position — resolving an id to a position is the host's arithmetic
   * against its own follower model, and this lens does not do it.
   *
   * When `afterBlockId` is OMITTED the anchor is DERIVED from the caret: the
   * block the caret sits in, with the empty-paragraph consume applied (see
   * #anchorFromCaret). `null` means the front of the container; a stale or
   * unknown id appends, which is also what markdown mode does — it has no
   * ProseMirror to read a caret from, so dialogs there append.
   * @param {string} kind
   * @param {object} [attrs]
   * @param {string|null} [afterBlockId] — a stable block id, never a position
   */
  createBlock(kind, attrs, afterBlockId) {
    attrs = attrs || {}
    // diagram default: an empty (source-less) diagram opens straight into edit mode.
    if (kind === 'diagram' && !attrs.source) attrs.mode = 'edit'
    if (!this.#provider || !this.#blockCapable) return
    const anchor = (afterBlockId === undefined) ? this.#anchorFromCaret() : afterBlockId
    this.#provider.requestAddBlock(kind, attrs, anchor)
  }

  /**
   * Inserts `url` at the caret as a titled hyperlink — the INLINE sibling of
   * createBlock, and the reason it is a separate verb: a link is a mark over text,
   * not a member of the document list, so there is no block to create (#67). The
   * work is the surface's (it owns the paste round-trip that fetches the title and
   * the PM insertion); this is the host-level entry point dialogs and menus call,
   * exactly as they call createBlock.
   * @param {string} url
   * @returns {Promise<boolean>} whether a link was inserted (false in a surface
   *   with no inline marks — see AbstractSurface.insertLink)
   */
  insertLink(url) {
    return this.#surface ? this.#surface.insertLink(url) : Promise.resolve(false)
  }

  /**
   * Stashes the caret's NON-consuming insert ANCHOR for an async insert that will
   * outlive the current caret. The toolbar image insert opens a file dialog which
   * blurs the editor and loses the caret, so the anchor is captured pre-dialog and
   * the upload handler passes it back (without it an uploaded image would append
   * to the end). NON-consuming: a capture must never eat the caret's empty
   * paragraph, because a cancelled upload has to leave the blank line. No-op in
   * markdown mode (no tiptap → nothing to anchor).
   * @returns {string|null|undefined} the block the upload should follow
   */
  captureImageInsert() {
    if (!this.editorPane) return undefined
    const ed = /** @type {any} */ (this.editorPane)
    return this.#anchorAtIndex(blockIndexForInsert(ed.state.doc, this.captureInsertPos()))
  }

  // ── AI job seam (P4.B/P4.E-D5: the single doc-mutation for ask + explain) ─────
  //
  // askAi is the ONE business-logic seam every AI entry point ends up at (the Ask
  // panel's send, the explain entry points). D-5: it is a PURE OPERATOR over the
  // SelectionContext the caller passes in — the context the panel LAST RENDERED
  // (the label the user saw). It NEVER re-reads the editor's live selection/target
  // on write; a live re-read would race the label (panel shows target C1, editor
  // acts on drifted C2). Everything — the answer's ref, the == highlight, and the
  // block index it lands at — derives from that passed context. Ask and explain
  // differ only by type (+ whether a question exists) and the markdown-explain
  // abort. Owns the doc mutation AND the target highlight/focus/cursor (the former
  // explain target-prep step folded in — it is one operation, not a caller pre-step).

  /**
   * The SINGLE AI-job seam. Pure over `context` (the SelectionContext the panel
   * rendered): builds the ai-block ref (Go walks the chain), applies the == target
   * highlight to `context.target.range` (the words the label named — NOT the live
   * selection), anchors the block insert AFTER the target's top-level block, flushes
   * the pending sync so Go's shadow is current, creates the ai-block, and collapses
   * the caret to the target end. EXPLAIN with no inline target (markdown) is a no-op
   * (the former target-prep abort); ASK still works in markdown.
   * @param {{ type: 'ask'|'explain', question?: string, context?: import('./document-editor/selection-model.js').SelectionContext, attachments?: Array<{uri: string, title?: string}> }} job
   *   `attachments` (#74) is the composer's manifest — addresses of other Sieve
   *   documents offered as context for THIS turn. It is a plain attr on the
   *   ai-block; `ref` (the document-local chain) is untouched by it.
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
    // Anchor the AI block AFTER the target's LAST block, using the context's block ids
    // (what the panel resolved) — NOT the live selection. This is a PURE context read
    // (no `ed` needed): createBlock owns the id→index resolution, so the anchor is
    // immune to a caret that drifted after the label rendered AND to NodeSelection
    // boundary ambiguity (an ai-block follow-up). A miss/no-anchor appends. Markdown
    // has no block ids → anchorId undefined → createBlock caret-derives (-1 append).
    const ids = (ctx.blockIds && ctx.blockIds.length) ? ctx.blockIds : (ctx.blockId ? [ctx.blockId] : [])
    const anchorId = ids[ids.length - 1]
    if (ed) {
      // Highlight the TARGET the panel showed (context.target.range) — protocol-
      // significant (the == mark tells Go which words the answer is about). Only a
      // ranged wysiwyg selection marks; a block/document target carries no == extent.
      if (target && target.kind === 'selection' && this.mode !== EditorMode.MARKDOWN && target.range) {
        applyTargetHighlight(ed, target.range)
      }
      ed.commands.focus()
    }
    const done = this.flushSave()
      .then(() => {
        const attrs = /** @type {Record<string, any>} */ ({ type: blockType, ref: ref, question: question || '' })
        // Absent IS the empty case (Go's InitAttrs deletes an empty list), so an
        // attachment-less ask puts exactly the bytes on the wire it always did.
        if (attachments && attachments.length) attrs.attachments = attachments
        this.createBlock('ai-block', attrs, anchorId)
      })
      .catch((err) => { console.error('[editor] askAi flush error:', err) })
    // Editor owns its cursor: collapse focus to the target end (right where the
    // answer lands) — the former Ask-panel post-send hop, folded into the seam.
    if (ed && ed.view) {
      try { ed.commands.setTextSelection(ed.state.selection.to) } catch (e) { /* best-effort */ }
    }
    return done
  }

  // ── Insert anchors (where a new block goes, said in BLOCK IDS) ────────────────
  //
  // A lens never computes a document position for Go. What it knows is WHICH
  // BLOCK the new one should follow, and the host turns that into a position
  // against its own follower model. Everything here is the translation between
  // the two things the lens genuinely has — a caret, or a drop coordinate — and
  // the one thing the wall accepts: an anchor id.
  //
  // The vocabulary is three-valued, and the three values are different
  // statements: `undefined` = "no anchor, append"; `null` = "the front"; an id =
  // "after that one".

  /**
   * captureInsertPos resolves WHERE the next inserted block goes, the single way
   * every additive creation path stamps the insert position (D-r.7). Delegates to
   * the shared blockInsertPos helper so block answers always land after the top-
   * level block (never at the caret — there is no block-path inline creation).
   * @returns {number|null}
   */
  captureInsertPos() {
    const ed = /** @type {any} */ (this.editorPane)
    return ed ? blockInsertPos(ed.state) : null
  }

  /**
   * The block id a new child taking top-level index `index` should follow.
   * Walks BACK past any node with no id — a doc can hold one, the trailing
   * editing surface, and it is not a block Go knows about, so it cannot anchor
   * anything.
   * @param {number} index @returns {string|null|undefined}
   */
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
   * commitAnchor — maps a captured insert position to the anchor a new block
   * should follow, applying the empty-paragraph placement rule AT COMMIT TIME
   * (never at capture: a cancelled dialog must not eat the blank line). If the
   * position sits in a bare empty paragraph, delete it as an ordinary tracked
   * prose edit (the block-sync emits the same delete-block op a backspace would),
   * flush the sync so Go's shadow applies the delete BEFORE the create arrives on
   * the same socket, and anchor the new block where that paragraph was.
   *
   * UNDO SANCTITY: the empty-paragraph delete is a PLAIN TRACKED prose edit —
   * NEVER addToHistory:false, never a reload. Do not touch its tracked-ness.
   * @param {number|null} pos
   * @returns {string|null|undefined}
   */
  #commitAnchor(pos) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed) return undefined
    const anchor = emptyParagraphAnchor(ed.state.doc, pos)
    if (!anchor) return this.#anchorAtIndex(blockIndexForInsert(ed.state.doc, pos))
    // Sole-block doc: keep the paragraph (deleting the doc's only child is
    // schema-invalid) — it simply becomes the paragraph after the new block.
    if (ed.state.doc.childCount > 1) {
      ed.view.dispatch(ed.state.tr.delete(anchor.from, anchor.to))
      if (this.#surface) this.#surface.flushPending()
    }
    return this.#anchorAtIndex(anchor.index)
  }

  /**
   * The caret-derived anchor: capture at the caret as a BLOCK and commit (with
   * the empty-paragraph consume). The default anchor for createBlock; exists so
   * callers never touch the capture+commit composition directly.
   * @returns {string|null|undefined}
   */
  #anchorFromCaret() { return this.#commitAnchor(this.captureInsertPos()) }

  /**
   * The caret-derived anchor, for a surface that creates blocks of its own (a
   * multi-block slice paste). The public face of #anchorFromCaret.
   * @returns {string|null|undefined}
   */
  insertAnchorForBlock() { return this.#anchorFromCaret() }

  /**
   * Commit an EXPLICIT position (a drop coordinate) to an anchor.
   * @param {number} pos @returns {string|null|undefined}
   */
  insertAnchorAt(pos) { return this.#commitAnchor(pos) }

  // ── Deferred empty-paragraph consume (issue #33: the SMART-PASTE / DROP path) ──
  //
  // #commitAnchor above eats the empty-paragraph anchor EAGERLY — right for the
  // dialog / createBlock path, whose call point IS the confirmation. But a paste
  // commits BEFORE it knows the server matched a block: when Go reports no match
  // (plain external text claims no processor), the eager delete has already
  // remapped the orphaned caret into the adjacent code:true block, so the
  // no-match fallback's insertContent() prepends the text INSIDE that block.
  // Split the composition: peek without touching the doc, ask Go, and consume the
  // paragraph ONLY on the `block` outcome — on any other outcome (a `content`
  // fragment for the caret, `none`, or an error) the blank line and caret stay
  // put and the insert lands there, exactly like a native paste.
  //
  // The paragraph being held open is a PLACEHOLDER, not an identity: it is a
  // position the paste may or may not claim. That is why it stayed its own
  // mechanism when block identity stopped needing one.

  /**
   * peekInsertAnchor — the SIDE-EFFECT-FREE half of the empty-paragraph placement
   * rule. Returns the anchor the new block should follow, plus a HANDLE to the
   * empty paragraph to consume LATER once the server confirms a match — or a null
   * handle when there is no empty paragraph to hold (or the doc's sole child,
   * which #commitAnchor also keeps: deleting the only child is schema-invalid).
   * Unlike #commitAnchor it dispatches NOTHING.
   * @param {number|null} pos
   * @returns {{ afterBlockId: string|null|undefined, anchor: {id: string}|null }}
   */
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
    // precedes it — the same slot #commitAnchor would have freed.
    return { afterBlockId: this.#anchorAtIndex(anchor.index), anchor: id ? { id: id } : null }
  }

  /**
   * peekInsertAnchorForBlock — the caret-derived peek (smart-paste). The
   * non-consuming mirror of the caret anchor.
   * @returns {{ afterBlockId: string|null|undefined, anchor: {id: string}|null }}
   */
  peekInsertAnchorForBlock() { return this.peekInsertAnchor(this.captureInsertPos()) }

  /**
   * peekInsertAnchorAt(pos) — peek an EXPLICIT position (a drop coordinate).
   * @param {number} pos
   * @returns {{ afterBlockId: string|null|undefined, anchor: {id: string}|null }}
   */
  peekInsertAnchorAt(pos) { return this.peekInsertAnchor(pos) }

  /**
   * consumeInsertAnchor — the DEFERRED second half: once the server has CONFIRMED
   * the block insert (the `block` paste outcome), delete the empty paragraph that
   * was holding its place, as an ordinary TRACKED prose edit (block-sync emits the
   * same delete-block op a backspace would) and flush so Go's shadow drops it. The
   * paragraph is located BY ID — never by a captured position: the arrival can
   * shift positions before this runs. No-op when the handle is absent (the
   * no-match / error path never calls this), not found, the doc's sole child, or
   * no longer empty (the user typed into it before the answer came — never
   * destroy content).
   *
   * UNDO SANCTITY: a PLAIN TRACKED delete — never addToHistory:false, never a
   * reload (mirrors #commitAnchor's guard).
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
    // Guard: only ever consume a still-empty paragraph. If the user typed into the
    // blank line between the paste and the answer, leave it — a stray blank line is
    // benign; losing typed content is not.
    if ((/** @type {any} */ (node).textContent || '').trim() !== '') return
    ed.view.dispatch(ed.state.tr.delete(pos, pos + (/** @type {any} */ (node).nodeSize)))
    if (this.#surface) this.#surface.flushPending()
  }

  // ── Whole-container reload ────────────────────────────────────────────────────

  /**
   * @returns {boolean} whether a save should be suppressed (a whole-container
   * load is mid-flight; a save now would race the re-render).
   */
  isSaveSuppressed() { return this.#reloadInProgress }

  /**
   * Re-reads the whole container from disk and repaints, preserving the caret.
   * ONLY for genuine LOADS (an AI whole-document answer, a restore) — NEVER for
   * an ordinary change, which arrives as a cue and is placed as a tracked
   * transaction. A whole repaint is `addToHistory:false` by construction and so
   * WIPES UNDO HISTORY; that is acceptable for a load and never for an operation
   * (CLAUDE.md).
   *
   * The load itself is the HOST's (options.loadContainer): it decides what
   * loading this container means, and the model it reseeds is the host's. What
   * belongs here is the pair either side of it — hold the cues while the model is
   * mid-reset, and paint once at the end from what it now holds.
   * @returns {Promise<void>}
   */
  async reload() {
    const mode = this.mode
    if (mode !== 'wysiwyg' && mode !== 'markdown') return
    if (mode === 'wysiwyg' && !this.editorPane) return
    if (!this.#loadContainer) return // no loader: nothing to reload from
    this.#reloadInProgress = true
    // Pull the focus coordinate before the async load so the caret survives the
    // repaint (a transform, an AI answer resolving, a restore).
    const focus = this.getSelectionContext()
    try {
      const data = (await this.#loadContainer()) || {}
      this.seedVersion(data.version || 0)
      const surface = this.#surface
      if (mode === 'wysiwyg' && this.editorPane && surface && this.#provider) {
        // The container model is the truth the repaint reads — the same reads
        // every cue uses, so a load and a change paint from ONE source.
        surface.paintContainer(this.#provider)
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

  // ── Save ─────────────────────────────────────────────────────────────────────

  /**
   * Flushes any pending debounced edit immediately so Go has the latest content
   * (surface-owned: wysiwyg block-sync / markdown doc-update), then asks Go to
   * persist. Both halves are FIRE-AND-FORGET: the save answers no request, it
   * announces itself as `container-saved`, which #markSaved reacts to. The
   * returned promise is already settled, and exists only so a caller can chain
   * work after the frames are on the wire — Go serves one socket's frames in
   * order, so what it sends next runs after this save. PromptEditor overrides
   * this with the service's HTTP save path, which genuinely is awaited.
   * @returns {Promise<unknown>}
   */
  flushSave() {
    const s = this.#surface
    if (s) s.flushPending()
    if (this.#provider && typeof this.#provider.requestPersist === 'function') {
      this.#provider.requestPersist()
    }
    return Promise.resolve()
  }

  /**
   * Seeds the version this editor knows its content to be at, from the load that
   * mounted that content. Without it the FIRST saveAndSettle of an editor's life
   * has no baseline and would settle on any fact at all, including one for a
   * write that predates the ask.
   * @param {number} version 0 for a container that keeps no version history
   */
  seedVersion(version) {
    this.#version = Number(version) || 0
  }

  /**
   * Saves, and resolves when the save LANDS — this uuid's `container-saved`
   * fact, not the request that provoked it. The one caller that needs this is
   * work performed ELSEWHERE on what is on disk (filing, which rides the
   * workspace wire): frames on two different sockets have no order between
   * them, so "I sent a flush" is not "the bytes are down".
   *
   * "Lands" means a version NEWER than the one this editor already knew. A
   * uuid match alone is not enough: a debounce write can already be in flight
   * when the caller asks, and its fact would settle the wait against bytes that
   * do not include the edits being flushed here. The one container that cannot
   * offer that evidence is an unversioned one — a prompt is a plain file with no
   * metadata, so its facts report version 0 — and for it the uuid is the whole
   * signal, leaving the in-flight-debounce window open. That window is empty in
   * practice: a prompt has no shadow and therefore no debounce timer; its only
   * writer is the HTTP save this very call makes.
   *
   * The wait always RESOLVES, never rejects: a save the guard refused announces
   * nothing, and the caller is better off proceeding late than not at all.
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

  // ── Teardown ─────────────────────────────────────────────────────────────────

  /**
   * Tears the editor session down: unmounts the surface and closes the
   * document's live channel via the service (no reconnect). Subclasses that
   * extend destroy() must call super.destroy().
   */
  destroy() {
    if (this.#surface) {
      this.#surface.unmount()
      this.#surface = null
    }
    this.#rootEl = null
    document.removeEventListener('sieve:container-saved', this.#onContainerSaved)
    this.#selectionListener = null
    // The provider is the HOST's; the mount that made it is what closes the
    // container's channel and discards its model. A lens hands back only what it
    // took: the subscription.
    this.#unsubscribeFromContainer()
  }
}
