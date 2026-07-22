// @ts-check
// sanctioned-markdown.js — the ONE markdown-it instance every non-PM renderer
// fill (title, body) runs on (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md
// §Content lanes / §Body/title pull-back — DEFECT SEC-B, issue #48).
//
// html:false — raw HTML embedded in markdown text renders as inert, escaped
// text, never live DOM. This is deliberately NOT the editor's own markdown-it
// instance: editor/surfaces/wysiwyg-surface.js configures tiptap-markdown
// with html:true so ProseMirror's own HTML-node parsing/paste path works —
// that instance's output is filtered by the PM schema before it ever reaches
// the DOM, which is why html:true is safe THERE and unsafe here. Borrowing
// the editor's instance for a direct innerHTML write (the pre-#48 title
// seam) is exactly the defect this module exists to close: a remote-content
// title/body (web-clip's fetched page metadata, an LLM response) hit
// innerHTML with HTML passthrough switched on.
//
// markdown-it-mark (the ==mark== extension) is `.use()`d here explicitly to
// match the editor's feature set — the editor gets it via
// editor/extensions.js's HighlightMark markdown.parse.setup hook (a seam
// tiptap-markdown drives per-extension); this standalone instance has no
// equivalent, so it registers the same plugin directly.
//
// Markup discipline note: no legitimate raw-HTML-in-title/body use exists in
// this app (AI responses and fetched-page metadata are markdown/plain text,
// never HTML-by-design) — escaped raw HTML displaying as literal text in the
// rare document that happens to contain it is accepted (stated assumption,
// issue #48).

import { T } from '../../base/tiptap-vendor.js'

/** @type {any} */
let _md = null

/**
 * The sanctioned markdown-it instance — constructed lazily (once per module
 * lifetime) the first time a renderer actually fills a title/body, so a host
 * that never renders markdown never pays for the vendor bundle lookup.
 * @returns {any|null} null if the vendor bundle hasn't loaded T.MarkdownIt yet
 *   (unit tests with no vendor stub, or a host that hasn't wired T).
 */
export function sanctionedMarkdownIt() {
  if (_md) return _md
  if (!T.MarkdownIt) return null
  _md = new T.MarkdownIt({ html: false })
  if (T.markdownItMark) _md.use(T.markdownItMark)
  return _md
}

/**
 * Renders markdown text via the sanctioned instance. Falls back to
 * HTML-escaped plain text (via textContent round-trip) if the vendor
 * MarkdownIt export isn't available — the same inert fallback the pre-#48
 * renderMarkdown had, so a missing vendor bundle never means "raw text
 * reaches innerHTML unescaped".
 * @param {string} text
 * @returns {string} HTML string, safe to assign to innerHTML
 */
export function renderSanctionedMarkdown(text) {
  var md = sanctionedMarkdownIt()
  try {
    if (md) return md.render((text || '').trim())
  } catch (_) {
    console.log('Failed to render markdown')
  }
  var div = document.createElement('div')
  div.textContent = text || ''
  return div.innerHTML
}
