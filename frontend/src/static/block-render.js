// block-render.js — Stage D.2 document-HTML builder.
//
// Pure function: turns the flat []FrontendBlock the WYSIWYG load sends into the
// HTML string the editor parses (via tiptap-markdown's markdownit + each node's
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

// Build the HTML for a single block.
function blockHTML(b, mdRender) {
  if (b.kind === 'prose') {
    return renderProseContent(b.content, mdRender)
  }
  // Structured / container: build the node's data-* div straight from the block's
  // PROPERTIES (attrs), reusing the SAME parseAttrs/data-* builder the markdownit
  // fence rule uses (buildSieveBlockHTML) — no markdown round-trip, the block
  // model is properties-in. serialisedForm is passed through transitionally for
  // the data-serialised-form attr (paste/markdown-serialize) until those migrate.
  const T = (typeof window !== 'undefined' && window.TipTap) || {}
  if (typeof T.buildSieveBlockHTML === 'function') {
    const built = T.buildSieveBlockHTML(b.kind, b.attrs || {}, b.serialisedForm || '')
    if (built) return built
  }
  // Fallback: build from the serialised fence via markdownit (no attrs, an
  // unregistered renderer, or a bare unit env). Never return empty — an empty
  // structured block would parse to an invalid prose node.
  return mdRender(b.serialisedForm || '')
}

// buildBlocksHTML projects the block list into a single document-HTML string,
// blocks joined in order by newlines (block separation; markdownit treats each
// top-level construct independently).
export function buildBlocksHTML(blocks, mdRender) {
  return (blocks || []).map((b) => blockHTML(b, mdRender)).join('\n')
}

// Expose on the TipTap global so the classic-script editor.js can call it at
// runtime (mirrors how the renderer modules register themselves).
if (typeof window !== 'undefined') {
  window.TipTap = window.TipTap || {}
  window.TipTap.buildBlocksHTML = buildBlocksHTML
}
