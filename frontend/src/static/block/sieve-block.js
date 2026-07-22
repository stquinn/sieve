// @ts-check
// sieve-block.js — the typed block envelope (Block Renderer Contract,
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md §typed block envelope).
//
// Raw attr maps are the block's WIRE COSTUME; they cross no consumer signature.
// This is the ONE invariant in-memory form (mirroring Go's single SieveBlock —
// never per-kind subclasses). The typed surface is exactly the FRAMEWORK-level
// state (id / kind / mode / status); everything kind-specific stays in the
// opaque payload, and the kind's renderer is its SOLE interpreter.
//
// Serialization is a CONTAINER concern, not the block's: the markdown fence,
// a bare `.block` YAML file, a chat-turn YAML item are three costumes of this
// one envelope. Envelopes are authored by the service layer / the lens seam —
// `SieveBlock.from(node)` exists only as the PM-resurrect fallback (node attrs
// are a faithful wire costume, never the primary direction).

/**
 * Block presentation mode — a FRAMEWORK concept (the contract's MODE enum).
 * DEFAULT means "the kind's natural presentation": total for every kind, no
 * new wire states — renderers map the enum to the persisted strings privately.
 */
export const MODE = Object.freeze({ DEFAULT: 'default', EDIT: 'edit', RENDER: 'render' })

// ContractViolation — thrown on contract breaches (docs/how-to-idiomatic-js.md
// §6). Lives at the LEAF so every layer (services, renderers, seams) imports
// it downward; block-renderer.js re-exports it for the established import path.
export class ContractViolation extends Error {}

/** Wire mode strings → MODE members (absent/unknown → DEFAULT).
 * @type {Readonly<Record<string, string>>} */
const WIRE_MODES = Object.freeze({ edit: MODE.EDIT, render: MODE.RENDER })

export class SieveBlock {
  /** @type {string} */ #kind
  /** @type {Record<string, any>} */ #payload

  /**
   * @param {string} kind     block kind ('code', 'diagram', 'ai-block', …)
   * @param {Record<string, any>} [payload]  the wire attr map (id, mode, status, kind keys)
   */
  constructor(kind, payload) {
    this.#kind = kind || 'prose'
    this.#payload = payload || {}
  }

  /** The block's document-scoped id ('' when unassigned). */
  get id() { return this.#payload.id || '' }

  /** The block kind. */
  get kind() { return this.#kind }

  /**
   * Presentation mode as a MODE member. Modeless kinds report MODE.DEFAULT
   * (total — the contract's `MODE.DEFAULT` = "the kind's natural presentation").
   * @returns {string}
   */
  get mode() { return WIRE_MODES[this.#payload.mode] || MODE.DEFAULT }

  /** Job/status axis (the StatusBadge axis: PENDING/COMPLETE/ERROR…), or null. */
  get status() { return this.#payload.status || null }

  /**
   * The opaque kind payload (the wire attr map). By contract the kind's
   * RENDERER is its sole interpreter — consumers read the typed getters above.
   * @returns {Record<string, any>}
   */
  get payload() { return this.#payload }

  /**
   * PM-FALLBACK constructor (resurrected nodes only — envelope-first flow is
   * the primary direction). Kind derives from the node's type name
   * (`sieve-<kind>`); payload is the node's attr map plus an optional
   * lens-supplied overlay.
   * @param {{ type: { name: string }, attrs: Record<string, any> }} node
   * @param {Record<string, any>} [overlay]
   * @returns {SieveBlock}
   */
  static from(node, overlay) {
    const name = (node && node.type && node.type.name) || ''
    const kind = name.indexOf('sieve-') === 0 ? name.slice('sieve-'.length) : name || 'prose'
    const payload = Object.assign({}, (node && node.attrs) || {}, overlay || {})
    return new SieveBlock(kind, payload)
  }
}
