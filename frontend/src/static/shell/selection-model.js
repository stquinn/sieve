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
 * @property {AiTarget} target                                    resolved AI target + its friendly label (P3.C; ALWAYS present)
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
      target: DOCUMENT_TARGET,
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
      target: c.target,
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
      // target is surface-resolved (P3.C); default to the document target when a
      // descriptor omits it (e.g. a 'none' feed), so `target` is ALWAYS present.
      target: raw.target ? {
        kind: raw.target.kind,
        ref: raw.target.ref,
        range: raw.target.range ? { from: raw.target.range.from, to: raw.target.range.to } : null,
        label: raw.target.label,
      } : DOCUMENT_TARGET,
    })
  }

  /**
   * Deep-freezes a context: the object, its nested `range`, its `blockIds` array,
   * and its `target` (+ the target's nested `range`) — so a holder can't mutate any
   * part of a pulled/emitted snapshot.
   * @param {SelectionContext} ctx
   * @returns {Readonly<SelectionContext>}
   */
  static #freeze(ctx) {
    if (ctx.range) Object.freeze(ctx.range)
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
