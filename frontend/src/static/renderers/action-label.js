// labelForAction maps a block action to its menu label.
// Pure and tested so the verb wording has a regression gate.
//   action     — 'extract' | 'transform' | 'undo-smart-paste'
//   prettyKind — the TARGET kind's friendly display name (e.g. "Text", "Code")
//   offer      — { kind } the TARGET kind (raw, e.g. 'prose')
//   sourceKind — the raw kind of the block the menu was invoked ON (e.g. 'smart-image')
export function labelForAction(action, prettyKind, offer, sourceKind) {
  offer = offer || {}
  if (action === 'undo-smart-paste') return 'Undo Smart Paste'
  // Transforming an image INTO prose embeds it as a raw image, not text, so the
  // generic "Embed in Document" misreads. Driven by the SOURCE kind, not
  // prettyKind (which names the target). Must precede the generic prose-transform
  // case below, or that would shadow it.
  if (offer.kind === 'prose' && sourceKind === 'smart-image' && action === 'extract') {
    return 'Extract as Raw Image'
  }
  // Prose's transform is "flatten into the document" — not "convert to a kind".
  if (offer.kind === 'prose' && action === 'transform') return 'Embed in Document'
  var VERB = { extract: 'Extract as ', transform: 'Convert to ' }
  return (VERB[action] || '') + prettyKind
}
