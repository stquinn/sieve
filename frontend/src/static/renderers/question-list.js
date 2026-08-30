// @ts-check
// The vocabulary of an ai-block's QUESTION: the ordered list of blocks the
// question is composed of, and the builder every composer gesture mints through.
//
// AN ELEMENT IS A BLOCK — `{kind, attrs}`, the same kind vocabulary and the same
// attrs bag as a block in the document. It differs only in where it lives:
// inside its parent's payload, so nothing in the document addresses it. Ids are
// Go's: an element arriving without one is minted a durable id at the door, so
// nothing here mints one.
//
// EVERY REFERENCE ELEMENT DECLARES ITS ROLE in `rel`. The role is what both the
// renderer and the prompt fold classify on; the address rule behind it is the
// fallback for a hand-authored fence, never a licence to omit the stamp. A
// rel-less reference minted by a gesture is a defect.
//
// THE FOLD IS THE MIRROR OF Go's AIBlockProcessor.foldQuestion, predicate for
// predicate: a non-reference element is body whatever its kind; `rel` decides a
// reference outright; and only when it declares neither role does the address
// decide — inside this container is a target, anywhere else an attachment. The
// two sides classify the same list into the same slots, so what the prompt was
// built from is what the block draws.

/**
 * One element of a question: the kind, and everything that kind owns.
 * @typedef {{ kind: string, attrs: Record<string, any> }} QuestionElement
 */

/**
 * A question folded into the three slots it is read in: the material it is
 * ABOUT, the blocks it IS, and the documents it was HANDED. Each element of the
 * question appears in exactly one slot, and the arrays hold the caller's own
 * element objects so list order can be recovered by identity.
 * @typedef {object} QuestionSlots
 * @property {QuestionElement[]} targets
 * @property {QuestionElement[]} body
 * @property {QuestionElement[]} attachments
 */

/** A Sieve coordinate, read. @typedef {{container: string, leaf: string, version: number}} QuestionAddress */

/** An attachment as the composer holds it — the address is the truth, the title
 *  is the echo that labels it.
 * @typedef {{ uri: string, title?: string }} AttachmentEntry */

/** The roles a composer gesture declares. `target` is material the question is
 *  ABOUT; `attach` is material the turn was HANDED. */
export const QuestionRel = Object.freeze({
  TARGET: 'target',
  ATTACH: 'attach',
})

/** The token the surfaces resolve a whole-document target to. */
const WHOLE_DOCUMENT = 'doc'

/** The kind whose elements carry an address; every other kind is body. */
const KIND_REFERENCE = 'reference'

