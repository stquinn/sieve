// block-chrome.js — BlockChrome TipTap extension.
// Adds a ProseMirror plugin that renders gutter chrome (line number + drag handle + rail)
// for every top-level block node, plus drag-reorder.
//
// Two-strategy approach to avoid infinite loop with ProseMirror:
//
//   Strategy A — Prose/native nodes → Decoration.widget
//     ProseMirror owns the DOM for prose nodes (p, h1, ul, blockquote, etc.).
//     Injecting a <div> manually as first child causes PM to see foreign DOM,
//     include it in reconciliation, and loop.  Instead we use Decoration.widget
//     at offset+1 with side:-1 so PM tracks it natively.
//
//   Strategy B — Sieve atom nodes → fill existing .block-chrome-host slot
//     sieve-block-extension.js injects a .block-chrome-host div as first child
//     of every Sieve NodeView's DOM during addNodeView().  NodeViews have
//     ignoreMutation logic that suppresses reconciliation for their own DOM.
//     view.update() finds that pre-existing slot and populates it.
//
// Discriminator: a top-level node is a Sieve block when its attrs contain
// serialisedForm (present in BASE_ATTRS for every sieve- node).
//
// Depends on window.TipTap (vendor/tiptap.js) loaded first.
;(function () {
  'use strict'

  var T = window.TipTap
  var Extension = T.Extension
  var Plugin = T.Plugin
  var PluginKey = T.PluginKey
  var Decoration = T.Decoration
  var DecorationSet = T.DecorationSet

  var blockChromeKey = new PluginKey('blockChrome')

  // ── Drag state ──────────────────────────────────────────────────────────────
  // Module-level; cleared on drop or dragend.  { from: number }
  var dragState = null

  // ── Block selection state ────────────────────────────────────────────────────
  // Tracks last handle-clicked block for shift-range selection
  var lastSelectedOffset = null

  // ── Top-level boundary helpers ──────────────────────────────────────────────

  // Given a clientY and the EditorView, find the nearest top-level boundary
  // (doc position: before a node or after the last node).
  // Returns a doc position integer or null.
  function nearestBoundary(view, clientY) {
    var doc = view.state.doc
    // Collect boundary doc positions: before each top-level node, plus after last.
    var positions = []
    doc.forEach(function (node, offset) {
      positions.push(offset)                      // before this node
    })
    if (positions.length > 0) {
      var last = positions[positions.length - 1]
      var lastNode = doc.nodeAt(last)
      if (lastNode) positions.push(last + lastNode.nodeSize)  // after last node
    }
    if (!positions.length) return null

    var bestPos = null
    var bestDist = Infinity
    for (var i = 0; i < positions.length; i++) {
      var p = positions[i]
      // Clamp to valid range for coordsAtPos
      var safeP = Math.max(0, Math.min(p, doc.content.size))
      var domCoords = null
      try { domCoords = view.coordsAtPos(safeP) } catch (_) { continue }
      if (!domCoords) continue
      var dist = Math.abs(domCoords.top - clientY)
      if (dist < bestDist) {
        bestDist = dist
        bestPos = p
      }
    }
    return bestPos
  }

  // ── Is this a Sieve block node? ──────────────────────────────────────────────
  // Sieve blocks carry serialisedForm in BASE_ATTRS. Prose nodes never do.

  function isSieveNode(node) {
    return node.attrs && node.attrs.serialisedForm !== undefined
  }

  // ── Create chrome host DOM for a widget (Strategy A — prose nodes) ───────────
  // Returns a configured .block-chrome-host element with event listeners wired.
  // blockIndex is 1-based. offset is the doc offset of the node (for drag pos).
  // getPos is the PM widget factory's getPos callback (may be null in fallback).

  function createChromeHostWidget(blockIndex, offset, view, getPos) {
    var host = document.createElement('div')
    host.className = 'block-chrome-host'
    host.setAttribute('contenteditable', 'false')
    host.setAttribute('data-chrome-strategy', 'prose')

    var num = document.createElement('span')
    num.className = 'block-chrome-linenum'
    num.textContent = String(blockIndex)

    var handle = document.createElement('span')
    handle.className = 'block-chrome-handle'
    handle.setAttribute('draggable', 'true')
    handle.textContent = '⠿'   // 2×3 drag-dots glyph

    var rail = document.createElement('span')
    rail.className = 'block-chrome-rail'

    host.appendChild(num)
    host.appendChild(handle)
    host.appendChild(rail)

    // ── mousedown: select the entire top-level node or shift-click range ─────
    handle.addEventListener('mousedown', function (e) {
      // stopPropagation (not preventDefault): prevents PM from creating a
      // spurious TextSelection, but allows the browser to detect a subsequent
      // drag gesture from this element (preventDefault would suppress dragstart).
      e.stopPropagation()
      var editor = window.__tiptap
      if (!editor) return

      if (e.shiftKey && lastSelectedOffset != null) {
        // Shift-click: extend to a block range spanning from lastSelectedOffset to this block
        var doc = editor.state.doc
        var a = lastSelectedOffset
        var b = offset
        var lo = Math.min(a, b)
        var hi = Math.max(a, b)
        var hiNode = doc.nodeAt(hi)
        var to = hi + (hiNode ? hiNode.nodeSize : 1)
        editor.commands.setTextSelection({ from: lo, to: to })
      } else {
        lastSelectedOffset = offset
        editor.commands.setNodeSelection(offset)
      }
      view.focus()
    })

    // ── dragstart: record source pos ───────────────────────────────────
    handle.addEventListener('dragstart', function (e) {
      dragState = { from: offset }
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-sieve-block', String(offset))
      // stopImmediatePropagation: blocks PM's bubble-phase dragstart from seeing
      // this event and starting its own NodeSelection drag (which would double-insert).
      // Do NOT preventDefault — that cancels the drag and shows the stop cursor.
      e.stopImmediatePropagation()
      try {
        var domNode = view.nodeDOM(offset)
        var imgEl = domNode && (domNode.nodeType === 1 ? domNode : domNode.parentElement)
        if (imgEl && imgEl.nodeType === 1) e.dataTransfer.setDragImage(imgEl, 0, 0)
      } catch (_) {}
    })

    // ── dragend: clean up if drop didn't fire (e.g. dropped outside editor)
    handle.addEventListener('dragend', function () {
      dragState = null
    })

    return host
  }

  // ── Populate a single .block-chrome-host element (Strategy B — Sieve nodes) ──
  // Creates (or reuses) the line number, handle, and rail children.
  // blockIndex is 1-based.

  function populateChromeHost(host, blockIndex, pos, view) {
    // Idempotency: if already populated with the correct index, skip.
    var linenum = host.querySelector('.block-chrome-linenum')
    if (linenum && linenum.textContent === String(blockIndex)) return

    // Clear any stale content.
    while (host.firstChild) host.removeChild(host.firstChild)

    var num = document.createElement('span')
    num.className = 'block-chrome-linenum'
    num.textContent = String(blockIndex)

    var handle = document.createElement('span')
    handle.className = 'block-chrome-handle'
    handle.setAttribute('draggable', 'true')
    handle.textContent = '⠿'   // 2×3 drag-dots glyph

    var rail = document.createElement('span')
    rail.className = 'block-chrome-rail'

    host.appendChild(num)
    host.appendChild(handle)
    host.appendChild(rail)

    // ── mousedown: select the entire top-level node or shift-click range ─────
    handle.addEventListener('mousedown', function (e) {
      e.stopPropagation()
      var editor = window.__tiptap
      if (!editor) return

      if (e.shiftKey && lastSelectedOffset != null) {
        // Shift-click: extend to a block range spanning from lastSelectedOffset to this block
        var doc = editor.state.doc
        var a = lastSelectedOffset
        var b = pos
        var lo = Math.min(a, b)
        var hi = Math.max(a, b)
        var hiNode = doc.nodeAt(hi)
        var to = hi + (hiNode ? hiNode.nodeSize : 1)
        editor.commands.setTextSelection({ from: lo, to: to })
      } else {
        lastSelectedOffset = pos
        editor.commands.setNodeSelection(pos)
      }
      view.focus()
    })

    // ── dragstart: record source pos ───────────────────────────────────
    handle.addEventListener('dragstart', function (e) {
      dragState = { from: pos }
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-sieve-block', String(pos))
      e.stopImmediatePropagation()
      try {
        var domNode = view.nodeDOM(pos)
        var imgEl = domNode && (domNode.nodeType === 1 ? domNode : domNode.parentElement)
        if (imgEl && imgEl.nodeType === 1) e.dataTransfer.setDragImage(imgEl, 0, 0)
      } catch (_) {}
    })

    // ── dragend: clean up if drop didn't fire (e.g. dropped outside editor)
    handle.addEventListener('dragend', function () {
      dragState = null
    })
  }

  // ── Build Decoration set ─────────────────────────────────────────────────────
  // For every top-level node:
  //   1. Decoration.node — applies class 'block-with-chrome' (CSS positioning hook)
  //   2. Decoration.widget at offset+1 — only for PROSE nodes (Strategy A).
  //      Sieve nodes have their host slot filled by view.update() (Strategy B).
  // Also adds the drop-indicator widget during drag.

  function buildDecorations(state) {
    var decos = []
    var index = 0

    state.doc.forEach(function (node, offset) {
      var i = index++   // capture for closure
      var from = offset
      var to   = offset + node.nodeSize

      // Always mark the block for CSS gutter positioning.
      decos.push(
        Decoration.node(from, to, { class: 'block-with-chrome' })
      )

      // Strategy A: prose/native nodes only.
      // Widget placed at `offset` (BEFORE the node) with side:1 so it renders
      // as a DOM sibling preceding the block element inside .ProseMirror, NOT
      // inside the <p>. This is critical: draggable="true" inside a nested
      // contenteditable context is unreliable in browsers. As a direct sibling
      // of .ProseMirror with contenteditable="false", drag works correctly.
      if (!isSieveNode(node)) {
        decos.push(
          Decoration.widget(
            offset,
            function (widgetView, getPos) {
              return createChromeHostWidget(i + 1, offset, widgetView, getPos)
            },
            { side: 1, key: 'chrome-' + offset }
          )
        )
      }
    })

    return DecorationSet.create(state.doc, decos)
  }

  // ── Sync Sieve block chrome hosts (Strategy B) ───────────────────────────────
  // Called from view.update() on every state change.
  // ONLY fills the .block-chrome-host slot that sieve-block-extension.js has
  // already injected. Never touches prose nodes — those are handled by
  // Decoration.widget (Strategy A).

  function syncSieveChrome(editorView) {
    var index = 0
    editorView.state.doc.forEach(function (node, offset) {
      var i = index++
      if (!isSieveNode(node)) return   // prose node — Decoration.widget handles it

      var nodeDOM = editorView.nodeDOM(offset)
      if (!nodeDOM) return

      // The chrome host was injected as first child by sieve-block-extension.js.
      var host = nodeDOM.querySelector(':scope > .block-chrome-host')
      if (!host) return

      populateChromeHost(host, i + 1, offset, editorView)
    })
  }

  // ── Plugin ─────────────────────────────────────────────────────────────────

  var BlockChrome = Extension.create({
    name: 'blockChrome',
    addProseMirrorPlugins: function () {
      return [
        new Plugin({
          key: blockChromeKey,

          props: {
            // ── Decorations ───────────────────────────────────────────────
            decorations: function (state) {
              return buildDecorations(state)
            },

            // ── DOM event handlers ─────────────────────────────────────────
            handleDOMEvents: {

            // dragover: allow our handle drags to drop
              dragover: function (view, event) {
                if (!dragState) return false
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                return true
              },

              // mouseup: when the cursor is released inside a sieve atom's DOM,
            // ensure the selection covers the whole atom.
            //
            // Sieve blocks have contentEditable=true at root so PM can interact
            // with them, but their atoms can't be partially selected — the head
            // of a drag-select snaps to just before the atom boundary.  We catch
            // the mouseup event (which fires on the actual element under the
            // cursor, unlike drag events) and extend the selection to include the
            // whole atom.  For a plain click on a sieve block body we create a
            // NodeSelection.
              mouseup: function (view, event) {
                if (dragState) return false   // handle-drag, not a selection gesture

                var editor = window.__tiptap
                if (!editor) return false

                // Use event.target (the element under the cursor at release)
                // to identify which sieve atom, if any, we're over.
                var overOffset = null
                var overEnd = null
                editor.state.doc.forEach(function (node, offset) {
                  if (!isSieveNode(node) || overOffset !== null) return
                  var dom = view.nodeDOM(offset)
                  if (!dom) return
                  if (dom === event.target || dom.contains(event.target)) {
                    overOffset = offset
                    overEnd = offset + node.nodeSize
                  }
                })

                if (overOffset === null) return false

                var sel = editor.state.selection

                if (sel.empty) {
                  // Plain click on sieve block body → NodeSelection
                  editor.commands.setNodeSelection(overOffset)
                  return true
                }

                if (sel.from <= overOffset && sel.to >= overEnd) return false  // already covered

                // Extend the selection head to include the whole sieve atom.
                var anchor = sel.anchor
                var newHead = anchor <= overOffset ? overEnd : overOffset
                editor.commands.setTextSelection({
                  from: Math.min(anchor, newHead),
                  to: Math.max(anchor, newHead),
                })
                return true
              },

              // drop: single-transaction reorder
              drop: function (view, event) {
                if (!dragState) return false
                event.preventDefault()

                var from = dragState.from
                dragState = null

                var targetPos = nearestBoundary(view, event.clientY)
                if (targetPos == null) return true

                var doc = view.state.doc
                var node = doc.nodeAt(from)
                if (!node) return true

                var nodeSize = node.nodeSize
                if (targetPos === from || targetPos === from + nodeSize) return true

                // Single transaction: delete source + map insert position.
                // One tr = one Mod+Z undo step.
                var tr = view.state.tr
                tr.delete(from, from + nodeSize)
                tr.insert(tr.mapping.map(targetPos), node)
                view.dispatch(tr)
                return true
              },
            },
          },

          // ── view() callback: sync Sieve chrome hosts after every state update ─
          // Strategy B only: fills the .block-chrome-host slot that
          // sieve-block-extension.js injected.  Prose nodes are handled by
          // Decoration.widget (Strategy A) — never touch those here.
          view: function (editorView) {
            requestAnimationFrame(function () { syncSieveChrome(editorView) })

            // ── Drag-select preview ────────────────────────────────────────────
            // CSS :hover does not update during a mouse-button-held drag because
            // the browser captures the mouse to the drag origin.  Instead we use
            // mousemove + elementFromPoint to find the block under the cursor and
            // add .drag-hover directly to its DOM element.
            var dragHoverEl = null
            var mouseIsDown = false

            function clearDragHover() {
              if (dragHoverEl) {
                dragHoverEl.classList.remove('drag-hover')
                dragHoverEl = null
              }
            }

            function onMouseDown(e) {
              if (e.button === 0) mouseIsDown = true
            }

            function onMouseMove(e) {
              if (!mouseIsDown || dragState) { clearDragHover(); return }
              var el = document.elementFromPoint(e.clientX, e.clientY)
              var blockEl = null
              while (el && el !== editorView.dom) {
                if (el.classList && el.classList.contains('block-with-chrome')) {
                  blockEl = el; break
                }
                el = el.parentElement
              }
              if (blockEl !== dragHoverEl) {
                clearDragHover()
                if (blockEl) { blockEl.classList.add('drag-hover'); dragHoverEl = blockEl }
              }
            }

            function onMouseUp() {
              mouseIsDown = false
              clearDragHover()
            }

            document.addEventListener('mousedown', onMouseDown)
            document.addEventListener('mousemove', onMouseMove)
            document.addEventListener('mouseup', onMouseUp)

            return {
              update: function (view) {
                requestAnimationFrame(function () { syncSieveChrome(view) })
              },
              destroy: function () {
                document.removeEventListener('mousedown', onMouseDown)
                document.removeEventListener('mousemove', onMouseMove)
                document.removeEventListener('mouseup', onMouseUp)
              },
            }
          },
        }),
      ]
    },
  })

  T.BlockChrome = BlockChrome
})()
