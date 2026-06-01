// fenced-block-base.js — shared utilities for fenced YAML block NodeView extensions.
// All fenced block extensions (ai-block, web-clip, diagram, …) import from here.
//
// Go pattern: fencedblock.Serialize generates YAML; JS replays rawYaml verbatim (never regenerates).
// JS pattern: call applyHighlighting(contentEl) after setting innerHTML — gives box styling + syntax colours.

// ── Lowlight (lazy) ───────────────────────────────────────────────────────────

var _lowlight = null

function getLowlight() {
  if (!_lowlight) {
    var T = window.TipTap
    if (T && T.createLowlight && T.common) _lowlight = T.createLowlight(T.common)
  }
  return _lowlight
}

// Minimal hast-to-HTML serialiser. Only handles the subset lowlight emits:
// root/element nodes (become <span class="…">) and text nodes.
function hastToHtml(nodes) {
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
    span.textContent = String(i)
    gutter.appendChild(span)
  }

  pre.parentNode.insertBefore(wrapper, pre)
  wrapper.appendChild(gutter)
  wrapper.appendChild(pre)
}

// ── Exports ───────────────────────────────────────────────────────────────────

// applyHighlighting — walks pre>code elements, applies lowlight syntax colours,
// wraps each block in a .sieve-code-block gutter layout, and marks the container
// with 'sieve-rendered-content'. Future fenced blocks: call this once after
// setting innerHTML on your content div — box, gutter, and colours all apply.
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

// renderMarkdown — renders text using the editor's markdownit instance.
// Pass the TipTap editor reference so the shared parser/theme is reused.
export function renderMarkdown(text, editor) {
  try {
    var md = editor && editor.storage && editor.storage.markdown
    if (md && md.parser && md.parser.md) return md.parser.md.render(text.trim())
  } catch (_) {}
  var div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// esc — HTML-escape a string for use in attribute values.
export function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// isStaleByTime — returns true when createdAt is older than the CLI timeout threshold.
// Blocks with in-flight job tracking can call this and short-circuit on their own check first.
export function isStaleByTime(createdAt) {
  if (!createdAt) return true
  var thresholdMs = (window.__sieveCliTimeoutLong || 60) * 1000 + 30000
  return Date.now() - new Date(createdAt).getTime() > thresholdMs
}
