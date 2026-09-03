// @ts-check
// The client's follower model of ONE container.
//
// It is a FOLD over the wire shapes that already exist: the load answer is the
// initial state, and the document channel's render-backs maintain it. There is no
// serialized-container frame and deliberately no optimistic apply path — Go
// leads, this follows, and an intent shows up here only as the effect Go echoed
// back.
//
// Reads hand out frozen deep COPIES. That is not defensiveness about callers: the
// same contract has to survive being served across a process boundary later,
// where a reference is not a thing that can be returned.

import { ContractViolation } from '../contract/sieve-block.js'
import { DocumentFrame } from '../generated/protocol.js'

/**
 * One child of the container, as JSON-shaped data.
 *
 * `text` is the block's own SERIALIZED form, present only when Go volunteered it,
 * which it does on a create. Deriving it is a processor's job on the Go side, so
 * there is no client path to it and no way to refresh it. Its one consumer is a
 * WHOLE-CONTENT lens: while a verbatim buffer is the authority, a block arriving
 * has to reach the BUFFER or it is lost by both the save and the flip back, and
 * this is the only projection of a single block that exists. It is a field rather
 * than an attr because it is not part of the block's state — nothing patches it,
 * and it must never travel back.
 *
 * @typedef {object} BlockNode
 * @property {string} id
 * @property {string} kind
 * @property {Record<string, any>} attrs  the opaque kind payload; carries `id`
 * @property {string} [text]  the block's serialized form, when Go volunteered it
 */

/**
 * What changed in one fold step. contract/container-update-listener.js holds
 * the semantics of every field.
 *
 * @typedef {object} ContainerChange
 * @property {ReadonlyArray<string>} blockIds  ids whose node arrived, changed or left
 * @property {boolean} orderChanged
 * @property {ReadonlyArray<string>} replaced  ids whose node this fold replaced whole
 */

/**
 * What a lens implements to consume container state. `onMarksChanged` is
 * optional; contract/container-update-listener.js holds the semantics of both.
 *
 * @typedef {import('../contract/container-update-listener.js').SieveTextMark} SieveTextMark
 *
 * @typedef {object} ContainerUpdateListener
 * @property {(change: Readonly<ContainerChange>) => void} onChanged
 * @property {((feature: string, blockId: string, marks: ReadonlyArray<Readonly<SieveTextMark>>) => void)} [onMarksChanged]
 */

/**
 * The load answer this model seeds from — `load-content` / `wysiwyg-content` read
 * as data.
 *
 * @typedef {object} ContainerContent
 * @property {string} [uuid]  empty when Go found nothing, which seeds an empty container
 * @property {Array<{id?: string, kind?: string, attrs?: Record<string, any>}>} [blocks]
 */

// A block arriving without a kind is a WYSIWYG block, and the surface's own
// default for one is 'code'. Two independent defaults for the same absent field
// would put a differently-shaped block on each side of the same wire.
const DEFAULT_BLOCK_KIND = 'code'

export class ContainerModel {
  /** @type {string} */ #uuid
  /** @type {string} */ #kind
  /** @type {string[]} */ #order = []
  /** @type {Map<string, Readonly<BlockNode>>} */ #nodes = new Map()
  /** @type {Map<string, Map<string, ReadonlyArray<Readonly<SieveTextMark>>>>} feature →
   *  blockId → what that producer found in the block's text. Server-pushed and
   *  never computed here, replaced whole per (feature, block), and kept for ids
   *  this container does not (yet) hold: a mark set can outrun the load answer
   *  that names its block, and dropping it would lose a mark nothing would push
   *  again.
   *
   *  KEYED BY FEATURE FIRST: two producers reading the same block are two
   *  independent answers, and each replaces only its own. */
  #marks = new Map()
  /** @type {Set<ContainerUpdateListener>} */ #listeners = new Set()

  /**
   * @param {string} uuid
   * @param {string} [kind]  the container's kind as a DATA word ('note' today);
   *   affordances read it, nothing subclasses on it
   */
  constructor(uuid, kind = 'note') {
    if (!uuid) throw new ContractViolation('ContainerModel: uuid is required')
    this.#uuid = uuid
    this.#kind = kind || 'note'
  }

