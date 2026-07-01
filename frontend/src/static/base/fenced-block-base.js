// fenced-block-base.js — shared utilities for fenced YAML block NodeView extensions.
// All fenced block extensions (ai-block, web-clip, diagram, …) import from here.
//
// Go pattern: fencedblock.Serialize generates YAML; JS replays rawYaml verbatim (never regenerates).
// JS pattern: call applyHighlighting(contentEl) after setting innerHTML — gives box styling + syntax colours.

// ── Lowlight (lazy) ───────────────────────────────────────────────────────────

var _lowlight = null

export function getLowlight() {
  if (!_lowlight) {
    var T = window.TipTap
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
  } catch (_) {
    console.log('Failed to render markdown')
  }
  var div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// esc — HTML-escape a string for use in attribute values.
export function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// isStaleByTime — returns true when createdAt is older than the CLI timeout threshold.
export function isStaleByTime(createdAt) {
  if (!createdAt) return true
  var thresholdMs = (window.__sieveCliTimeoutLong || 60) * 1000 + 30000
  return Date.now() - new Date(createdAt).getTime() > thresholdMs
}

// ── Active job tracking ───────────────────────────────────────────────────────
// Shared across all fenced block extensions. Seeded from /api/jobs on module
// load; kept current via jobs:changed (full snapshot) — the sole driver.

var _activeJobIds = new Set()

// Seed on module load from /api/jobs → {active:[...],queued:[...]}.
fetch('/api/jobs')
  .then(function (r) { return r.json() })
  .then(function (data) {
    ;(data.active || []).forEach(function (j) { if (j.jobId) _activeJobIds.add(j.jobId) })
  })
  .catch(function () {})

// Full-snapshot listener: authoritative replacement of the tracked set.
document.addEventListener('sse:jobs:changed', function (e) {
  try {
    var raw = e.detail && e.detail.data != null ? e.detail.data : (typeof e.detail === 'string' ? e.detail : '{}')
    var payload = JSON.parse(raw)
    _activeJobIds.clear()
    ;(payload.active || []).forEach(function (j) { if (j.jobId) _activeJobIds.add(j.jobId) })
  } catch (_) {}
})

// isJobActive — returns true if the given job ID is currently in-flight on the server.
// Use this in block isStale checks before falling back to isStaleByTime.
export function isJobActive(id) {
  return !!id && _activeJobIds.has(id)
}

// isJobStale — checks if a job block is stale. Returns false if the job is active on the server.
// If the job is not active, it falls back to checking the configured CLI timeout threshold.
export function isJobStale(createdAt, id) {
  if (isJobActive(id)) return false
  return isStaleByTime(createdAt)
}

// extractTextFromDOM recursively gathers text from a DOM node.
export function extractTextFromDOM(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (node.nodeName === 'TEXTAREA' || node.nodeName === 'INPUT') return node.value || ''
    if (node.classList && (node.classList.contains('sieve-block__gutter') || node.classList.contains('sieve-block__highlight') || node.classList.contains('sieve-code-block__gutter'))) return ''
  }
  if (node.nodeName === 'BR') return '\n'
  if (node.nodeName === 'DIV' || node.nodeName === 'P' || node.nodeName === 'LI') {
    var inner = Array.from(node.childNodes).map(function(n) { return extractTextFromDOM(n) }).join('')
    return inner + '\n'
  }
  return Array.from(node.childNodes).map(function(n) { return extractTextFromDOM(n) }).join('')
}
