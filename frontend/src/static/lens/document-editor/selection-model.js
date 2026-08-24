// @ts-check
// selection-model.js — the editor-private authority on selection/caret/context
// OUTSIDE the surface (P3.A core). One SelectionModel per AbstractEditor: it
// owns a single frozen SelectionContext, ingests PLAIN raw descriptors the
// surface produces (never a PM node — the PM/DOM split is insulated inside the
// surface), coalesces caret-only noise, exposes a pull (getContext), and emits
// on meaningful/identity change only.
//
// The context is a COORDINATE, not editor-state: mode is excluded, there is no
// generation counter (docUuid is the staleness guard), and caret/range always
// ride current in the pulled/emitted snapshot even when they didn't trigger a
// push. A caret-only move within the same block updates #current silently — it
// is pullable, not pushed.
//
// SelectionModel is editor-private per the component spec: no window.* handle.
// Dual-use ES module only insofar as vitest `import`s it; the app reaches it
// solely through AbstractEditor (which owns the instance + the pull path).
//
// COORDINATE CONVENTION (P3.E): `caret`/`range` are the DOCUMENT coordinate — they
// pick the block AND the position within it. Restoring focus into a code block's
// source, a diagram's source, prose — anything editable — rides `caret`/`range`,
// because EVERY current Sieve block edits through ProseMirror (its edit pane is a PM
// contentDOM `<pre><code>`), so its inner caret IS a PM position PM already tracks.
//
// `blockCursor` is a FORWARD SEAM, not an active field: it exists to carry the caret
// inside a block whose editor is NOT ProseMirror — a separate control PM can't see
// into (a raw <textarea>, a CodeMirror/terminal/canvas, opted in via the
// `.sieve-block__edit` form-control convention or `host.__sieveFocus`). NO block is
// built that way today, so NOTHING populates it and it is `null` in practice. It is
// kept as the documented extension point (see WysiwygSurface#captureBlockCursor);
// when a genuine non-PM inner editor ever ships, it plugs in here with a real
// consumer. The model treats it as OPAQUE inert data (never inspected, carried +
// frozen) and CARET-LIKE (excluded from the meaningful diff). The symmetric WRITE
// side is Workspace.setPosition → editor.applyPosition → surface.applyPosition (each
// surface restores in its own applyPosition — WysiwygSurface the doc caret/range,
// MarkdownSurface the textarea; the block-inner branch is the dormant seam).

/**
 * @typedef {Object} AiTarget — the resolved AI target, editor-generated, plain values (NO PM node)
 * @property {'block'|'selection'|'document'} kind                what Ask AI acts on
 * @property {string} ref                                         block id / ref chain / 'doc'
 * @property {{from:number,to:number}|null} range                 target extent (null for a document target)
 * @property {string} label                                       finished friendly display noun/snippet (ALWAYS populated; rich sieve labels preserved)
 */

/** The coherent 'none'/initial target: nothing selected ⇒ Ask targets the document. */
const DOCUMENT_TARGET = Object.freeze({ kind: 'document', ref: 'doc', range: null, label: 'Document' })

/**
 * @typedef {Object} SelectionContext — frozen; the one authority on editor selection/caret/context OUTSIDE the surface
 * @property {string} docUuid                                     which document (also the staleness guard)
 * @property {'none'|'caret'|'range'|'block'} selectionType       nothing / cursor / ranged / whole-block NodeSelection
 * @property {number|null} caret                                  cursor (selection head) position; null when 'none'
 * @property {{from:number,to:number}|null} range                 extent (from===to for a caret); null when 'none'
 * @property {string|null} selectedText                           raw selected text when selectionType==='range', else null
 * @property {string|null} blockId                                primary block the cursor/selection sits in/on
 * @property {string[]}    blockIds                               all blocks the range spans (⊇ [blockId]); [] when 'none'
 * @property {string|null} blockKind                              primary block kind (plain string; replaces node.type reads)
 * @property {string|null} ref                                    block ref/anchor (ai-block re-chain); replaces node.attrs.ref
 * @property {'editor'|'block-inner'|'ask'|'markdown'|'outside'} focusZone   doc selection persists across 'ask'
 * @property {object|null} blockCursor                            FORWARD SEAM (P3.E): the caret inside a block whose editor is NOT ProseMirror. NO current block populates it — every Sieve edit pane is a PM contentDOM, so its inner caret is already `caret`/`range`. `null` in practice; kept as the documented extension point for a future non-PM inner editor. OPAQUE + CARET-LIKE (excluded from the meaningful diff). See the module CONVENTION.
 * @property {AiTarget} target                                    resolved AI target + its friendly label (P3.C; ALWAYS present)
 * @property {number|null} scroll                                 the surface's scroller position (issue #51): CARET-CLASS like blockCursor — excluded from the meaningful diff, updated SILENTLY via `setScroll` (never through `ingest`, so an unrelated caret move can't stomp it). Pullable (Workspace persists it to session.json at tab-deactivation/teardown), never pushed — pure scrolling must never broadcast a selection-update. `null` until the surface's first debounced report.
 */

