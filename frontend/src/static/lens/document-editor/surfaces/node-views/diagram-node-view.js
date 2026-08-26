// The NodeView adapter for the 'diagram' kind. Look-and-feel — attrs in, DOM
// out, mermaid invocation, the kind's stylesheet — belongs to DiagramRenderer,
// which this file holds by composition. What lives here is everything that
// genuinely speaks ProseMirror: the contentDOM binding, caret capture/restore
// across the mode flip, the lowlight decoration plugin,
// selection/stopEvent/ignoreMutation, and the mode-flip dispatch.
//
// Keyboard behaviour (Tab/Enter/Mod+Enter) comes from the shared
// interaction-policy extension via interactionPolicy + onModEnter — do NOT add a
// handleKeyDown here; docs/editor-interaction-contract.md is normative.
//
// Per-kind SCHEMA DATA (nodeConfig/attrs/parseAttrs) stays here rather than on
// DiagramRenderer, because it is TipTap configuration: attrs.parseHTML reads PM's
// parsed `data-*` attributes and nodeConfig feeds PM's schema builder, both
// consumed only by createSieveNode in sieve-block-extension.js.

import { esc } from '../../../../renderers/html-escape.js'
import { getLowlight } from '../../../../renderers/highlighting.js'
import { T } from '../tiptap-vendor.js'
import { registerSieveRenderer, sieveBlockFor } from '../sieve-block-extension.js'
import { CODE_TEXT_POLICY } from '../../interaction-policy.js'
import { MODE } from '../../../../contract/sieve-block.js'
import { DiagramRenderer } from '../../../../renderers/diagram-renderer.js'

// Re-exported for cross-file consumers (smart-image-node-view.js statically,
// prose-block.js dynamically); both delegate to DiagramRenderer's statics, so
// neither depends on this file's registration having run.
// renderDiagramSvgEntry branches on the engine: mermaid renders locally,
// plantuml fetches its svgAsset.
export function ensureMermaid() { return DiagramRenderer.ensureMermaid() }
export function renderDiagramSvgEntry(sourceNode, entries) { return DiagramRenderer.renderDiagramSvgEntry(sourceNode, entries) }

