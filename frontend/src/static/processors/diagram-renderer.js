// diagram-renderer.js — Sieve NodeView ADAPTER for the 'diagram' kind (the PM
// half of the renderer/NodeView split, docs/design/specs/2026-07-20-block-renderer-extraction.md
// Phase 2 / issue #45). Look-and-feel (attrs in, DOM out, mermaid invocation,
// the kind's stylesheet) lives in DiagramRenderer
// (frontend/src/static/block/renderers/diagram-renderer.js — a DIFFERENT
// class, deliberately same basename, different directory). This file HOLDS a
// DiagramRenderer instance by COMPOSITION and owns everything that genuinely
// speaks ProseMirror: contentDOM binding, cursor restore via editorPane, the
// lowlight decoration plugin, selection/stopEvent/ignoreMutation, and the
// mode-flip dispatch through the held Editor. Mode and cursor position are
// persisted in YAML via the held Editor's applyBlockOps so they survive
// reloads. Keyboard behaviour (Tab/Enter/Mod+Enter toggle) comes from the
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

import { esc, getLowlight } from '../base/fenced-block-base.js'
import { T } from '../base/tiptap-vendor.js'
import { registerSieveRenderer, AdvancedHeaderProvider } from '../block/sieve-block-extension.js'
import { updateBlockOp } from '../block/block-sync.js'
import { expandBlock } from '../ui/media-lightbox.js'
import { DiagramRenderer } from '../block/renderers/diagram-renderer.js'

// ensureMermaid / renderMermaidSvgEntry — re-exported for the two existing
// cross-file consumers (smart-image-renderer.js imports statically,
// prose-block.js imports dynamically via import('../processors/diagram-renderer.js')
// so as never to eagerly evaluate a processor module — see prose-block.js's
// comment). Both symbols now just delegate to DiagramRenderer's statics; unlike
// the pre-split version, they no longer depend on this file's registration IIFE
// having run (a latent gap the split incidentally closes).
export function ensureMermaid() { return DiagramRenderer.ensureMermaid() }
export function renderMermaidSvgEntry(sourceNode, entries) { return DiagramRenderer.renderMermaidSvgEntry(sourceNode, entries) }

