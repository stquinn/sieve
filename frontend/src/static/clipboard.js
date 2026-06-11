;(function () {
  'use strict'

  /**
   * buildCopyPayload — build a sieve/slice clipboard payload from the current
   * ProseMirror selection.
   *
   * @param {EditorView} view  ProseMirror EditorView (NOT the TipTap editor)
   * @returns {{ slice: Array<{kind: string, serialisedForm: string}>, markdown: string }}
   */
  function buildCopyPayload(view) {
    var sel = view.state.selection
    var parts = []

    view.state.doc.nodesBetween(sel.from, sel.to, function (node) {
      if (node.type.name.startsWith('sieve-')) {
        parts.push({
          kind: node.attrs.kind,
          serialisedForm: node.attrs.serialisedForm || '',
        })
        // Do not descend into sieve node children
        return false
      }
    })

    var md = ''
    try {
      if (window.__tiptap && window.__tiptap.storage && window.__tiptap.storage.markdown) {
        md = window.__tiptap.storage.markdown.getMarkdown() || ''
      }
    } catch (e) {
      // fall through to per-part fallback
    }
    if (!md) {
      md = parts.map(function (p) { return p.serialisedForm }).join('\n\n')
    }

    return { slice: parts, markdown: md }
  }

  window.SieveClipboard = { buildCopyPayload: buildCopyPayload }
})()
