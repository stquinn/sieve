// fenced-block-base.js — shared utilities for fenced YAML block NodeView extensions.
// All fenced block extensions (ai-block, web-clip, diagram, …) import from here.
//
// Go pattern: fencedblock.Serialize generates YAML; JS replays rawYaml verbatim (never regenerates).
// JS pattern: call applyHighlighting(contentEl) after setting innerHTML — gives box styling + syntax colours.

import { renderSanctionedMarkdown } from '../block/renderers/sanctioned-markdown.js'

// BlockRenderer / ContractViolation — the renderer half of the renderer/
// NodeView split (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md).
// They LIVE in block/renderers/ (the PM-free renderer package mirroring Go
// block packages — see the spec's package layout); re-exported here so
// every fenced block extension can keep importing its shared machinery from
// this one file.
export { BlockRenderer, ContractViolation } from '../block/renderers/block-renderer.js'

// getLowlight / hastToHtml / applyHighlighting — also LIVE in block/renderers/
// (highlighting.js), the same "engines a renderer needs" home as
// sanctioned-markdown.js (BlockRenderer's default fillTitle/fillBody call
// applyHighlighting after rendering); re-exported here for the existing
// import site — every fenced block extension keeps importing its shared
// machinery from this one file.
export { getLowlight, hastToHtml, applyHighlighting } from '../block/renderers/highlighting.js'

// renderMarkdown — renders text via the SANCTIONED markdown-it instance
// (html:false; docs/design/archive/specs/2026-07-20-block-renderer-extraction.md
// §Content lanes / §Body/title pull-back — DEFECT SEC-B, issue #48). The
// `editor` param is kept for call-site compatibility (existing callers still
// pass the TipTap editor reference) but is no longer consulted: this function
// must NEVER borrow the editor's own (html:true) markdown-it instance for a
// direct innerHTML write — that instance stays confined to PM parse paths,
// where the schema filters raw HTML before it reaches the DOM. See
// block/renderers/sanctioned-markdown.js for the full rationale.
export function renderMarkdown(text, _editor) {
  return renderSanctionedMarkdown(text)
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
var _queuedJobIds = new Set()

// Seed on module load from /api/jobs → {active:[...],queued:[...]}.
fetch('/api/jobs')
  .then(function (r) { return r.json() })
  .then(function (data) {
    ;(data.active || []).forEach(function (j) { if (j.jobId) _activeJobIds.add(j.jobId) })
    ;(data.queued || []).forEach(function (j) { if (j.jobId) _queuedJobIds.add(j.jobId) })
  })
  .catch(function () {})

// Full-snapshot listener: authoritative replacement of both tracked sets.
document.addEventListener('sse:jobs:changed', function (e) {
  try {
    var raw = e.detail && e.detail.data != null ? e.detail.data : (typeof e.detail === 'string' ? e.detail : '{}')
    var payload = JSON.parse(raw)
    _activeJobIds.clear()
    _queuedJobIds.clear()
    ;(payload.active || []).forEach(function (j) { if (j.jobId) _activeJobIds.add(j.jobId) })
    ;(payload.queued || []).forEach(function (j) { if (j.jobId) _queuedJobIds.add(j.jobId) })
  } catch (_) {}
})

// isJobActive — true if the job is running on the server right now.
export function isJobActive(id) {
  return !!id && _activeJobIds.has(id)
}

// isJobQueued — true if the job is waiting in the engine queue (not yet running).
export function isJobQueued(id) {
  return !!id && _queuedJobIds.has(id)
}

// isJobStale — a block's job is stale only if the server has NO record of it
// (neither active NOR queued) AND it has exceeded the CLI-timeout threshold. A
// QUEUED job is waiting to run on a bounded worker pool — it is NOT stale/timed
// out, even once createdAt passes the threshold. This is the queued≠timeout fix.
export function isJobStale(createdAt, id) {
  if (isJobActive(id) || isJobQueued(id)) return false
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
