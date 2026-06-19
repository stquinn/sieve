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

  // isFlowingText: the ONE discriminator (D-r.7). A top-level node is flowing text
  // iff it is a paragraph or heading — content a bare caret can't disambiguate, so
  // it targets the whole document. EVERY other top-level node (blockquote, code,
  // list, table, image, hr, and all structured sieve-*) is a discrete UNIT you
  // target as a whole by its id.
  function isFlowingText(node) {
    if (!node) return false
    var nm = node.type.name
    return nm === 'paragraph' || nm === 'heading'
  }

  // topLevelIdsBetween: the distinct ids of every top-level (depth-1) block the
  // range [from,to] crosses, in document order — the selection ref chain (bug-1
  // fix). A block is crossed iff its span intersects the range.
  function topLevelIdsBetween(doc, from, to) {
    var ids = []
    doc.forEach(function (node, offset) {
      var start = offset, end = offset + node.nodeSize
      if (start < to && end > from) {
        var id = node.attrs && node.attrs.id
        if (id && ids.indexOf(id) === -1) ids.push(id)
      }
    })
    return ids
  }

  // topLevelForCaret: the top-level (depth-1) block enclosing or adjacent to a
  // bare caret, as { node, pos }, or null. A DOM-anchored UNIT wins first (focus
  // inside a sieve block's NodeView, whose PM selection may sit at a nearby
  // gap) — but never a flowing-text paragraph, so it can't hijack the caret's real
  // position. Then the enclosing depth-1 node; then, at a doc-level gap (a caret
  // after an atom / at doc end), the adjacent unit.
  function topLevelForCaret(state) {
    var doc = state.doc, $from = state.selection.$from

    var domId = domBlockId()
    if (domId) {
      var hit = null
      doc.forEach(function (node, offset) {
        if (hit) return
        if (node.attrs && node.attrs.id === domId) hit = { node: node, pos: offset }
      })
      if (hit && !isFlowingText(hit.node)) return hit
    }

    if ($from.depth >= 1) return { node: $from.node(1), pos: $from.before(1) }

    var before = $from.nodeBefore
    if (before && !isFlowingText(before)) return { node: before, pos: $from.pos - before.nodeSize }
    var after = $from.nodeAfter
    if (after && !isFlowingText(after)) return { node: after, pos: $from.pos }
    return null
  }

  // blockResult: the { kind:'block', … } shape for a unit/NodeSelection target.
  function blockResult(node, pos) {
    var id = (node.attrs && node.attrs.id) || ''
    return {
      kind: 'block', id: id, ref: id,
      range: { from: pos, to: pos + node.nodeSize },
      label: describeTarget(node, null), node: node,
    }
  }

  // Human labels for native unit node types, so the Ask panel header ("Ask About
  // <label>") reads naturally (not "Ask About BulletList").
  var NATIVE_UNIT_LABEL = {
    blockquote: 'Quote', codeBlock: 'Code Block',
    bulletList: 'List', orderedList: 'List', taskList: 'Task List',
    table: 'Table', image: 'Image', horizontalRule: 'Divider',
  }

  // describeTarget(node|null, selectionText|null) → friendly label (no "Ask About"
  // prefix). It is the header the Ask AI panel shows for the resolved target, so
  // every block kind maps to a readable noun.
  function describeTarget(node, selectionText) {
    if (node) {
      var name = node.type.name
      if (name === 'aiBlock' || name === 'sieve-ai-block') return 'Follow-up'
      if (name === 'blockRef') return quoteSnippet(node.textContent || '')
      if (name.indexOf('sieve-') === 0) {
        return (T.getSieveBlockLabel ? T.getSieveBlockLabel(node) : titleCase(node.attrs.kind))
      }
      if (NATIVE_UNIT_LABEL[name]) return NATIVE_UNIT_LABEL[name]
      return titleCase(name)
    }
    if (selectionText != null) return quoteSnippet(selectionText)
    return 'Document'
  }

  // resolveAiTarget(editor, isMarkdownMode) → { kind, id?, ref?, range?, label, node? }
  // Keyed on node CHARACTER (D-r.7). Four ordered cases (see isFlowingText): a
  // whole-node selection or a caret in a unit targets that block by id; a non-empty
  // text selection refs every top-level block it crosses; a bare caret in flowing
  // text → the document. `label` is also the Ask panel header for the target.
  function resolveAiTarget(editor, isMarkdownMode) {
    if (isMarkdownMode) {
      var ta = (typeof document !== 'undefined') ? document.querySelector('.markdown-raw') : null
      if (ta && ta.selectionStart !== ta.selectionEnd) {
        return { kind: 'selection', ref: 'doc', range: null, label: quoteSnippet(ta.value.slice(ta.selectionStart, ta.selectionEnd)) }
      }
      return { kind: 'document', ref: 'doc', range: null, label: 'Document' }
    }

    var state = editor.state
    var sel = state.selection
    var doc = state.doc
    var from = sel.from, to = sel.to

    // (a) NodeSelection of any block → that block by id.
    if (sel.node) return blockResult(sel.node, sel.from)

    // (b) non-empty TextSelection → selection + ref chain of every crossed block.
    if (from !== to) {
      var ids = topLevelIdsBetween(doc, from, to)
      return {
        kind: 'selection', ref: ids.join(',') || 'doc',
        range: { from: from, to: to },
        label: describeTarget(null, doc.textBetween(from, to, ' ')),
      }
    }

    // (c) bare caret in a UNIT (blockquote, code, list, table, image, hr, sieve-*).
    var top = topLevelForCaret(state)
    if (top && !isFlowingText(top.node)) return blockResult(top.node, top.pos)

    // (d) bare caret in flowing text (paragraph/heading) or nothing → document.
    return { kind: 'document', ref: 'doc', range: null, label: 'Document' }
  }

  // aiInsertPos(state) → doc position where the AI answer block should be inserted.
  // The answer must be a SIBLING that FOLLOWS the target block, never nested inside
  // it. After a SEND-time mint the caret sits inside a freshly-wrapped blockRef
  // anchor, so selection.to would land the block inside the anchor — this returns
  // the position immediately after the shallowest enclosing target block instead.
  // Plain cursor / document targets fall back to the caret (selection.to).
  function aiInsertPos(state) {
    var sel = state.selection
    // Whole-node selection (e.g. a sieve block): selection.to already sits after it.
    if (sel.node) return sel.to
    var $from = sel.$from
    for (var d = 1; d <= $from.depth; d++) {
      if (isTargetName($from.node(d).type.name)) return $from.after(d)
    }
    return sel.to
  }

  T.titleCase = titleCase
  T.quoteSnippet = quoteSnippet
  T.describeTarget = describeTarget
  T.resolveAiTarget = resolveAiTarget
  T.aiInsertPos = aiInsertPos
})()
