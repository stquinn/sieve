// The WIRE block-op constructors. Every kind's payload rides in `attrs` — there is
// no kind-special-cased top-level field on the wire.
//
// The lens's observer builds a batch that LOOKS like this before translating it into
// facade verbs. That is a coincidence of shape, not a dependency: the lens must not
// reach across for a constructor.

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

/**
 * @param {{id: string, kind: string, attrs?: Object<string, any>, aliases?: string[]}} detail
 * @returns {Object<string, any>}
 */
export function updateBlockOp(detail) {
  return blockOp('update-block', detail.id, detail.kind, detail.attrs, detail.aliases)
}