/**
 * A raw selection descriptor a surface hands to `ingest`: PLAIN data only (no PM
 * node, no DOM). The surface classifies `selectionType` (it alone knows the PM
 * shape); the model trusts it. docUuid + focusZone are the model's to own and
 * are ignored/overwritten if present on a descriptor. `target` is surface-resolved
 * (P3.C) — the model just freezes it through.
 * @typedef {Object} RawSelectionDescriptor
 * @property {'none'|'caret'|'range'|'block'} [selectionType]
 * @property {number|null} [caret]
 * @property {{from:number,to:number}|null} [range]
 * @property {string|null} [selectedText]
 * @property {string|null} [blockId]
 * @property {string[]}    [blockIds]
 * @property {string|null} [blockKind]
 * @property {string|null} [ref]
 * @property {object|null} [blockCursor]
 * @property {AiTarget} [target]
 */

/** Keys whose change is MEANINGFUL (a push): identity/context, not the caret coordinate. */
const MEANINGFUL_KEYS = Object.freeze([
  'selectionType', 'blockId', 'selectedText', 'blockKind', 'ref', 'focusZone',
])

export class SelectionModel {
  /** @type {string} */
  #docUuid

  /** @type {Readonly<SelectionContext>} */
  #current

  /** @type {Array<(ctx: Readonly<SelectionContext>) => void>} */
  #listeners = []

