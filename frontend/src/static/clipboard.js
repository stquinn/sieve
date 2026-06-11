;(function () {
  'use strict'

  // buildCopyPayload — build a sieve/slice clipboard payload from the current
  // ProseMirror selection.
  //
  // The payload is an ORDERED array of items covering every top-level node in
  // the selection:
  //   { _type: 'prose', json: <PM node JSON> }   — prose/native node
  //   { _type: 'sieve', kind, attrs: {...} }      — sieve block (all attrs)
  //
  // Returns null when the selection contains no sieve nodes (nothing to intercept).
  //
  // @param {EditorView} view  ProseMirror EditorView (NOT the TipTap editor)
  // @returns {{ blocks: Array, markdown: string } | null}
  function buildCopyPayload(view) {
    var sel = view.state.selection
    var items = []
    var hasSieve = false

    view.state.doc.forEach(function (node, offset) {
      var nodeEnd = offset + node.nodeSize
      // Skip nodes entirely outside the selection
      if (nodeEnd <= sel.from || offset >= sel.to) return

      if (node.type.name.startsWith('sieve-')) {
        hasSieve = true
        var allAttrs = {}
        var nodeAttrs = node.attrs
        for (var key in nodeAttrs) {
          if (Object.prototype.hasOwnProperty.call(nodeAttrs, key)) {
            allAttrs[key] = nodeAttrs[key]
          }
        }
        items.push({ _type: 'sieve', kind: node.attrs.kind, attrs: allAttrs })
      } else {
        // Prose/native node: serialize to ProseMirror JSON so insertContent
        // can reconstruct it with full formatting on paste.
        items.push({ _type: 'prose', json: node.toJSON() })
      }
    })

    if (!hasSieve) return null

    // text/plain: sieve fences and prose plain-text in document order.
    // Used as the degraded fallback when pasting into external editors.
    var md = items.map(function (item) {
      if (item._type === 'sieve') return item.attrs.serialisedForm || ''
      return extractText(item.json)
    }).filter(Boolean).join('\n\n')

    return { blocks: items, markdown: md }
  }

  // Recursively extract plain text from a ProseMirror node JSON object.
  function extractText(json) {
    if (!json) return ''
    if (json.text) return json.text
    if (!json.content) return ''
    return json.content.map(extractText).join('')
  }

  window.SieveClipboard = { buildCopyPayload: buildCopyPayload }
})()