;(function () {
  'use strict'

  // ── Header (toolbar) ──────────────────────────────────────────────────────────
  // Declared header: badge + 'mermaid' label + an edit/render toggle. The framework
  // seam renders this and re-runs it on attr change, so the active toggle tracks
  // attrs.mode. Toggle clicks persist via ctx.updateAttributes (the one update path).
  var EDIT_SVG = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
    '<path d="M1 7.5 L6 2 L8 4 L3 9 L1 9 Z"/><line x1="5" y1="3" x2="7" y2="5"/></svg>'
  var RENDER_SVG = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
    '<ellipse cx="5" cy="5" rx="4" ry="2.5"/><circle cx="5" cy="5" r="1.2" fill="currentColor" stroke="none"/></svg>'

  function toggleBtn(label, icon, active, activeCls, onClick) {
    var b = document.createElement('button')
    b.className = 'diagram-block__toggle-btn' + (active ? ' ' + activeCls : '')
    b.innerHTML = icon + ' ' + label
    b.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); onClick() })
    return b
  }

  class DiagramHeader extends AdvancedHeaderProvider {
    badge() { return 'diagram' }
    left() {
      var t = document.createElement('span')
      t.className = 'sieve-block__type-label'
      t.textContent = 'mermaid'
      return [t]
    }
    right(attrs, ctx) {
      var mode = attrs.mode || 'render'
      var toggle = document.createElement('div')
      toggle.className = 'diagram-block__toggle'
      toggle.appendChild(toggleBtn('Edit', EDIT_SVG, mode === 'edit', 'diagram-block__toggle-btn--active-edit', function () {
        if (mode !== 'edit') ctx.updateAttributes({ mode: 'edit' })
      }))
      toggle.appendChild(toggleBtn('Render', RENDER_SVG, mode === 'render', 'diagram-block__toggle-btn--active-render', function () {
        if (mode === 'render') return
        var patch = { mode: 'render' }
        var sel = ctx.editorPane.view.state.selection
        if (sel.$from.parent.type.name === 'sieve-diagram' && sel.$from.parent.attrs.id === ctx.id) {
          patch.cursorPos = sel.$from.parentOffset
        }
        ctx.updateAttributes(patch)
      }))
      return [toggle]
    }
  }

  // ── DiagramNodeAdapter ────────────────────────────────────────────────────────
  // The registered descriptor sieve-block-extension.js's duck-typed
  // registerSieveRenderer() consumes (see that file's header comment for the
  // full "renderer interface"). Named distinctly from the imported
  // DiagramRenderer CLASS above — same word, two different layers (this is the
  // PM-adapter descriptor object; DiagramRenderer is the look-and-feel class it
  // holds by composition) — to keep the two unambiguous in this file.

  var DiagramNodeAdapter = {
    // flipMode — THE mode-flip op (contract: one function, two entry points).
    // Called by onModEnter (caret/selection inside PM, via the interaction-policy
    // extension, which threads the Editor `host`) and by the render body's DOM
    // keydown listener (focus outside PM in render mode, which passes ctx.getEditor()).
    // Both apply the identical update-block op through the held Editor (P4.F Brief C).
    flipMode: function (attrs, cursorPos, editor) {
      if (!attrs || !attrs.id) return false
      var newMode = attrs.mode === 'render' ? 'edit' : 'render'
      if (editor) {
        editor.applyBlockOps([updateBlockOp({ id: attrs.id, kind: 'diagram', attrs: { mode: newMode, cursorPos: typeof cursorPos === 'number' ? cursorPos : (attrs.cursorPos || 0) } })])
      }
      return true
    },

    // onModEnter — policy-extension entry point (modEnterTogglesMode). `host` is the
    // parent Editor, threaded by the interaction-policy extension.
    onModEnter: function (view, selection, host) {
      var node = selection.node || selection.$from.parent
      var cursorPos = selection.node
        ? (typeof node.attrs.cursorPos === 'number' ? node.attrs.cursorPos : 0)
        : selection.$from.parentOffset

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
                cursorPos = typeof node.attrs.cursorPos === 'number' ? node.attrs.cursorPos : 0
              }
            }
          } catch (e) {}
        }
      }

      if (!node || node.type.name !== 'sieve-diagram') return false
      return DiagramNodeAdapter.flipMode(node.attrs, cursorPos, host)
    },

    headerProvider: new DiagramHeader(),

    // getExpandContent — PROMOTE the block's LIVE rendered SVG into the lightbox
    // (moved in on open, restored to the block on close — no clone, no attribute
    // stripping, no async-timing games). Gating is CAPABILITY-based: a render-mode
    // diagram is expandable, so we return a spec (affordance shows) even in the
    // brief window before mermaid finishes — `element` is null then and expandBlock
    // no-ops. Only edit mode is non-expandable → null.
    /** @returns {{ element: Element|null, title: string, mode: 'media' } | null} */
    getExpandContent: function (node, dom) {
      if (!node || (node.attrs && node.attrs.mode) === 'edit') return null
      var svg = dom && dom.querySelector('.diagram-block__render svg')
      return { element: svg, title: (node.attrs.diagramType || 'mermaid') + ' diagram', mode: 'media' }
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

    attrs: {
      source:      { default: '', parseHTML: function (el) { return el.getAttribute('data-source')       || '' } },
      diagramType: { default: 'mermaid', parseHTML: function (el) { return el.getAttribute('data-diagram-type') || 'mermaid' } },
      mode:        { default: 'render', parseHTML: function (el) { return el.getAttribute('data-mode')   || 'render' } },
      cursorPos:   { default: 0,        parseHTML: function (el) { return parseInt(el.getAttribute('data-cursor-pos'))  || 0 } },
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
        cursorPos:   typeof data.cursorPos === 'number' ? data.cursorPos : 0,
      }
    },

    makeNodeView: function (node, editorPane, getPos, ctx) {
      var nodeTypeName = node.type.name
      var currentAttrs = Object.assign({}, node.attrs)

      // The renderer instance this NodeView HOLDS by composition (never
      // inheritance — see the file header). All look-and-feel (both bodies,
      // mermaid invocation, gutter/highlight box chrome) is its job; this
      // adapter only supplies PM-only concerns around it.
      var renderer = new DiagramRenderer()

      // effectiveAttrs — DiagramRenderer's mount()/update() take `source` as the
      // LIVE PM text (node.textContent), never the debounced attrs.source: the
      // debounce (see the MutationObserver below) can lag up to 200ms behind
      // what's actually in the document, and a mode-flip immediately after
      // typing must never render stale mermaid source.
      function effectiveAttrs(attrs, textContent) {
        return Object.assign({}, attrs, { source: textContent })
      }

      var dom = renderer.mount(effectiveAttrs(node.attrs, node.textContent))
      dom.setAttribute('data-id', node.attrs.id || '')
      dom.addEventListener('dragstart', function (e) { e.preventDefault() })

      var contentDOM = renderer.contentDOM

      // ── Header ────────────────────────────────────────────────────────────────
      // The toolbar (badge + mermaid label + edit/render toggle) is now declared as
      // `headerProvider: new DiagramHeader()` and rendered by the framework seam.
      // The toggle persists via ctx.updateAttributes.

      var updateTimer = null
      var observer = new MutationObserver(function() {
        var text = contentDOM.textContent
        renderer.syncGutterLineCount(text)
        clearTimeout(updateTimer)
        updateTimer = setTimeout(function() {
          if (currentAttrs.id) ctx.updateAttributes({ source: text })
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
          DiagramNodeAdapter.flipMode(currentAttrs, currentAttrs.cursorPos, ctx.getEditor())
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
          var spec = DiagramNodeAdapter.getExpandContent(node, dom)
          if (spec && spec.element) expandBlock(spec)
        }
      })

      // ── NodeView ──────────────────────────────────────────────────────────────

      return {
        dom:        dom,
        contentDOM: contentDOM,

        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          node = updatedNode // update ref for keydown handlers above
          currentAttrs = updatedNode.attrs
          var transition = renderer.update(dom, effectiveAttrs(updatedNode.attrs, updatedNode.textContent))

          // Only a genuine mode TRANSITION into edit needs PM's help: restore the
          // caret to attrs.cursorPos. DiagramRenderer already focused the render
          // pane itself on the render-ward transition (a plain DOM focus() call,
          // no PM needed there).
          if (transition && transition.modeChangedTo === 'edit') {
            var pos = typeof updatedNode.attrs.cursorPos === 'number' ? updatedNode.attrs.cursorPos : 0
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
          renderer.destroy(dom)
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

  DiagramNodeAdapter.buildAiCtx = function () { return { contextLabel: 'Diagram' } }

  DiagramNodeAdapter.buildContextMenuItems = function (ctx) {
    var n = ctx.node, editorPane = ctx.editorPane, getPos = ctx.getPos
    var IC = window.SieveIcons || {}

    function toggleMode() {
      var newMode = n.attrs.mode === 'render' ? 'edit' : 'render'
      var host = editorPane && editorPane.sieveHost
      if (host) host.applyBlockOps([updateBlockOp({ id: n.attrs.id, kind: 'diagram', attrs: { mode: newMode } })])
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

  registerSieveRenderer('diagram', DiagramNodeAdapter)

})()
