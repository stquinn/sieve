// block-render.js — Stage D.2 document-HTML builder.
//
// Pure function: turns the flat []FrontendBlock the WYSIWYG load sends into the
// HTML string the editor parses (via tiptap-markdown's markdownit + each node's
// existing parseHTML). It does NOT build ProseMirror JSON — that is the whole
// point of the spine: prose travels as rendered markdown wrapped in a
// `sieve-prose`; structured blocks travel as their canonical fence text,
// which markdownit + the per-kind fence rule turn into the right data-* div.
//
// `mdRender` is injected (the editor passes
// `editor.storage.markdown.parser.md.render`) so this module stays free of any
// editor/DOM dependency and is unit-testable in isolation.

// Minimal attribute-value escaper. Only the characters that can break out of a
// double-quoted HTML attribute matter here.
function escAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Build the HTML for a single block.
function blockHTML(b, mdRender) {
  if (b.kind === 'prose') {
    const inner = b.content ? mdRender(b.content) : '<p></p>'
    let attrs = ` data-id="${escAttr(b.id || '')}"`
    if (b.aliases && b.aliases.length) {
      attrs += ` data-aliases="${escAttr(JSON.stringify(b.aliases))}"`
    }
    return `<div data-type="sieve-prose"${attrs}>${inner}</div>`
  }
  // Structured / container: build the node's data-* div straight from the block's
  // PROPERTIES (attrs), reusing the SAME parseAttrs/data-* builder the markdownit
  // fence rule uses (buildSieveBlockHTML) — no markdown round-trip, the block
  // model is properties-in. serialisedForm is passed through transitionally for
  // the data-serialised-form attr (paste/markdown-serialize) until those migrate.
  const T = (typeof window !== 'undefined' && window.TipTap) || {}
  if (typeof T.buildSieveBlockHTML === 'function') {
    return T.buildSieveBlockHTML(b.kind, b.attrs || {}, b.serialisedForm || '')
  }
  // Fallback (no renderer registry available, e.g. a bare unit env): the fence.
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
