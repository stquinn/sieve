import re

with open('frontend/src/static/extensions.js', 'r') as f:
    content = f.read()

replacement = """  // ── buildAiContext ─────────────────────────────────────────────────────────

  function buildAiContext(editor, isMarkdownMode, rawMd, uuid) {
    if (isMarkdownMode) {
      var ta = document.querySelector('.markdown-raw')
      if (ta && ta.selectionStart !== ta.selectionEnd) {
        return { blockRef: 'doc', contextLabel: 'Selection' }
      }
      return { blockRef: 'doc', contextLabel: 'Document' }
    }

    var selection = editor.state.selection
    var doc = editor.state.doc
    var from = selection.from, to = selection.to

    var aiBlockRef = '', aiBlockId = ''

    // Native browser selection check for rendered AI blocks
    var nativeSel = window.getSelection()
    if (nativeSel && !nativeSel.isCollapsed) {
      var anchorEl = nativeSel.anchorNode
      var el = anchorEl && anchorEl.nodeType === 3 ? anchorEl.parentElement : anchorEl
      while (el && !el.classList.contains('ai-block')) el = el.parentElement
      if (el && el.classList.contains('ai-block')) {
        var nativeId = el.getAttribute('data-ai-block-id') || el.getAttribute('data-ai-id') || ''
        doc.descendants(function (node) {
          if ((node.type.name === 'aiBlock' || node.type.name === 'sieve-ai-block') && node.attrs.id === nativeId) {
            aiBlockId = nativeId; aiBlockRef = node.attrs.ref || ''; return false
          }
        })
      }
    }

    var $from = editor.state.selection.$from
    if (!aiBlockId) {
      for (var d = $from.depth; d >= 0; d--) {
        var n = $from.node(d)
        if (n.type.name === 'aiBlock' || n.type.name === 'sieve-ai-block') { aiBlockId = n.attrs.id || ''; aiBlockRef = n.attrs.ref || ''; break }
      }
    }
    if (!aiBlockId) {
      doc.nodesBetween(from, to, function (node) {
        if (node.type.name === 'aiBlock' || node.type.name === 'sieve-ai-block') { aiBlockId = node.attrs.id || ''; aiBlockRef = node.attrs.ref || ''; return false }
      })
    }
    if (!aiBlockId) {
      var $pos = selection.$from
      for (var d2 = 0; d2 <= $pos.depth; d2++) {
        var idx = $pos.index(d2)
        if (idx > 0) {
          var prevSibling = $pos.node(d2).child(idx - 1)
          if (prevSibling && (prevSibling.type.name === 'aiBlock' || prevSibling.type.name === 'sieve-ai-block')) {
            aiBlockId = prevSibling.attrs.id || ''
            aiBlockRef = prevSibling.attrs.ref || ''
            break
          }
        }
      }
    }

    if (aiBlockId) {
      var newRef = aiBlockRef && aiBlockRef !== 'doc' ? aiBlockRef + ',' + aiBlockId : aiBlockId
      return { blockRef: newRef, contextLabel: 'Follow-up' }
    }

    var targetNode = null, targetPos = -1
    var scanFrom = (from === to) ? Math.max(0, from - 1) : from
    var scanTo   = (from === to) ? Math.min(doc.content.size, to + 1) : to
    doc.nodesBetween(scanFrom, scanTo, function (node, pos) {
      if (!targetNode && (node.type.name === 'sieve-smart-image' || node.type.name === 'codeBlock' || node.type.name === 'table' || node.type.name === 'sieve-web-clip' || node.type.name === 'sieve-code')) {
        targetNode = node; targetPos = pos; return false
      }
    })

    function labelFor(node) {
      switch (node.type.name) {
        case 'sieve-smart-image': return 'Image'
        case 'codeBlock':         return 'Code Block'
        case 'sieve-code':        return 'Code Block'
        case 'table':             return 'Table'
        case 'sieve-web-clip':    return 'Web Clip'
        default:                  return node.type.name
      }
    }

    var blockRange = null, contextLabel = ''
    if (targetNode && from === targetPos && to === targetPos + targetNode.nodeSize) {
      contextLabel = labelFor(targetNode)
    } else if (from !== to) {
      blockRange = selection.$from.blockRange(selection.$to)
      contextLabel = 'Selection'
    } else if (targetNode) {
      contextLabel = labelFor(targetNode)
    } else {
      contextLabel = 'Document'
    }

    var existingBlockId = ''
    for (var d = selection.$from.depth; d >= 0; d--) {
      var n = selection.$from.node(d)
      if (n.type.name === 'blockRef') {
        existingBlockId = n.attrs.id || ''
        break
      }
    }
    if (!existingBlockId && targetNode && from >= targetPos && to <= targetPos + targetNode.nodeSize) {
      existingBlockId = targetNode.attrs.id || ''
    } else if (!existingBlockId && blockRange) {
      doc.nodesBetween(blockRange.start, blockRange.end, function (node) {
        if (!existingBlockId && node.type.name === 'blockRef' && node.attrs.id) {
          existingBlockId = node.attrs.id; return false
        }
      })
    }

    var blockRef = existingBlockId || 'blk-' + Math.random().toString(16).substring(2, 6)
    var tr = editor.state.tr
    var NodeRange = T.NodeRange

    if (!existingBlockId) {
      try {
        if (targetNode && from >= targetPos && to <= targetPos + targetNode.nodeSize) {
          if (targetNode.type.name === 'table') {
            var $from = doc.resolve(targetPos)
            var $to = doc.resolve(targetPos + targetNode.nodeSize)
            var topRange = new NodeRange($from, $to, 0)
            tr.wrap(topRange, [{ type: editor.state.schema.nodes.blockRef, attrs: { id: blockRef } }])
          } else {
            tr.setNodeMarkup(targetPos, undefined, Object.assign({}, targetNode.attrs, { id: blockRef }))
          }
        } else if (blockRange) {
          var topRange = new NodeRange(blockRange.$from, blockRange.$to, 0)
          tr.wrap(topRange, [{ type: editor.state.schema.nodes.blockRef, attrs: { id: blockRef } }])
        }
      } catch (e) {
        // tr.wrap can fail for complex selections; proceed without wrapping
        blockRef = existingBlockId || 'doc'
      }
    }

    var finalImageIds = []
    if (from !== to || targetNode || blockRange) {
      var seenIds = new Set()
      var scanRangeFrom = targetNode ? targetPos : (blockRange ? blockRange.start : from)
      var scanRangeTo   = targetNode ? targetPos + targetNode.nodeSize : (blockRange ? blockRange.end : to)
      doc.nodesBetween(scanRangeFrom, scanRangeTo, function (node) {
        if (node.type.name === 'sieve-smart-image' && node.attrs && node.attrs.id) {
          var id = node.attrs.id
          if (!seenIds.has(id)) { seenIds.add(id); finalImageIds.push(id) }
        }
      })
    }

    if (tr.docChanged) editor.view.dispatch(tr)

    return {
      blockRef: (from === to && !targetNode && !blockRange) ? 'doc' : blockRef,
      contextLabel: contextLabel,
    }
  }

"""

start_marker = "  // ── buildAiContext ─────────────────────────────────────────────────────────"
end_marker = "  // ── HighlightMark ──────────────────────────────────────────────────────────"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

new_content = content[:start_idx] + replacement + content[end_idx:]

with open('frontend/src/static/extensions.js', 'w') as f:
    f.write(new_content)

