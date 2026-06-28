// labelForAction maps a block action (+ optional offer context) to its menu label.
// Pure and tested so the verb wording has a regression gate.
export function labelForAction(action, prettyKind, offer) {
  offer = offer || {}
  if (action === 'undo-smart-paste') return 'Undo Smart Paste'
  // Prose's transform is "flatten into the document" — not "convert to a kind".
  if (offer.kind === 'prose' && action === 'transform') return 'Embed in Document'
  var VERB = { extract: 'Extract as ', transform: 'Convert to ' }
  return (VERB[action] || '') + prettyKind
}

if (typeof window !== 'undefined') {
  window.TipTap = window.TipTap || {}
  window.TipTap.labelForAction = labelForAction
}