/** The canonical 8-4-4-4-12 uuid an address's authority must be. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class QuestionList {
  /** @type {string} the container every address minted here is spelled against */ #container
  /** @type {QuestionElement[]} */ #elements = []

  /** @param {string} container the uuid of the document the question is asked in */
  constructor(container) {
    if (!container) throw new Error('QuestionList: a container uuid is required')
    this.#container = container
  }

  /**
   * Declares what the question is ABOUT. `ref` is the target token the surface
   * resolved: the whole-document sentinel, or a comma-separated list of block
   * ids in this container. A follow-up names its parent exchange the same way,
   * so the parent reference lands FIRST in the list.
   * @param {string|null|undefined} ref
   * @returns {this}
   */
  about(ref) {
    for (const token of String(ref == null ? '' : ref).split(',')) {
      const leaf = token.trim()
      if (!leaf) continue
      this.#target(this.#address(leaf === WHOLE_DOCUMENT ? '' : leaf))
    }
    return this
  }

  /**
   * Adds the authored text as one prose element. Blank text adds nothing: an
   * Explain has no text to add, and a question that is not there is never
   * invented.
   * @param {string|null|undefined} text
   * @returns {this}
   */
  ask(text) {
    const content = String(text == null ? '' : text)
    if (content.trim()) this.#elements.push({ kind: 'prose', attrs: { content: content } })
    return this
  }

  /**
   * Adds elements a COMPOSER already authored, verbatim and in the order they
   * were written. Each is taken as it stands — an element that names its own id
   * keeps it, and the authority it reaches adopts that name.
   *
   * It is the list-shaped sibling of `ask`: `ask` mints one prose element from a
   * string, this takes the elements a richer gesture produced. Both land in the
   * same slot, so gesture order — target, body, attachments — is stated here and
   * in one place only.
   * @param {ReadonlyArray<QuestionElement>|null|undefined} elements
   * @returns {this}
   */
  body(elements) {
    for (const el of elements || []) {
      if (el && typeof el.kind === 'string') this.#elements.push(el)
    }
    return this
  }

  /**
   * Declares what the turn was HANDED — the `@` picker's accepted candidates.
   * Each becomes a bare reference carrying the address and, as its cached FACE,
   * the title that labelled it. An entry with no address is not an attachment.
   * @param {ReadonlyArray<AttachmentEntry>|null|undefined} entries
   * @returns {this}
   */
  attach(entries) {
    for (const entry of entries || []) {
      const element = QuestionList.attachment(entry && entry.uri, entry && entry.title)
      if (element) this.#elements.push(element)
    }
    return this
  }

  /**
   * One attachment as the reference element that carries it: the address, the
   * `attach` stamp, and the title as its cached face. THE SINGLE DEFINITION of
   * the shape, so a composer holding the element as its own truth and a scalar
   * ask minting one at send produce the same value. An entry with no address is
   * not an attachment.
   * @param {any} uri
   * @param {any} [title]
   * @returns {QuestionElement|null}
   */
  static attachment(uri, title) {
    const address = String(uri == null ? '' : uri).trim()
    if (!address) return null
    /** @type {Record<string, any>} */
    const attrs = { uri: address, rel: QuestionRel.ATTACH }
    const face = String(title == null ? '' : title).trim()
    if (face) attrs.cache = { title: face }
    return { kind: KIND_REFERENCE, attrs: attrs }
  }

  /**
   * The attachment an element carries, or null when it is not one — the reader
   * half of `attachment`, over anything element-shaped, a container's block
   * node included.
   * @param {any} el
   * @returns {AttachmentEntry|null}
   */
  static attachmentOf(el) {
    if (!el || el.kind !== KIND_REFERENCE) return null
    const attrs = el.attrs || {}
    if (attrs.rel !== QuestionRel.ATTACH) return null
    return { uri: String(attrs.uri || ''), title: String((attrs.cache && attrs.cache.title) || '') }
  }

  /** @returns {QuestionElement[]} the list as minted, in gesture order */
  get elements() { return this.#elements.slice() }

  /**
   * A slot of an exchange as the list of elements it IS, whatever form it
   * arrived in — the QUESTION, and the ANSWER, which carries the same encoding.
   * A scalar — what a standalone command's popup block carries, what a producer
   * that cannot compose blocks writes, and what a document written before the
   * list existed holds until its load path converts it — reads as the one prose
   * element it always was, so every reader below has a single shape to work on
   * and no legacy arm.
   * @param {any} list
   * @returns {QuestionElement[]}
   */
  static elementsOf(list) {
    if (typeof list === 'string') {
      return list.trim() ? [{ kind: 'prose', attrs: { content: list } }] : []
    }
    if (!Array.isArray(list)) return []
    return list.filter((el) => el && typeof el === 'object' && typeof el.kind === 'string')
  }

  /**
   * Folds a question into its three slots against the container it is asked in.
   * @param {any} question
   * @param {string} container  the uuid of the document holding the question
   * @returns {QuestionSlots}
   */
  static fold(question, container) {
    /** @type {QuestionSlots} */
    const slots = { targets: [], body: [], attachments: [] }
    for (const el of QuestionList.elementsOf(question)) {
      const rel = (el.attrs && el.attrs.rel) || ''
      if (el.kind !== KIND_REFERENCE) slots.body.push(el)
      else if (rel === QuestionRel.TARGET) slots.targets.push(el)
      else if (rel === QuestionRel.ATTACH) slots.attachments.push(el)
      else if (QuestionList.localToken(el, container)) slots.targets.push(el)
      else slots.attachments.push(el)
    }
    return slots
  }

  /**
   * The handle THIS container's chain resolves an element by — the
   * whole-document token for the container itself, the leaf for a block inside
   * it — or null when it has none.
   *
   * An element naming another container has none, and neither has one whose
   * address is pinned or the grammar rejects: a chain walks handles within one
   * live container, and none of those is one.
   * @param {QuestionElement|null|undefined} el
   * @param {string} container
   * @returns {string|null}
   */
  static localToken(el, container) {
    const own = String(container == null ? '' : container).trim().toLowerCase()
    const addr = QuestionList.#parse(el && el.attrs && el.attrs.uri)
    if (!own || !addr || addr.version > 0 || addr.container !== own) return null
    return addr.leaf || WHOLE_DOCUMENT
  }

  /**
   * The readable text of a question or an answer — what a one-line summary of it
   * shows: its prose elements, in order. A list composed only of references has
   * none, and neither has a value that is no list at all.
   * @param {any} list
   * @returns {string}
   */
  static text(list) {
    return QuestionList.elementsOf(list)
      .filter((el) => el.kind === 'prose')
      .map((el) => (el.attrs && el.attrs.content) || '')
      .filter(Boolean)
      .join('\n\n')
  }

  /**
   * Reads an ABSOLUTE Sieve coordinate, rejecting everything the grammar does
   * not produce, so a spelling Go refuses is never classified as local here.
   * @param {any} uri
   * @returns {QuestionAddress|null}
   */
  static #parse(uri) {
    const raw = String(uri == null ? '' : uri).trim()
    // A trailing '?' is an empty query, which the grammar rejects and which the
    // URL reader below silently drops.
    if (!raw || raw.endsWith('?')) return null
    let u
    try { u = new URL(raw) } catch (e) { return null }
    if (u.protocol !== 'sieve:' || u.username || u.password || u.port || u.hash) return null
    if (!UUID.test(u.hostname)) return null
    if (u.pathname === '/' || u.pathname.indexOf('/', 1) !== -1) return null
    let leaf = ''
    try { leaf = decodeURIComponent(u.pathname.replace(/^\//, '')) } catch (e) { return null }
    const version = QuestionList.#version(u)
    if (version < 0) return null
    return { container: u.hostname.toLowerCase(), leaf: leaf, version: version }
  }

  /** The pin on a coordinate: 0 = live, >0 = pinned, -1 = a query the grammar
   *  rejects. @param {URL} u @returns {number} */
  static #version(u) {
    if (!u.search) return 0
    const keys = Array.from(u.searchParams.keys())
    if (keys.length !== 1 || keys[0] !== 'version') return -1
    const raw = String(u.searchParams.get('version'))
    const n = Number(raw)
    return Number.isInteger(n) && n >= 1 ? n : -1
  }

  /** Adds the material the question is ABOUT as a reference element. A target
   *  carries no face: it is addressed inside the document reading it.
   *  @param {string} uri */
  #target(uri) {
    this.#elements.push({ kind: KIND_REFERENCE, attrs: { uri: uri, rel: QuestionRel.TARGET } })
  }

  /** This container's address, or one of its leaves. @param {string} leaf @returns {string} */
  #address(leaf) {
    return 'sieve://' + this.#container + (leaf ? '/' + leaf : '')
  }
}
