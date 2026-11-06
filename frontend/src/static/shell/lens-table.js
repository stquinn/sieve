// @ts-check
// LensTable: which lens a container is mounted in, and over which provider,
// keyed by the container's kind — the noun the server reports for it. It is the
// one place a kind decides a lens; nothing reads a kind from a uuid.
//
// A kind with no entry of its own is a block container whose kind has no lens,
// and gets the fallback. A mount whose kind was never stated is a document's,
// the rule the session applies to a tab saved without one.

import { ContractViolation } from '../contract/sieve-block.js'

/**
 * What one kind is mounted with.
 *
 * @typedef {object} Mounting
 * @property {new (uuid: string, options?: object) => import('../lens/abstract-editor.js').AbstractEditor} lens
 *   the lens class, constructed with the container's uuid and the host's options
 * @property {new (model: any, documentService: any) => any} provider
 *   the provider adapter the mount wraps around the container's model
 * @property {boolean} channel whether the container lives on a document channel;
 *   one without loads and saves over HTTP and hears of its changes only by
 *   invalidation
 * @property {boolean} document whether the container is a document, which is
 *   what has an export
 */

export class LensTable {
  /** The kind a mount takes when none was stated. */
  static DOCUMENT_KIND = 'note'

  /** @type {Readonly<Record<string, Readonly<Mounting>>>} */ #entries
  /** @type {Readonly<Mounting>} */ #fallback

  /**
   * @param {Readonly<Record<string, Readonly<Mounting>>>} entries one per kind
   *   with a lens of its own; must hold DOCUMENT_KIND
   * @param {Readonly<Mounting>} fallback what every other kind is mounted with
   */
  constructor(entries, fallback) {
    if (!entries || !entries[LensTable.DOCUMENT_KIND]) {
      throw new ContractViolation('LensTable: the entries must say how a ' + LensTable.DOCUMENT_KIND + ' is mounted')
    }
    if (!fallback || typeof fallback.lens !== 'function' || typeof fallback.provider !== 'function') {
      throw new ContractViolation('LensTable: a fallback mounting is required')
    }
    this.#entries = Object.freeze(Object.assign({}, entries))
    this.#fallback = fallback
  }

  /**
   * @param {string|null|undefined} kind the container's kind, as the server stated it
   * @returns {Readonly<Mounting>}
   */
  lookup(kind) {
    const k = kind || LensTable.DOCUMENT_KIND
    return Object.hasOwn(this.#entries, k) ? this.#entries[k] : this.#fallback
  }
}
