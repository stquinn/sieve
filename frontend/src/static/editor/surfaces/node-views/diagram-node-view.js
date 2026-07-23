// diagram-node-view.js — Sieve NodeView ADAPTER for the 'diagram' kind (the PM
// half of the renderer/NodeView split; NORMATIVE contract:
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md
// Phase 2 / issue #45). Look-and-feel (attrs in, DOM out, mermaid invocation,
// the kind's stylesheet) lives in DiagramRenderer
// (frontend/src/static/block/renderers/diagram-renderer.js — a DIFFERENT
// class). This file HOLDS a
// DiagramRenderer instance by COMPOSITION and owns everything that genuinely
// speaks ProseMirror: contentDOM binding, caret capture/restore across the
// mode flip (a NodeView-LOCAL variable since issue #49 Phase 1 — cursorPos
// left the wire and the schema; caret-restore scope is the NodeView lifetime,
// intended), the lowlight decoration plugin, selection/stopEvent/
// ignoreMutation, and the mode-flip dispatch through the live renderer's
// setMode (whose patch leaves through the BlockService, the wire owner).
// Keyboard behaviour (Tab/Enter/Mod+Enter toggle) comes from the
// shared interaction-policy extension via interactionPolicy + onModEnter — do
// NOT add handleKeyDown here (docs/editor-interaction-contract.md is
// normative).
//
// Per-kind SCHEMA DATA (nodeConfig/attrs/parseAttrs) stays here, not on
// DiagramRenderer: it is TipTap/ProseMirror configuration — attrs.parseHTML
// reads PM's parsed `data-*` HTML attributes, nodeConfig feeds PM's schema
// builder — consumed exclusively by createSieveNode in sieve-block-extension.js.
// DiagramRenderer has no use for it standalone (a chat-turn bubble mounting
// DiagramRenderer directly never touches TipTap attrs), so keeping it here
// keeps that class PM-agnostic in the fullest sense and leaves the registered
// descriptor's shape — the contract sieve-block-extension.js's duck-typed
// registerSieveRenderer() consumes — exactly as that file already expects.

import { esc } from '../../../block/renderers/html-escape.js'
import { getLowlight } from '../../../block/renderers/highlighting.js'
import { T } from '../tiptap-vendor.js'
import { registerSieveRenderer, sieveBlockFor } from '../../../block/sieve-block-extension.js'
import { MODE } from '../../../block/sieve-block.js'
import { DiagramRenderer } from '../../../block/renderers/diagram-renderer.js'

// ensureMermaid / renderDiagramSvgEntry — re-exported for the two existing
// cross-file consumers (smart-image-node-view.js imports statically,
// prose-block.js imports dynamically via import('../editor/surfaces/node-views/diagram-node-view.js')
// so as never to eagerly evaluate a processor module — see prose-block.js's
// comment). Both symbols now just delegate to DiagramRenderer's statics; unlike
// the pre-split version, they no longer depend on this file's registration IIFE
// having run (a latent gap the split incidentally closes). renderDiagramSvgEntry
// branches on the engine: mermaid renders locally, plantuml fetches its svgAsset.
export function ensureMermaid() { return DiagramRenderer.ensureMermaid() }
export function renderDiagramSvgEntry(sourceNode, entries) { return DiagramRenderer.renderDiagramSvgEntry(sourceNode, entries) }

