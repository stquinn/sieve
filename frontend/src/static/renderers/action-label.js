// labelForAction maps a block action to its menu label.
//   action     — 'extract' | 'transform' | 'undo-smart-paste'
//   prettyKind — the TARGET kind's friendly display name (e.g. "Text", "Code")
//   offer      — { kind } the TARGET kind (raw, e.g. 'prose')
//   sourceKind — the raw kind of the block the menu was invoked ON (e.g. 'smart-image')
//   nested     — the source is a block nested in another block's payload
export function labelForAction(action, prettyKind, offer, sourceKind, nested) {
  offer = offer || {}
  if (action === 'undo-smart-paste') return 'Undo Smart Paste'
  // A nested block extracted as its own kind is a copy of it placed in the
  // document after the block it is nested in.
  if (nested && action === 'extract' && offer.kind === sourceKind) return 'Add to Document'
  // Transforming an image INTO prose embeds it as a raw image, not text, so the
  // generic "Embed in Document" misreads. Driven by the SOURCE kind, not
  // prettyKind. Must precede the generic prose-transform case below.
  if (offer.kind === 'prose' && sourceKind === 'smart-image' && action === 'extract') {
    return 'Extract as Raw Image'
  }
  // Prose's transform is "flatten into the document" — not "convert to a kind".
  if (offer.kind === 'prose' && action === 'transform') return 'Embed in Document'
  var VERB = { extract: 'Extract as ', transform: 'Convert to ' }
  return (VERB[action] || '') + prettyKind
}
