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

    var num = document.createElement('span')
    num.className = 'block-chrome-linenum'
    num.textContent = String(blockIndex)

    var handle = document.createElement('span')
    handle.className = 'block-chrome-handle'
    handle.setAttribute('draggable', 'true')
    handle.textContent = '⠷'   // braille drag-dots glyph

    var rail = document.createElement('span')
    rail.className = 'block-chrome-rail'

    host.appendChild(num)
    host.appendChild(handle)
    host.appendChild(rail)

    // ── mousedown: select the entire top-level node ────────────────────
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault()
      // Always use `offset` (the node's opening position), not getPos() which
      // returns offset+1 (inside the node — the widget's own position).
      var editor = window.__tiptap
      if (editor) {
        editor.commands.setNodeSelection(offset)
        view.focus()
      }
    })

    // ── dragstart: record source pos ───────────────────────────────────
    handle.addEventListener('dragstart', function (e) {
      // Always use `offset` (node start), not getPos() (widget position = offset+1).
      // drop handler calls doc.nodeAt(from) which must resolve to the whole block.
      dragState = { from: offset }
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-sieve-block', String(pos))
      // Set drag image to the block's DOM row
      try {
        var domNode = view.nodeDOM(pos)
        var imgEl = domNode && (domNode.nodeType === 1 ? domNode : domNode.parentElement)
        if (imgEl && imgEl.nodeType === 1) e.dataTransfer.setDragImage(imgEl, 0, 0)
      } catch (_) {}
    })

    // ── dragend: clean up (fires even if drop was outside editor) ──────
    handle.addEventListener('dragend', function () {
      if (dragState) {
        dragState = null
        try {
          view.dispatch(
            view.state.tr.setMeta(blockChromeKey, { indicatorPos: null })
          )
        } catch (_) {}
      }
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
    handle.textContent = '⠷'   // braille drag-dots glyph

    var rail = document.createElement('span')
    rail.className = 'block-chrome-rail'

    host.appendChild(num)
    host.appendChild(handle)
    host.appendChild(rail)

    // ── mousedown: select the entire top-level node ────────────────────
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault()
      var editor = window.__tiptap
      if (editor) {
        editor.commands.setNodeSelection(pos)
        view.focus()
      }
    })

    // ── dragstart: record source pos ───────────────────────────────────
    handle.addEventListener('dragstart', function (e) {
      dragState = { from: pos }
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-sieve-block', String(pos))
      // Set drag image to the block's DOM row
      try {
        var domNode = view.nodeDOM(pos)
        var imgEl = domNode && (domNode.nodeType === 1 ? domNode : domNode.parentElement)
        if (imgEl && imgEl.nodeType === 1) e.dataTransfer.setDragImage(imgEl, 0, 0)
      } catch (_) {}
    })

    // ── dragend: clean up (fires even if drop was outside editor) ──────
    handle.addEventListener('dragend', function () {
      if (dragState) {
        dragState = null
        try {
          view.dispatch(
            view.state.tr.setMeta(blockChromeKey, { indicatorPos: null })
          )
        } catch (_) {}
      }
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
      // Sieve nodes already have a .block-chrome-host slot; view.update() fills it.
      if (!isSieveNode(node)) {
        // offset+1 is the first position inside the node.
        // side:-1 places the widget before any content at that position.
        // key ensures PM reuses the same DOM element across re-renders so event
        // listeners survive without being re-attached.
        // Note: offset and i are closure-safe here — each forEach callback
        // invocation has its own scope (offset is a parameter; i is a var local).
        decos.push(
          Decoration.widget(
            offset + 1,
            function (widgetView, getPos) {
              return createChromeHostWidget(i + 1, offset, widgetView, getPos)
            },
            { side: -1, key: 'chrome-' + offset }
          )
        )
      }
    })

    // Drop indicator (only during drag)
    var pluginState = blockChromeKey.getState(state)
    if (pluginState && pluginState.indicatorPos != null) {
      var iPos = pluginState.indicatorPos
      var maxPos = state.doc.content.size
      var clampedPos = Math.max(0, Math.min(iPos, maxPos))
      decos.push(indicatorWidget(clampedPos))
    }

    return DecorationSet.create(state.doc, decos)
  }

  // ── Drop indicator widget ────────────────────────────────────────────────────

  function indicatorWidget(pos) {
    return Decoration.widget(
      pos,
      function () {
        var line = document.createElement('div')
        line.className = 'block-chrome-drop-indicator'
        line.setAttribute('contenteditable', 'false')
        return line
      },
      { side: -1, key: 'drop-indicator' }
    )
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

          // Plugin state: { indicatorPos: number | null }
          state: {
            init: function () { return { indicatorPos: null } },
            apply: function (tr, prev) {
              var meta = tr.getMeta(blockChromeKey)
              if (meta && meta.indicatorPos !== undefined) {
                return { indicatorPos: meta.indicatorPos }
              }
              return prev
            },
          },

          props: {
            // ── Decorations ───────────────────────────────────────────────
            decorations: function (state) {
              return buildDecorations(state)
            },

            // ── DOM event handlers ─────────────────────────────────────────
            handleDOMEvents: {

              // dragstart: claim the event when our handle initiated it, so PM's
            // built-in NodeSelection drag doesn't also fire and double-insert.
            dragstart: function (view, event) {
              return dragState != null
            },

            // dragover: update indicator to nearest boundary
              dragover: function (view, event) {
                if (!dragState) return false
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'

                var targetPos = nearestBoundary(view, event.clientY)
                if (targetPos == null) return true

                var currentState = blockChromeKey.getState(view.state)
                if (!currentState || currentState.indicatorPos !== targetPos) {
                  view.dispatch(
                    view.state.tr.setMeta(blockChromeKey, { indicatorPos: targetPos })
                  )
                }
                return true
              },

              // dragleave: clear indicator when cursor leaves the editor DOM
              dragleave: function (view, event) {
                if (!dragState) return false
                var related = event.relatedTarget
                if (!related || !view.dom.contains(related)) {
                  view.dispatch(
                    view.state.tr.setMeta(blockChromeKey, { indicatorPos: null })
                  )
                }
                return false
              },

              // drop: single-transaction reorder
              drop: function (view, event) {
                if (!dragState) return false
                event.preventDefault()

                var from = dragState.from
                dragState = null

                var targetPos = nearestBoundary(view, event.clientY)

                // Always clear the indicator — embed it in the same transaction
                // as the move (or a no-op transaction if no move).
                if (targetPos == null) {
                  view.dispatch(
                    view.state.tr.setMeta(blockChromeKey, { indicatorPos: null })
                  )
                  return true
                }

                var doc = view.state.doc
                var node = doc.nodeAt(from)
                if (!node) {
                  view.dispatch(
                    view.state.tr.setMeta(blockChromeKey, { indicatorPos: null })
                  )
                  return true
                }

                var nodeSize = node.nodeSize

                // If dropping back onto the same position, just clear indicator
                if (targetPos === from || targetPos === from + nodeSize) {
                  view.dispatch(
                    view.state.tr.setMeta(blockChromeKey, { indicatorPos: null })
                  )
                  return true
                }

                // ── Single transaction: clear indicator + delete + map + insert
                // Both the indicator clear and the doc mutation go in one tr —
                // critical for single-Mod+Z undo integrity.
                var tr = view.state.tr
                tr.setMeta(blockChromeKey, { indicatorPos: null })
                tr.delete(from, from + nodeSize)
                var insertAt = tr.mapping.map(targetPos)
                tr.insert(insertAt, node)
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
            return {
              update: function (view) {
                // Use rAF to run after PM has applied its own DOM mutations.
                requestAnimationFrame(function () {
                  syncSieveChrome(view)
                })
              },
            }
          },
        }),
      ]
    },
  })

  T.BlockChrome = BlockChrome
})()