  /** @returns {string} */
  getUuid() { return this.#uuid }

  /** @returns {string} */
  getKind() { return this.#kind }

  /** @returns {ReadonlyArray<string>} the child ids in container order */
  getOrder() { return Object.freeze(this.#order.slice()) }

  /** @param {string} id @returns {Readonly<BlockNode>|null} */
  getBlock(id) {
    const node = id ? this.#nodes.get(id) : undefined
    return node ? this.#deepFreeze(structuredClone(node)) : null
  }

  /** Registers a listener and immediately cues it with the whole container:
   *  bootstrap is not a separate handshake, it is the first `onChanged`, so a lens
   *  has exactly one read-and-paint path. Marks bootstrap the same way — every
   *  set this model already holds is cued — so a lens mounting onto a container
   *  that was checked before it arrived draws the same as one that was there.
   *  @param {ContainerUpdateListener} listener */
  subscribe(listener) {
    if (!listener || typeof listener.onChanged !== 'function') {
      throw new ContractViolation('ContainerModel.subscribe: listener must implement onChanged')
    }
    this.#listeners.add(listener)
    this.#deliver(listener, this.#change(this.#order, true))
    for (const [feature, held] of this.#marks) {
      for (const [blockId, marks] of held) this.#deliverMarks(listener, feature, blockId, marks)
    }
  }

  /** @param {ContainerUpdateListener} listener */
  unsubscribe(listener) { this.#listeners.delete(listener) }

  /** Seeds the whole container from a load answer — a RESET, not a merge. The
   *  answer is the complete truth at that moment, so it is the one inbound shape
   *  that can retire a child this model still holds without naming it.
   *  @param {ContainerContent} content */
  applyLoad(content) {
    const c = content || {}
    if (c.uuid && c.uuid !== this.#uuid) {
      throw new ContractViolation(
        'ContainerModel.applyLoad: content for ' + c.uuid + ' loaded into the model for ' + this.#uuid)
    }
    /** @type {string[]} */
    const order = []
    /** @type {Map<string, Readonly<BlockNode>>} */
    const nodes = new Map()
    for (const b of c.blocks || []) {
      if (!b || !b.id) continue
      order.push(b.id)
      nodes.set(b.id, this.#node(b.id, b.kind, b.attrs))
    }
    this.#order = order
    this.#nodes = nodes
    this.#emit(order, true)
  }

  /**
   * Folds one document-channel render-back. Frames this model does not claim are
   * dropped in silence — it shares its channel with acks, mode replies and the
   * ping watchdog. A frame's ORIGIN is not read here and not carried out.
   * @param {Record<string, any>} frame
   */
  applyFrame(frame) {
    const f = frame || {}
    if (f.type === DocumentFrame.INSERT_BLOCK) this.#applyInsert(f)
    else if (f.type === DocumentFrame.REPLACE_BLOCK) this.#applyReplace(f)
    else if (f.type === DocumentFrame.BLOCK_ATTRS_UPDATED) this.#applyAttrs(f)
    else if (f.type === DocumentFrame.REMOVE_BLOCK) this.#applyRemove(f)
    else if (f.type === DocumentFrame.ORDER_CHANGED) this.#applyOrderChanged(f)
    else if (f.type === DocumentFrame.TEXT_MARKS) this.#applyMarks(f)
  }

  /**
   * Installs one feature's COMPLETE mark set for one block, replacing whatever
   * this model held for that PAIR — so an empty array is the CLEAR, and the
   * frame a corrected block gets, while every other feature's marks on the same
   * block are untouched. They are not folded into the block: a mark is a reading
   * OF a block, it never travels back, and a lens is HANDED it rather than
   * reading it.
   * @param {Record<string, any>} f
   */
  #applyMarks(f) {
    if (!f.blockId || !f.feature) return
    /** @type {SieveTextMark[]} */
    const cloned = structuredClone(f.marks || [])
    const marks = this.#deepFreeze(cloned)
    const held = this.#marks.get(f.feature) || new Map()
    if (marks.length) held.set(f.blockId, marks)
    else held.delete(f.blockId)
    if (held.size) this.#marks.set(f.feature, held)
    else this.#marks.delete(f.feature)
    for (const listener of this.#listeners) this.#deliverMarks(listener, f.feature, f.blockId, marks)
  }

  /** Retires every feature's marks on a block the container no longer holds.
   *  @param {string} blockId */
  #forgetMarks(blockId) {
    for (const [feature, held] of this.#marks) {
      if (!held.delete(blockId)) continue
      if (!held.size) this.#marks.delete(feature)
    }
  }

  /** @param {Record<string, any>} f */
  #applyInsert(f) {
    if (!f.id) return
    const node = this.#node(f.id, f.kind, f.attrs, f.markdown)
    const known = this.#order.indexOf(f.id) >= 0
    this.#nodes.set(f.id, node)
    if (!known) this.#order.splice(this.#positionFor(f.index), 0, f.id)
    this.#emit([f.id], !known)
  }

  /**
   * Installs a block the host REWROTE, in the slot the old one held. The node is
   * taken WHOLE — this frame is not a patch — so the cue names it replaced and a
   * lens holding its own copy of that block's content takes this one.
   *
   * The ids may be the same block (a transform, a text edit Go executed) or two
   * (a transform that minted a fresh identity), and only the second retires an
   * id: whatever still has to ROUTE for it is the transport's business.
   * @param {Record<string, any>} f
   */
  #applyReplace(f) {
    if (!f.newId) return
    const node = this.#node(f.newId, f.newKind, f.attrs)
    this.#nodes.set(f.newId, node)
    if (f.newId === f.oldId) { this.#emit([f.newId], false, [f.newId]); return }

    const at = f.oldId ? this.#order.indexOf(f.oldId) : -1
    if (at >= 0) this.#order[at] = f.newId
    else this.#order.push(f.newId)
    if (f.oldId) { this.#nodes.delete(f.oldId); this.#forgetMarks(f.oldId) }
    this.#emit(f.oldId ? [f.oldId, f.newId] : [f.newId], true, [f.newId])
  }

  /** @param {Record<string, any>} f */
  #applyAttrs(f) {
    const prior = f.id ? this.#nodes.get(f.id) : undefined
    if (!prior) return // an id this container never held has no kind to author under
    // MERGE, though Go documents this frame's attrs as the full bag: a partial bag
    // must not silently erase the keys it omits, and a full one makes the merge an
    // identity anyway.
    this.#nodes.set(f.id, this.#node(f.id, prior.kind, Object.assign({}, prior.attrs, f.attrs)))
    this.#emit([f.id], false)
  }

  /** @param {Record<string, any>} f */
  #applyRemove(f) {
    if (!f.id || !this.#nodes.has(f.id)) return // an id this container never held has nothing to retire
    const at = this.#order.indexOf(f.id)
    if (at >= 0) this.#order.splice(at, 1)
    this.#nodes.delete(f.id)
    this.#forgetMarks(f.id)
    this.#emit([f.id], at >= 0)
  }

  /**
   * Installs the container's complete new child order. A name this model has no
   * node for is dropped: it is a position that cannot be painted, and the next
   * load answer repairs it. Ids it does NOT name are left alone — a block leaves
   * by remove-block, and Go echoes only permutations of what the container holds.
   * @param {Record<string, any>} f
   */
  #applyOrderChanged(f) {
    if (!Array.isArray(f.order)) return
    this.#order = f.order.filter((id) => this.#nodes.has(id))
    this.#emit([], true)
  }

  /**
   * Authors a node from wire parts. `id` is stamped into the attrs bag as well as
   * the field, because the bag is what a renderer and the fenced serializer read a
   * block's identity out of. The bag is CLONED, so the model owns every byte of
   * its state, and the clone refuses a non-serializable attr at the door — this
   * state is destined to cross a process boundary intact.
   * @param {string} id @param {string} [kind] @param {Record<string, any>} [attrs]
   * @param {string} [text] the block's serialized form, when Go volunteered it
   * @returns {Readonly<BlockNode>}
   */
  #node(id, kind, attrs, text) {
    const bag = structuredClone(attrs || {})
    bag.id = id
    /** @type {BlockNode} */
    const node = { id: id, kind: kind || DEFAULT_BLOCK_KIND, attrs: bag }
    if (typeof text === 'string' && text !== '') node.text = text
    return this.#deepFreeze(node)
  }

  /** The insertion slot for a wire index; -1 and anything past the end both mean
   *  "at the end". @param {number} index @returns {number} */
  #positionFor(index) {
    const end = this.#order.length
    return typeof index === 'number' && index >= 0 && index < end ? index : end
  }

  /** @param {ReadonlyArray<string>} blockIds @param {boolean} orderChanged
   *  @param {ReadonlyArray<string>} [replaced] */
  #emit(blockIds, orderChanged, replaced) {
    const change = this.#change(blockIds, orderChanged, replaced)
    for (const listener of this.#listeners) this.#deliver(listener, change)
  }

  /** @param {ReadonlyArray<string>} blockIds @param {boolean} orderChanged
   *  @param {ReadonlyArray<string>} [replaced]
   *  @returns {Readonly<ContainerChange>} */
  #change(blockIds, orderChanged, replaced) {
    return Object.freeze({
      blockIds:     Object.freeze(blockIds.slice()),
      orderChanged: orderChanged,
      replaced:     Object.freeze((replaced || []).slice()),
    })
  }

  /** A throwing listener is isolated: the fold that produced the cue is already
   *  committed. @param {ContainerUpdateListener} listener @param {Readonly<ContainerChange>} change */
  #deliver(listener, change) {
    try { listener.onChanged(change) } catch (e) { console.error('[container-model] listener threw', e) }
  }

  /** A listener with nowhere to draw a mark does not implement the method, which
   *  is a legitimate lens and not a failure. Throwing is isolated as above.
   *  @param {ContainerUpdateListener} listener @param {string} feature
   *  @param {string} blockId
   *  @param {ReadonlyArray<Readonly<SieveTextMark>>} marks */
  #deliverMarks(listener, feature, blockId, marks) {
    if (typeof listener.onMarksChanged !== 'function') return
    try { listener.onMarksChanged(feature, blockId, marks) } catch (e) { console.error('[container-model] listener threw', e) }
  }

  /**
   * @template T
   * @param {T} value @returns {Readonly<T>}
   */
  #deepFreeze(value) {
    const obj = /** @type {any} */ (value)
    if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
      Object.freeze(obj)
      for (const key of Object.keys(obj)) this.#deepFreeze(obj[key])
    }
    return value
  }
}
