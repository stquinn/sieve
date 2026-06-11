// ai-target.js — pure, read-only AI target resolution.
// The single source of truth for "what would Ask AI act on right now".
// NO mutation, ever. Safe to call on every caret move. No TipTap-construction
// deps, so it loads in Node (vitest) with a minimal window.TipTap stub.
;(function () {
  'use strict'
  var T = (typeof window !== 'undefined' && window.TipTap) ? window.TipTap : (window.TipTap = {})

  function titleCase(kind) {
    if (!kind) return 'Block'
    return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')
  }

  // Quote + truncate a snippet on a word boundary near 20 chars.
  function quoteSnippet(text) {
    var s = (text || '').replace(/\s+/g, ' ').trim()
    if (!s) return 'Selection'
    if (s.length > 20) {
      var cut = s.slice(0, 20)
      var sp = cut.lastIndexOf(' ')
      if (sp > 8) cut = cut.slice(0, sp)
      return '"' + cut + '…"'
    }
    return '"' + s + '"'
  }

  function isSieveName(name) { return name === 'aiBlock' || name === 'sieve-ai-block' || name.indexOf('sieve-') === 0 }
  function isAnchorName(name) { return name === 'blockRef' }
  function isTargetName(name) { return isSieveName(name) || isAnchorName(name) }

  // Read a block id from the DOM focus / native selection (mirrors buildAiContext).
  // Returns '' if none (e.g. in Node tests with no real DOM focus).
  function domBlockId() {
    if (typeof document === 'undefined') return ''
    var el = document.activeElement
    if (el && el.closest) {
      var hit = el.closest('[data-id], [data-type^="sieve-"]')
      if (hit) return hit.getAttribute('data-id') || ''
    }
    var sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null
    if (sel && sel.anchorNode) {
      var node = sel.anchorNode
      if (node.nodeType === 3) node = node.parentElement
      if (node && node.closest) {
        var hit2 = node.closest('[data-id], [data-type^="sieve-"]')
        if (hit2) return hit2.getAttribute('data-id') || ''
      }
    }
    return ''
  }

  // Find the target block node (blockRef anchor or sieve-* block) for the current
  // selection, or null. Native code/table nodes are intentionally NOT targets.
  function findBlockTarget(state) {
    var doc = state.doc, sel = state.selection
    var from = sel.from, to = sel.to

    // Stage 1: DOM-anchored id.
    var domId = domBlockId()
    if (domId) {
      var hit = null
      doc.descendants(function (node, pos) {
        if (hit) return false
        if (node.attrs && node.attrs.id === domId && isTargetName(node.type.name)) {
          hit = { node: node, pos: pos }; return false
        }
      })
      if (hit) return hit
    }

    // Stage 2: ancestor depth walk from the caret.
    for (var d = sel.$from.depth; d >= 1; d--) {
      var anc = sel.$from.node(d)
      if (isTargetName(anc.type.name)) return { node: anc, pos: sel.$from.before(d) }
    }

    // Stage 3: scan the block(s) touched by the caret/selection.
    var scanFrom = (from === to) ? Math.max(0, from - 1) : from
    var scanTo = (from === to) ? Math.min(doc.content.size, to + 1) : to
    var scanned = null
    doc.nodesBetween(scanFrom, scanTo, function (node, pos) {
      if (scanned) return false
      if (isTargetName(node.type.name)) { scanned = { node: node, pos: pos }; return false }
    })
    return scanned
  }

  // describeTarget(node|null, selectionText|null) → friendly label (no "Ask About" prefix)
  function describeTarget(node, selectionText) {
    if (node) {
      var name = node.type.name
      if (name === 'aiBlock' || name === 'sieve-ai-block') return 'Follow-up'
      if (name === 'blockRef') return quoteSnippet(node.textContent || '')
      if (name.indexOf('sieve-') === 0) {
        return (T.getSieveBlockLabel ? T.getSieveBlockLabel(node) : titleCase(node.attrs.kind))
      }
      return titleCase(name)
    }
    if (selectionText != null) return quoteSnippet(selectionText)
    return 'Document'
  }

  // resolveAiTarget(editor, isMarkdownMode) → { kind, id?, range?, label, node? }
  function resolveAiTarget(editor, isMarkdownMode) {
    if (isMarkdownMode) {
      var ta = (typeof document !== 'undefined') ? document.querySelector('.markdown-raw') : null
      if (ta && ta.selectionStart !== ta.selectionEnd) {
        return { kind: 'selection', range: null, label: quoteSnippet(ta.value.slice(ta.selectionStart, ta.selectionEnd)) }
      }
      return { kind: 'document', range: null, label: 'Document' }
    }

    var state = editor.state
    var sel = state.selection
    var doc = state.doc
    var from = sel.from, to = sel.to

    var found = findBlockTarget(state)
    if (found) {
      var n = found.node
      return {
        kind: isAnchorName(n.type.name) ? 'anchor' : 'sieveBlock',
        id: n.attrs.id || '',
        range: { from: found.pos, to: found.pos + n.nodeSize },
        label: describeTarget(n, null),
        node: n,
      }
    }
    if (from !== to) {
      return { kind: 'selection', range: { from: from, to: to }, label: describeTarget(null, doc.textBetween(from, to, ' ')) }
    }
    return { kind: 'document', range: null, label: 'Document' }
  }

  T.titleCase = titleCase
  T.quoteSnippet = quoteSnippet
  T.describeTarget = describeTarget
  T.resolveAiTarget = resolveAiTarget
})()
