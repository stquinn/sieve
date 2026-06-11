;(function () {
  'use strict'

  /**
   * buildCopyPayload — build a sieve/slice clipboard payload from the current
   * ProseMirror selection.
   *
   * @param {EditorView} view  ProseMirror EditorView (NOT the TipTap editor)
   * @returns {{ slice: Array<object>, markdown: string } | null}  null when no sieve nodes in selection
   */
  function buildCopyPayload(view) {
    var sel = view.state.selection
    var parts = []

    // If the selection contains any non-sieve (prose) top-level nodes, return
    // null and let the browser's default copy run — that preserves prose text.
    // Only intercept for pure-sieve selections (single or range via handle-click).
    var hasProse = false
    view.state.doc.forEach(function (node, offset) {
      if (hasProse) return
      var nodeEnd = offset + node.nodeSize
      if (nodeEnd > sel.from && offset < sel.to) {
        if (!node.type.name.startsWith('sieve-')) hasProse = true
      }
    })
    if (hasProse) return null

    view.state.doc.nodesBetween(sel.from, sel.to, function (node) {
      if (node.type.name.startsWith('sieve-')) {
        var allAttrs = {}
        var nodeAttrs = node.attrs
        for (var key in nodeAttrs) {
          if (Object.prototype.hasOwnProperty.call(nodeAttrs, key)) {
            allAttrs[key] = nodeAttrs[key]
          }
        }
        parts.push(allAttrs)
        // Do not descend into sieve node children
        return false
      }
    })

    if (parts.length === 0) return null

    var md = parts.map(function (p) { return p.serialisedForm || '' }).join('\n\n')
    if (!md) {
      try {
        if (window.__tiptap && window.__tiptap.storage && window.__tiptap.storage.markdown) {
          md = window.__tiptap.storage.markdown.getMarkdown() || ''
        }
      } catch (_) {}
    }

    return { slice: parts, markdown: md }
  }

  window.SieveClipboard = { buildCopyPayload: buildCopyPayload }
})()
