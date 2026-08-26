// The document-HTML builder: turns the SieveBlock[] a WYSIWYG load types into
// the HTML string the editor parses (markdownit plus each node's parseHTML).
//
// It does NOT build ProseMirror JSON. A prose block travels as its native
// markdown, a structured block as its data-* div; the loaded block id is stamped
// onto the resulting node later by renderBlocksIntoEditor, so this builder emits
// no wrapper. `mdRender` is injected, which keeps the module free of any
// editor/DOM dependency.

import { buildSieveBlockHTML } from './sieve-block-extension.js'

// The prose kind's LOAD mapping (block → native HTML): a prose block IS its
// native top-level node(s), not a custom sieve-prose container. A legacy
// marker-less multi-paragraph run renders to N top-level nodes; a markered doc
// delivers one block per node, so this stays one node.
export function renderProseContent(content, mdRender) {
  let inner = content ? mdRender(content) : '<p></p>'
  // Whitespace-only content renders to nothing, which is not a valid node.
  if (!inner || !inner.trim()) inner = '<p></p>'
  return inner
}

// A block's prose body. `payload` is the uniform properties bag — the same place
// every kind keeps its content (code → payload.source, prose → payload.content).
export function proseContent(b) {
  return (b && b.payload && b.payload.content) || ''
}

function blockHTML(b, mdRender) {
  if (b.kind === 'prose') {
    return renderProseContent(proseContent(b), mdRender)
  }
  // Structured / container: build the data-* div straight from the block's
  // properties, reusing the builder the markdownit fence rule uses — no markdown
  // round-trip.
  if (typeof buildSieveBlockHTML === 'function') {
    const built = buildSieveBlockHTML(b.kind, b.payload || {})
    if (built) return built
  }
  // Builder unavailable (a bare unit env): a non-empty placeholder, so the block
  // never collapses into an invalid prose node.
  return '<div data-type="sieve-block" data-kind="' + (b.kind || '') + '"></div>'
}

// The block list as one document-HTML string, joined by newlines so markdownit
// treats each top-level construct independently.
export function buildBlocksHTML(blocks, mdRender) {
  return (blocks || []).map((b) => blockHTML(b, mdRender)).join('\n')
}