  /**
   * @param {string} docUuid — the owning editor's document uuid; the staleness
   *   guard, injected into every emitted/pulled context and never overwritten.
   */
  constructor(docUuid) {
    if (!docUuid) throw new Error('SelectionModel: docUuid is required')
    this.#docUuid = docUuid
    this.#current = SelectionModel.#freeze({
      docUuid: docUuid,
      selectionType: 'none',
      caret: null,
      range: null,
      selectedText: null,
      blockId: null,
      blockIds: [],
      blockKind: null,
      ref: null,
      focusZone: 'editor',
      blockCursor: null,
      target: DOCUMENT_TARGET,
      scroll: null,
    })
  }

  /**
   * The current frozen selection context. This is the pull path
   * (`editor.getSelectionContext()` delegates here); caret/range are always
   * live here even after a coalesced (non-emitting) caret move.
   * @returns {Readonly<SelectionContext>}
   */
  getContext() { return this.#current }

  /**
   * Ingests a raw descriptor from the surface: normalizes + freezes it into a
   * full SelectionContext (docUuid + current focusZone injected), always stores
   * the result (so caret/range stay live for pull), and emits `selection-update`
   * ONLY when a meaningful key changed. A caret-only move updates silently.
   * @param {RawSelectionDescriptor} raw
   */
  ingest(raw) {
    const next = this.#normalize(raw || {}, this.#current.focusZone)
    this.#commit(next)
  }

  /**
   * Sets the focus zone from the editor's focus channel. A zone change IS
   * meaningful (the block glow depends on it) → rebuild #current with the new
   * zone (carrying the current selection coordinates) and emit. Same zone: no-op.
   * @param {SelectionContext['focusZone']} zone
   */
  setFocusZone(zone) {
    if (zone === this.#current.focusZone) return
    const c = this.#current
    const next = SelectionModel.#freeze({
      docUuid: this.#docUuid,
      selectionType: c.selectionType,
      caret: c.caret,
      range: c.range,
      selectedText: c.selectedText,
      blockId: c.blockId,
      blockIds: c.blockIds,
      blockKind: c.blockKind,
      ref: c.ref,
      focusZone: zone,
      blockCursor: c.blockCursor,
      target: c.target,
      scroll: c.scroll,
    })
    this.#commit(next)
  }

  /**
   * Silently updates the scroll coordinate (issue #51): rebuilds #current with
   * every OTHER field carried through unchanged (mirrors setFocusZone's shape),
   * so this is the only way scroll ever changes — `ingest` never touches it (a
   * caret-only move must not stomp the last-known scroll). Same value: no-op.
   * Routes through #commit like every other write, but scroll is NOT a
   * MEANINGFUL_KEYS member, so #commit's diff never sees it and never emits —
   * pullable, not pushed, exactly the P3.A blockCursor pattern.
   * @param {number|null} value
   */
  setScroll(value) {
    if (value == null || value === this.#current.scroll) return
    const c = this.#current
    const next = SelectionModel.#freeze({
      docUuid: this.#docUuid,
      selectionType: c.selectionType,
      caret: c.caret,
      range: c.range,
      selectedText: c.selectedText,
      blockId: c.blockId,
      blockIds: c.blockIds,
      blockKind: c.blockKind,
      ref: c.ref,
      focusZone: c.focusZone,
      blockCursor: c.blockCursor,
      target: c.target,
      scroll: value,
    })
    this.#commit(next)
  }

  /**
   * Registers a listener for `selection-update` (fired only on a meaningful
   * change; the frozen context is the payload). Mirrors AbstractEditor.onEvent:
   * returns an unsubscribe. Listener exceptions are isolated (try/catch), like
   * AbstractEditor.#emitEvent.
   * @param {(ctx: Readonly<SelectionContext>) => void} fn
   * @returns {() => void} unsubscribe
   */
  onUpdate(fn) {
    this.#listeners.push(fn)
    return () => { this.#listeners = this.#listeners.filter((l) => l !== fn) }
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /**
   * Stores the new frozen context and emits iff a meaningful key changed against
   * the previous one. Always stores (caret/range stay live for pull).
   * @param {Readonly<SelectionContext>} next
   */
  #commit(next) {
    const changed = SelectionModel.#meaningfulDiff(this.#current, next)
    this.#current = next
    if (changed) this.#emit(next)
  }

  /** @param {Readonly<SelectionContext>} ctx */
  #emit(ctx) {
    for (const fn of this.#listeners) {
      try { fn(ctx) } catch (e) { console.error('[selection-model] onUpdate listener threw', e) }
    }
  }

  /**
   * Normalizes a raw descriptor into a full frozen SelectionContext: injects the
   * owned docUuid + the current focusZone, and fills every field with a defined
   * default so the context shape is total. The surface owns selectionType — the
   * model trusts it (surface-agnostic).
   * @param {RawSelectionDescriptor} raw
   * @param {SelectionContext['focusZone']} focusZone
   * @returns {Readonly<SelectionContext>}
   */
  #normalize(raw, focusZone) {
    const selectionType = raw.selectionType || 'none'
    const range = raw.range ? { from: raw.range.from, to: raw.range.to } : null
    return SelectionModel.#freeze({
      docUuid: this.#docUuid,
      selectionType: selectionType,
      caret: (raw.caret === undefined) ? null : raw.caret,
      range: range,
      selectedText: (raw.selectedText === undefined) ? null : raw.selectedText,
      blockId: (raw.blockId === undefined) ? null : raw.blockId,
      blockIds: Array.isArray(raw.blockIds) ? raw.blockIds.slice() : [],
      blockKind: (raw.blockKind === undefined) ? null : raw.blockKind,
      ref: (raw.ref === undefined) ? null : raw.ref,
      focusZone: focusZone,
      // The block's own inner cursor (opaque, block-owned, caret-like). Carried
      // through untouched; excluded from the meaningful diff (a change to it alone
      // is silent). Null for a plain prose caret.
      blockCursor: (raw.blockCursor == null) ? null : raw.blockCursor,
      // target is surface-resolved (P3.C); default to the document target when a
      // descriptor omits it (e.g. a 'none' feed), so `target` is ALWAYS present.
      target: raw.target ? {
        kind: raw.target.kind,
        ref: raw.target.ref,
        range: raw.target.range ? { from: raw.target.range.from, to: raw.target.range.to } : null,
        label: raw.target.label,
      } : DOCUMENT_TARGET,
      // scroll is NEVER carried on a selection descriptor — it rides its OWN
      // channel (setScroll). Always carry the CURRENT value through so an
      // unrelated caret/selection ingest can't stomp the last-known scroll.
      scroll: this.#current.scroll,
    })
  }

  /**
   * Deep-freezes a context: the object, its nested `range`, its `blockCursor` token,
   * its `blockIds` array, and its `target` (+ the target's nested `range`) — so a
   * holder can't mutate any part of a pulled/emitted snapshot.
   * @param {SelectionContext} ctx
   * @returns {Readonly<SelectionContext>}
   */
  static #freeze(ctx) {
    if (ctx.range) Object.freeze(ctx.range)
    if (ctx.blockCursor) Object.freeze(ctx.blockCursor)
    Object.freeze(ctx.blockIds)
    if (ctx.target) {
      if (ctx.target.range) Object.freeze(ctx.target.range)
      Object.freeze(ctx.target)
    }
    return Object.freeze(ctx)
  }

  /**
   * True iff a MEANINGFUL key differs between two contexts (identity/context —
   * NOT caret/range, which are coordinate noise). blockIds is compared by
   * array-equality (same members, same order); the scalar keys by ===.
   * @param {Readonly<SelectionContext>} a
   * @param {Readonly<SelectionContext>} b
   * @returns {boolean}
   */
  static #meaningfulDiff(a, b) {
    for (const k of MEANINGFUL_KEYS) {
      if (a[k] !== b[k]) return true
    }
    return !SelectionModel.#sameIds(a.blockIds, b.blockIds)
  }

  /** @param {string[]} a @param {string[]} b @returns {boolean} */
  static #sameIds(a, b) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
}
