// block-ops.js — the WIRE block-op constructors (host side of the wall).
//
// Every kind's payload rides in `attrs` (prose's body at attrs.content, exactly
// as code's at attrs.source) — there is no kind-special-cased top-level field on
// the wire. `aliases` is optional; create-block carries its document index.
//
// These build frames Go will read. The lens's own observer (lens/block-sync.js)
// builds a batch that LOOKS like this and then translates it into facade verbs —
// a coincidence of shape, not a dependency: the wire and the facade are separate
// contracts (#96), so the lens must not reach across for a constructor.

/**
 * @param {string} type @param {string} blockId @param {string} kind
 * @param {Object<string, any>} [attrs] @param {string[]} [aliases] @param {number} [index]
 * @returns {Object<string, any>}
 */
export function blockOp(type, blockId, kind, attrs, aliases, index) {
  var op = { type: type, blockId: blockId, kind: kind, attrs: attrs || {} }
  if (aliases && aliases.length) op.aliases = aliases
  if (type === 'create-block') op.index = index
  return op
}

// updateBlockOp maps a structured block edit detail ({ id, kind, attrs,
// aliases? }) to an update-block op. Every block update, prose or structured,
// is one op shape — {update-block, blockId, kind, attrs, aliases?}.
/**
 * @param {{id: string, kind: string, attrs?: Object<string, any>, aliases?: string[]}} detail
 * @returns {Object<string, any>}
 */
export function updateBlockOp(detail) {
  return blockOp('update-block', detail.id, detail.kind, detail.attrs, detail.aliases)
}