;(function () {
  'use strict'

  // The diagram's HEADER (badge + mermaid label + edit/render toggle + expand
  // button) is built by DiagramRenderer, whose buttons call its OWN semantic
  // verbs (setMode / expand — contract core API). The verbs leave through the
  // BlockService; the PM-side caret capture/restore around the mode flip stays
  // HERE, keyed off takeModeTransition() in the NodeView's update().

  // liveRenderers — id → live DiagramRenderer instance. The behaviour-registry
  // paths (policy Mod+Enter, policy expand chord, context menu) resolve the
  // block's renderer here so every trigger lands on the SAME verb methods.
  /** @type {Record<string, any>} */
  var liveRenderers = {}

  // ── DiagramNodeView ────────────────────────────────────────────────────────
  // The registered descriptor sieve-block-extension.js's duck-typed
  // registerSieveRenderer() consumes (see that file's header comment for the
  // full "renderer interface"). Named distinctly from the imported
  // DiagramRenderer CLASS above — same word, two different layers (this is the
  // PM-adapter descriptor object; DiagramRenderer is the look-and-feel class it
  // holds by composition) — to keep the two unambiguous in this file.

  var DiagramNodeView = {
    // flipMode — THE mode-flip op (contract: one function, N entry points).
    // Called by onModEnter (policy extension) and the render body's DOM keydown
    // listener. Both land on the live renderer's setMode — the SAME verb the
    // header toggle calls; caret capture happens in the NodeView's update().
    flipMode: function (attrs) {
      if (!attrs || !attrs.id) return false
      var r = liveRenderers[attrs.id]
      if (!r) return false
      r.setMode(attrs.mode === 'render' ? MODE.EDIT : MODE.RENDER)
      return true
    },

    // onModEnter — policy-extension entry point (modEnterTogglesMode). `host` is the
    // parent Editor, threaded by the interaction-policy extension.
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

    // getExpandContent — behaviour-registry entry point (policy expand chord /
    // header / menu: one capability). Delegates to the live renderer's
    // expandContent() so the spec is built in exactly one place.
    /** @returns {{ element: Element|null, title: string, mode: 'media' } | null} */
    getExpandContent: function (node) {
      var r = node && node.attrs && liveRenderers[node.attrs.id]
      return r ? r.expandContent() : null
    },

    // caretStop:'render' — a caret stop only in render mode; edit mode is raw text.
    // Mod+Enter is this kind's declared override: mode toggle, not escape.
    interactionPolicy: { rawText: true, indentWidth: 2, enterInsertsNewline: true, autoIndentOnEnter: true, modEnterTogglesMode: true, caretStop: 'render', expandable: true },

    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,  // reorder via custom gutter handle; native node-drag fights it (see sieve-block-extension.js DEFAULT_NODE_CONFIG)
      group: 'block',
      inline: false,
      content: 'text*',
      marks: '',
      code: true,
      defining: true
    },

    getInitialContentHTML: function(data) {
      return esc(typeof data.source === 'string' ? data.source : '')
    },

    // status/createdAt come from BASE_ATTRS (merged for every sieve node). The
    // plantuml render job additionally sets svgAsset (the rendered SVG's
    // same-origin ExternalRef) and error — declared here so those render-backs
    // land on the PM node and reach DiagramRenderer. renderedHash is the
    // backend's dispatch gate only (frontend never reads it), so it is not
    // declared. mermaid blocks leave svgAsset/error empty.
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

      // envelopeFor — the typed envelope with `source` overlaid as the LIVE PM
      // text (node.textContent), never the debounced attrs.source: the debounce
      // (see the MutationObserver below) can lag up to 200ms behind what's in
      // the document, and a mode-flip right after typing must never render
      // stale mermaid source. The overlay key is this kind's own knowledge.
      function envelopeFor(n) {
        return sieveBlockFor(n, { source: n.textContent }, ctx && ctx.blockService)
      }

      // The renderer instance this NodeView HOLDS by composition (never
      // inheritance — see the file header). All look-and-feel (header, both
      // bodies, mermaid invocation, gutter/highlight box chrome) is its job;
      // its semantic verbs hit the real wire through the BlockService (issue
      // #49 Phase 1 — the v1 appliers are retired); this kind's
      // content→source mapping lives on DiagramRenderer.setContent.
      var renderer = new DiagramRenderer(envelopeFor(node), ctx.blockService || null)

      // NodeView-local caret memory for the edit⇄render round trip (replaces
      // the retired cursorPos attr — caret position never rides the wire or
      // the schema; its scope is THIS NodeView's lifetime, intended).
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
          // The sync closure ends at the renderer's outbound verb — never a
          // socket, never an attr name here (contract §setContent direction).
          if (currentAttrs.id) renderer.setContent(text)
        }, 200)
      })
      observer.observe(contentDOM, { characterData: true, childList: true, subtree: true })

      // ── Events ────────────────────────────────────────────────────────────────

      // Note: contentDOM keydown is usually swallowed by ProseMirror's root listener.
      // Ctrl+Enter for switching to render mode is handled in buildPlugins below.

      // Ctrl+Enter / Cmd+Enter in render mode: flip back to edit — via the
      // SAME flipMode dispatch the policy extension uses (contract: one
      // function, two entry points). stopPropagation prevents the event
      // bubbling to TipTap's root listener. Delegated on `dom` (not the
      // renderer's render-body directly) since the render body is torn down
      // and rebuilt by the renderer as mode changes.
      dom.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          DiagramNodeView.flipMode(currentAttrs)
        }
      })

      // Mod+Alt+E in render mode: focus is OUTSIDE ProseMirror here, so the
      // shared interaction-policy extension's expand chord never fires — this
      // raw listener is the render-mode entry point (contract: one capability,
      // two dispatch paths, mirroring flipMode above). `node` is kept fresh by
      // the NodeView's update() (reassigns node = updatedNode); `dom` is the
      // block root element — both in scope here.
      dom.addEventListener('keydown', function (e) {
        if ((e.key === 'e' || e.key === 'E' || e.code === 'KeyE') &&
            e.altKey && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
          e.preventDefault(); e.stopPropagation()
          renderer.expand()
        }
      })

      // ── NodeView ──────────────────────────────────────────────────────────────

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
          renderer.update(envelopeFor(updatedNode))
          var transition = renderer.takeModeTransition()

          // Render-ward transition: remember where the caret sat in the source
          // (PM's selection still points into this node's text) so the next
          // edit-ward flip can put it back. NodeView-local — never the wire.
          if (transition && transition.modeChangedTo === 'render') {
            try {
              var sel = editorPane.view.state.selection
              if (sel.$from.parent === updatedNode ||
                  (sel.$from.parent.type.name === 'sieve-diagram' && sel.$from.parent.attrs.id === currentAttrs.id)) {
                savedCursorPos = sel.$from.parentOffset
              }
            } catch (e) {}
          }

          // Only a genuine mode TRANSITION into edit needs PM's help: restore
          // the caret remembered on the last render-ward flip. DiagramRenderer
          // already focused the render pane itself on the render-ward
          // transition (a plain DOM focus() call, no PM needed there).
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

    // ── Plugins ───────────────────────────────────────────────────────────────

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
            // Keyboard behaviour (Tab/Enter/Mod+Enter) is owned by the
            // interaction-policy extension via interactionPolicy + onModEnter
            // above — no per-renderer key handling (contract rule).
          }
        })
      ]
    },
  }

  // ── Context menu ──────────────────────────────────────────────────────────────
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
