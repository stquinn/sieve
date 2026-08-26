// @ts-check
// The ONE markdown-it instance every non-PM renderer fill (title, body) runs on.
//
// html:false — raw HTML embedded in markdown text renders as inert, escaped
// text, never live DOM. This is deliberately NOT the editor's own markdown-it
// instance, which runs html:true so ProseMirror's own HTML parsing/paste path
// works; that instance's output is filtered by the PM schema before it reaches
// the DOM, which is why html:true is safe THERE and unsafe here. Escaped raw
// HTML displaying as literal text in a title or body is the accepted trade.
//
// markdown-it-mark (the ==mark== extension) is `.use()`d here explicitly to
// match the editor's feature set, which gets it through a tiptap-markdown hook
// this standalone instance has no equivalent of.

import { T } from './vendor-libs.js'
import { storeFileSrc } from './asset-urls.js'

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
  installStoreFileImageRule(_md)
  return _md
}

/**
 * Points a relative image at the store's file route as it renders. A rendered
 * fill is injected into the app shell, so `![](diagrams/flow.png)` would
 * otherwise be resolved against the shell's own URL and 404. Only the RENDERED
 * attribute changes — this instance never writes markdown back.
 * @param {any} md the markdown-it instance to rule
 */
function installStoreFileImageRule(md) {
  var inherited = md.renderer.rules.image
  md.renderer.rules.image = function (tokens, idx, options, env, self) {
    var attrs = tokens[idx].attrs || []
    var i = tokens[idx].attrIndex('src')
    if (i >= 0) attrs[i][1] = storeFileSrc(attrs[i][1])
    return inherited
      ? inherited(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)
  }
}

/**
 * Renders markdown text via the sanctioned instance. Falls back to HTML-escaped
 * plain text (a textContent round-trip) when the vendor MarkdownIt export is
 * unavailable, so a missing vendor bundle never means "raw text reaches
 * innerHTML unescaped".
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