;(function () {
  'use strict'

  // id → live DiagramRenderer instance. The behaviour-registry paths (policy
  // Mod+Enter, policy expand chord, context menu) resolve the block's renderer
  // here, so every trigger lands on the same verb methods.
  /** @type {Record<string, any>} */
  var liveRenderers = {}

  // The descriptor sieve-block-extension.js's registerSieveRenderer() consumes.
  // Named distinctly from the imported DiagramRenderer CLASS: this is the
  // PM-adapter descriptor, that is the look-and-feel class it holds.

  var DiagramNodeView = {
    // THE mode-flip op: onModEnter, the render body's keydown listener and the
    // header toggle all land on the live renderer's setMode. Caret capture happens
    // in the NodeView's update().
    flipMode: function (attrs) {
      if (!attrs || !attrs.id) return false
      var r = liveRenderers[attrs.id]
      if (!r) return false
      r.setMode(attrs.mode === 'render' ? MODE.EDIT : MODE.RENDER)
      return true
    },

    // Policy-extension entry point (modEnterTogglesMode).
    onModEnter: function (view, selection, _host) {
      var node = selection.node || selection.$from.parent

      // If the selection is stale and focus is actually in the diagram block DOM, resolve it
      if (document.activeElement && view.dom.contains(document.activeElement)) {
        var blockEl = document.activeElement.closest('.sieve-block')
        if (blockEl) {
          try {
            var contentDOM = blockEl.querySelector('code')
            var targetDOM = contentDOM || blockEl
            var blockPos = view.posAtDOM(targetDOM, 0)
            if (blockPos !== undefined && blockPos !== null && blockPos >= 0) {
              var $pos = view.state.doc.resolve(blockPos)
              var resolvedNode = $pos.node(1)
              if (resolvedNode && resolvedNode.type.name === 'sieve-diagram') {
                node = resolvedNode
              }
            }
          } catch (e) {}
        }
      }

      if (!node || node.type.name !== 'sieve-diagram') return false
      return DiagramNodeView.flipMode(node.attrs)
    },

    // Behaviour-registry entry point for the expand capability (policy chord,
    // header, menu). Delegates to the live renderer's expandContent().
    /** @returns {{ element: Element|null, title: string, mode: 'media' } | null} */
    getExpandContent: function (node) {
      var r = node && node.attrs && liveRenderers[node.attrs.id]
      return r ? r.expandContent() : null
    },

    // Edit mode IS literal source text, so the code preset applies wholesale.
    // caretStop:'render' — a caret stop only in render mode. Mod+Enter is this
    // kind's declared override: mode toggle, not escape.
    interactionPolicy: { ...CODE_TEXT_POLICY, modEnterTogglesMode: true, caretStop: 'render', expandable: true },

    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,  // reorder via custom gutter handle; native node-drag fights it (see sieve-block-extension.js DEFAULT_NODE_CONFIG)
      content: 'text*',
      marks: '',
      code: true,
      defining: true
    },

    getInitialContentHTML: function(data) {
      return esc(typeof data.source === 'string' ? data.source : '')
    },

    // status/createdAt come from BASE_ATTRS. The plantuml render job also sets
    // svgAsset (the rendered SVG's same-origin ExternalRef) and error, declared
    // here so those render-backs land on the PM node. renderedHash is the
    // backend's dispatch gate alone, so it is deliberately not declared; mermaid
    // blocks leave svgAsset/error empty.
    attrs: {
      source:      { default: '', parseHTML: function (el) { return el.getAttribute('data-source')       || '' } },
      diagramType: { default: 'mermaid', parseHTML: function (el) { return el.getAttribute('data-diagram-type') || 'mermaid' } },
      mode:        { default: 'render', parseHTML: function (el) { return el.getAttribute('data-mode')   || 'render' } },
      svgAsset:    { default: '',   parseHTML: function (el) { return el.getAttribute('data-svg-asset')  || '' } },
      error:       { default: null, parseHTML: function (el) { return el.getAttribute('data-error')      || null } },
    },

    getFriendlyName: function() { return 'Diagram' },
    getIcon: function() { return window.SieveIcons && window.SieveIcons.diagram },

    asContentEntry: function(node) {
      var src = node.textContent || node.attrs.source
      if (!src) return null
      return  [
        { mimeType: 'text/plain', content: src },
        { mimeType: 'image/svg', content: "<MERMAID RENDERED CONTENT" }
      ]
    },

    parseAttrs: function (data) {
      return {
        source:      typeof data.source === 'string' ? data.source : '',
        diagramType: data.diagramType || 'mermaid',
        mode:        data.mode        || 'render',
        svgAsset:    typeof data.svgAsset === 'string' ? data.svgAsset : '',
        error:       data.error       || null,
      }
    },

    makeNodeView: function (node, editorPane, getPos, ctx) {
      var nodeTypeName = node.type.name
      var currentAttrs = Object.assign({}, node.attrs)

      // The typed block with `source` overlaid as the LIVE PM text, never the
      // debounced attrs.source: the debounce below can lag 200ms behind the
      // document, and a mode flip right after typing must not render stale source.
      function blockFor(n) {
        return sieveBlockFor(n, { source: n.textContent }, ctx && ctx.provider)
      }

      var renderer = new DiagramRenderer(blockFor(node), ctx.provider || null)

      // NodeView-local caret memory for the edit⇄render round trip; caret position
      // never rides the wire or the schema.
      var savedCursorPos = 0

      var dom = renderer.render()
      if (currentAttrs.id) liveRenderers[currentAttrs.id] = renderer
      dom.addEventListener('dragstart', function (e) { e.preventDefault() })

      // The <code> element the renderer built is ProseMirror's contentDOM.
      var contentDOM = renderer.codeElement

      var updateTimer = null
      var observer = new MutationObserver(function() {
        var text = contentDOM.textContent
        renderer.syncGutterLineCount(text)
        clearTimeout(updateTimer)
        updateTimer = setTimeout(function() {
          if (currentAttrs.id) renderer.setContent(text)
        }, 200)
      })
      observer.observe(contentDOM, { characterData: true, childList: true, subtree: true })

      // Ctrl/Cmd+Enter in render mode: flip back to edit through the SAME flipMode
      // dispatch the policy extension uses. Delegated on `dom` rather than the
      // render body, which the renderer tears down and rebuilds on every mode
      // change; stopPropagation keeps it off TipTap's root listener.
      dom.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          DiagramNodeView.flipMode(currentAttrs)
        }
      })

      // Mod+Alt+E in render mode: focus is OUTSIDE ProseMirror, so the shared
      // interaction-policy extension's expand chord never fires — this raw listener
      // is the render-mode entry point for the same capability.
      dom.addEventListener('keydown', function (e) {
        if ((e.key === 'e' || e.key === 'E' || e.code === 'KeyE') &&
            e.altKey && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
          e.preventDefault(); e.stopPropagation()
          renderer.expand()
        }
      })

      return {
        dom:        dom,
        contentDOM: contentDOM,
        renderer:   renderer,   // marks this a MIGRATED kind for the seam's branch

        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          node = updatedNode // update ref for keydown handlers above
          currentAttrs = updatedNode.attrs
          // Late-id hardening: a block whose id lands via attr update on THIS
          // NodeView still reaches the policy/menu triggers.
          if (currentAttrs.id && !liveRenderers[currentAttrs.id]) liveRenderers[currentAttrs.id] = renderer
          renderer.update(blockFor(updatedNode))
          var transition = renderer.takeModeTransition()

          // Render-ward: remember where the caret sat in the source (PM's selection
          // still points into this node's text) for the next edit-ward flip.
          if (transition && transition.modeChangedTo === 'render') {
            try {
              var sel = editorPane.view.state.selection
              if (sel.$from.parent === updatedNode ||
                  (sel.$from.parent.type.name === 'sieve-diagram' && sel.$from.parent.attrs.id === currentAttrs.id)) {
                savedCursorPos = sel.$from.parentOffset
              }
            } catch (e) {}
          }

          // Only a genuine transition into edit needs PM's help. On the render-ward
          // one DiagramRenderer focuses the render pane itself, with no PM involved.
          if (transition && transition.modeChangedTo === 'edit') {
            var pos = savedCursorPos
            if (editorPane && editorPane.commands && getPos) {
              setTimeout(function() {
                try {
                  var pmPos = getPos() + 1 + Math.min(pos, (updatedNode.textContent || '').length)
                  editorPane.commands.setTextSelection(pmPos)
                  editorPane.commands.focus()
                } catch (e) {
                  console.error('Failed to restore cursor', e)
                  contentDOM.focus()
                }
              }, 0)
            } else {
              contentDOM.focus()
            }
          }
          return true
        },

        selectNode: function () {
          if (currentAttrs.mode === 'edit') contentDOM.focus()
        },

        ignoreMutation: function (mutation) {
          // Allow ProseMirror to handle content mutations natively.
          return !contentDOM.contains(mutation.target)
        },

        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },

        destroy: function () {
          clearTimeout(updateTimer)
          observer.disconnect()
          if (currentAttrs.id && liveRenderers[currentAttrs.id] === renderer) delete liveRenderers[currentAttrs.id]
          renderer.destroy()
        },
      }
    },

    buildPlugins: function(nodeType) {
      var Plugin = T.Plugin
      var Decoration = T.Decoration
      var DecorationSet = T.DecorationSet

      function getDecorations(node, pos) {
        var low = getLowlight()
        if (!low) return []

        try {
          var result = low.highlight('mermaid', node.textContent)
          var decos = []
          function parseNodes(nodes, offset, classes) {
            nodes.forEach(function(n) {
              if (n.type === 'text') {
                if (classes.length > 0) {
                  decos.push(Decoration.inline(offset, offset + n.value.length, { class: classes.join(' ') }))
                }
                offset += n.value.length
              } else if (n.type === 'element') {
                var cls = classes.concat(n.properties.className || [])
                offset = parseNodes(n.children || [], offset, cls)
              }
            })
            return offset
          }
          parseNodes(result.children, pos + 1, [])
          return decos
        } catch (e) { return [] }
      }

      return [
        new Plugin({
          state: {
            init: function(_, instance) {
              var decos = []
              instance.doc.descendants(function(node, pos) {
                if (node.type === nodeType) decos = decos.concat(getDecorations(node, pos))
              })
              return DecorationSet.create(instance.doc, decos)
            },
            apply: function(tr, set) {
              if (!tr.docChanged) return set.map(tr.mapping, tr.doc)
              var decos = []
              tr.doc.descendants(function(node, pos) {
                if (node.type === nodeType) decos = decos.concat(getDecorations(node, pos))
              })
              return DecorationSet.create(tr.doc, decos)
            }
          },
          props: {
            decorations: function(state) {
              return this.getState(state)
            }
          }
        })
      ]
    },
  }

  // Ask AI, Explain, and Delete are injected by sieve-block-extension.js framework.

  DiagramNodeView.buildAiCtx = function () { return { contextLabel: 'Diagram' } }

  DiagramNodeView.buildContextMenuItems = function (ctx) {
    var n = ctx.node, editorPane = ctx.editorPane, getPos = ctx.getPos
    var IC = window.SieveIcons || {}

    function toggleMode() {
      DiagramNodeView.flipMode(n.attrs)
    }

    function copySource() {
      if (n.attrs.source) navigator.clipboard.writeText(n.attrs.source)
    }

    var modeLabel = n.attrs.mode === 'render' ? 'Edit source' : 'Render'

    var headerLabel = n.attrs.diagramType + ' Diagram'

    return [
       { type: 'header', label: headerLabel},
      { icon: IC.edit, label: modeLabel, action: toggleMode },
      { icon: IC.copy, label: 'Copy source', action: copySource },
    ]
  }

  registerSieveRenderer('diagram', DiagramNodeView)

})()
