// @ts-check
// highlighting.js — lowlight-based syntax highlighting for rendered markdown
// content. Lives here in block/renderers/, the "engines a renderer's fill
// contract needs" home alongside sanctioned-markdown.js — BlockRenderer's
// default fillTitle/fillBody call applyHighlighting after rendering. (Callers
// import getLowlight/applyHighlighting straight from this file; the retired
// base/fenced-block-base.js grab-bag used to re-export them — issue #49 P5.)

import { T } from './vendor-libs.js'

// ── Lowlight (lazy) ───────────────────────────────────────────────────────────

var _lowlight = null

export function getLowlight() {
  if (!_lowlight) {
    if (T && T.createLowlight && T.common) _lowlight = T.createLowlight(T.common)
  }
  return _lowlight
}

// Minimal hast-to-HTML serialiser. Only handles the subset lowlight emits:
// root/element nodes (become <span class="…">) and text nodes.
export function hastToHtml(nodes) {
  if (!nodes) return ''
  return nodes.map(function (n) {
    if (n.type === 'text') {
      return n.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
    if (n.type === 'element') {
      var cls = (n.properties && n.properties.className || []).join(' ')
      return '<span' + (cls ? ' class="' + cls + '"' : '') + '>' + hastToHtml(n.children) + '</span>'
    }
    return ''
  }).join('')
}

// addLineNumbers — wraps a <pre> element in a .sieve-code-block flex container
// with a line-number gutter, mirroring the TipTap .code-block appearance.
function addLineNumbers(pre, lineCount) {
  var wrapper = document.createElement('div')
  wrapper.className = 'sieve-code-block'

  var gutter = document.createElement('div')
  gutter.className = 'sieve-code-block__gutter'
  for (var i = 1; i <= lineCount; i++) {
    var span = document.createElement('span')
    // Pseudo-content number (data-ln), never a text node — see LineGutter.sync
    // for the WebKit copy-leak rationale.
    span.dataset.ln = String(i)
    gutter.appendChild(span)
  }

  pre.parentNode.insertBefore(wrapper, pre)
  wrapper.appendChild(gutter)
  wrapper.appendChild(pre)
}

// applyHighlighting — walks pre>code elements, applies lowlight syntax colours,
// wraps each block in a .sieve-code-block gutter layout, and marks the container
// with 'sieve-rendered-content'. Call this once after setting innerHTML on your
// content div — box, gutter, and colours all apply.
export function applyHighlighting(container) {
  container.classList.add('sieve-rendered-content')
  var low = getLowlight()
  container.querySelectorAll('pre code').forEach(function (codeEl) {
    var lang = ''
    ;(codeEl.className || '').split(' ').forEach(function (cls) {
      if (cls.indexOf('language-') === 0) lang = cls.slice(9)
    })
    var rawCode = codeEl.textContent
    if (!rawCode) return

    var lines = rawCode.split('\n')
    var lineCount = (lines[lines.length - 1] === '') ? lines.length - 1 : lines.length

    if (lang && low) {
      try {
        codeEl.innerHTML = hastToHtml(low.highlight(lang, rawCode).children)
      } catch (_) {}
    }
    codeEl.classList.add('hljs')

    var pre = codeEl.parentElement
    if (pre && pre.tagName === 'PRE') addLineNumbers(pre, lineCount)
  })
}
