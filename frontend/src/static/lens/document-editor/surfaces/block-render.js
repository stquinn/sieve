// block-render.js — Stage D.2 document-HTML builder.
//
// Pure function: turns the SieveBlock[] block list the WYSIWYG load types into
// the HTML string the editor parses (via tiptap-markdown's markdownit + each node's
// existing parseHTML). It does NOT build ProseMirror JSON — that is the whole
// point of the spine: a prose block travels as its NATIVE markdown (rendered to
// native nodes — node-granular, 2026-06-19), and structured blocks travel as
// their canonical fence text, which markdownit + the per-kind fence rule turn
// into the right data-* div. The loaded block id is stamped onto the native node
// by renderBlocksIntoEditor (real DOM), so this builder emits no wrapper.
//
// `mdRender` is injected (the editor passes
// `editor.storage.markdown.parser.md.render`) so this module stays free of any
// editor/DOM dependency and is unit-testable in isolation.

import { buildSieveBlockHTML } from './sieve-block-extension.js'

// renderProseContent is the prose kind's LOAD mapping (block → native HTML): a
// prose block IS its native top-level node(s) (paragraph/heading/list/table/
// blockquote/…), NOT a custom sieve-prose container. markdownit produces the
// native HTML, which ProseMirror's DOMParser turns back into native nodes. A
// multi-paragraph run (legacy, marker-less) renders to N top-level nodes; a
// markered doc delivers one block per node so this stays one node. The block's
// id is stamped onto the resulting native node by renderBlocksIntoEditor (real
// DOM); this builder carries no wrapper. This function is referenced by
// prose-block.js's ProseBlock.fromBlock (single implementation, one home).
export function renderProseContent(content, mdRender) {
  let inner = content ? mdRender(content) : '<p></p>'
  // Whitespace-only content renders to nothing, which is not a valid node.
  if (!inner || !inner.trim()) inner = '<p></p>'
  return inner
}

// proseContent resolves a block's prose body from its SieveBlock. The
// payload is the uniform properties bag — the same place EVERY kind keeps its
// payload (code → payload.source, prose → payload.content). The render pipeline
// is block-native (issue #49 Phase 3): payload is the sanctioned wire costume
// for PM node materialization; the renderer branches on kind, not on where the
// payload lives.
export function proseContent(b) {
  return (b && b.payload && b.payload.content) || ''
}

// Build the HTML for a single block (a SieveBlock).
function blockHTML(b, mdRender) {
  if (b.kind === 'prose') {
    return renderProseContent(proseContent(b), mdRender)
  }
  // Structured / container: build the node's data-* div straight from the
  // block's PROPERTIES (payload), reusing the SAME parseAttrs/data-* builder
  // the markdownit fence rule uses (buildSieveBlockHTML) — no markdown round-trip,
  // the block model is properties-in.
  if (typeof buildSieveBlockHTML === 'function') {
    const built = buildSieveBlockHTML(b.kind, b.payload || {})
    if (built) return built
  }
  // Defensive (builder unavailable, e.g. a bare unit env): a non-empty placeholder
  // so the block never collapses into an invalid prose node.
  return '<div data-type="sieve-block" data-kind="' + (b.kind || '') + '"></div>'
}

// buildBlocksHTML projects the block list into a single document-HTML string,
// blocks joined in order by newlines (block separation; markdownit treats each
// top-level construct independently).
export function buildBlocksHTML(blocks, mdRender) {
  return (blocks || []).map((b) => blockHTML(b, mdRender)).join('\n')
}
