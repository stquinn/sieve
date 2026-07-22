// code-node-view.js — Sieve NodeView ADAPTER for the 'code' kind (the PM half
// of the renderer/NodeView split, Block Renderer Contract:
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md). Look-and-feel (the
// block shell, header badge, gutter+code-area body chrome, this kind's
// stylesheet) lives in CodeRenderer
// (frontend/src/static/block/renderers/code-renderer.js — a DIFFERENT class,
// deliberately same basename, different directory). This file HOLDS a
// CodeRenderer instance by COMPOSITION and owns everything that genuinely
// speaks ProseMirror: contentDOM binding/ignoreMutation, the lowlight
// decoration plugin (buildPlugins), and the MutationObserver that watches
// contentDOM and reports live text through renderer.setContent (contract
// §setContent direction — the renderer's outbound verbs leave through the
// BlockService, the wire owner).
// Keyboard behaviour (Tab/Enter/Home) comes from the shared
// interaction-policy extension via this renderer's interactionPolicy
// declaration — do NOT add handleKeyDown here
// (docs/editor-interaction-contract.md is normative).

import { esc } from '../../../block/renderers/html-escape.js'
import { getLowlight } from '../../../block/renderers/highlighting.js'
import { T } from '../tiptap-vendor.js'
import { registerSieveRenderer, sieveBlockFor } from '../../../block/sieve-block-extension.js'
import { CodeRenderer } from '../../../block/renderers/code-renderer.js'

;(function () {
  'use strict'

  // ── CodeNodeView ────────────────────────────────────────────────────────
  // The registered descriptor sieve-block-extension.js's duck-typed
  // registerSieveRenderer() consumes. Named distinctly from the imported
  // CodeRenderer CLASS above — same word, two different layers (this is the
  // PM-adapter descriptor object; CodeRenderer is the look-and-feel class it
  // holds by composition) — to keep the two unambiguous in this file.

  var CodeNodeView = {

    // The renderer builds its own header (the stateful language badge lives in
    // CodeRenderer now) — the framework no longer assembles a headerProvider
    // slot around it.

    // Keyboard behaviour is DECLARED here and applied by the shared
    // interaction-policy extension (docs/editor-interaction-contract.md).
    interactionPolicy: { rawText: true, indentWidth: 2, enterInsertsNewline: true, autoIndentOnEnter: true },

    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,
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
      source:          { default: '', parseHTML: function (el) { return el.getAttribute('data-source')           || '' } },
      language:        { default: '', parseHTML: function (el) { return el.getAttribute('data-language')         || '' } },
      detectionMethod: { default: '', parseHTML: function (el) { return el.getAttribute('data-detection-method') || '' } },
    },

    getFriendlyName: function() { return 'Code' },
    getIcon: function() { return window.SieveIcons && window.SieveIcons.terminal },

    asContentEntry: function(node) {
      var src = node.textContent || node.attrs.source
      if (!src) return null
      return  [
        { mimeType: 'text/plain', content: src }
      ]
    },

    parseAttrs: function (data) {
      return {
        language:        data.language        || '',
        source:          typeof data.source === 'string' ? data.source : '',
        detectionMethod: data.detectionMethod || '',
      }
    },

    makeNodeView: function (node, editorPane, getPos, ctx) {
      var nodeTypeName = node.type.name
      var currentAttrs = Object.assign({}, node.attrs)

      // envelopeFor — the typed envelope with `source` overlaid as the LIVE PM
      // text (node.textContent), never the debounced attrs.source (the debounce
      // below can lag up to 200ms behind what's actually in the document). The
      // overlay key is this kind's own knowledge.
      function envelopeFor(n) {
        return sieveBlockFor(n, { source: n.textContent }, ctx && ctx.blockService)
      }

      // The renderer instance this NodeView HOLDS by composition (never
      // inheritance — see the file header). It builds its own shell, header
      // (language badge), gutter and code-area from the envelope handed at
      // construction; this adapter only supplies PM-only concerns around it.
      // The renderer's outbound verbs hit the real wire through the
      // BlockService (issue #49 Phase 1 — the v1 appliers are retired); this
      // kind's content→source mapping lives on CodeRenderer.setContent.
      var renderer = new CodeRenderer(envelopeFor(node), ctx.blockService || null)

      var dom = renderer.render()

      // The <code> element the renderer built is ProseMirror's contentDOM (the
      // word "contentDOM" stays adapter-side — the renderer names no PM concept).
      var contentDOM = renderer.codeElement

      var updateTimer = null
      // lastSource is the text we last OBSERVED. Syntax highlighting rewrites the
      // inner <span> tree whenever the language attr changes (e.g. the AI refines
      // the language), which fires this observer with byte-identical text. Guarding
      // on a real text change skips that decoration-only re-render — otherwise we
      // emit a phantom `source` block-update for content that did not change, which
      // is what let a stale heuristic clobber the AI's language. Updated ONLY here
      // (never in update()) so genuine user edits still dispatch.
      var lastSource = node.textContent
      var observer = new MutationObserver(function() {
        var text = contentDOM.textContent
        if (text === lastSource) return   // decoration-only re-render — not an edit
        lastSource = text
        renderer.syncGutterLineCount(text)
        clearTimeout(updateTimer)
        updateTimer = setTimeout(function() {
          // The sync closure ends at the renderer's outbound verb — never a
          // socket, never an attr name here (contract §setContent direction).
          if (currentAttrs.id) renderer.setContent(lastSource)
        }, 200)
      })
      observer.observe(contentDOM, { characterData: true, childList: true, subtree: true })

      // ── NodeView ──────────────────────────────────────────────────────────────

      return {
        dom:        dom,
        contentDOM: contentDOM,
        renderer:   renderer,   // marks this a MIGRATED kind for the seam's branch

        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          currentAttrs = updatedNode.attrs
          renderer.update(envelopeFor(updatedNode))
          return true
        },

        ignoreMutation: function (mutation) {
          // Allow ProseMirror to handle content mutations natively.
          return !contentDOM.contains(mutation.target)
        },

        destroy: function () {
          observer.disconnect()
          clearTimeout(updateTimer)
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
        var lang = node.attrs.language || ''
        if (!lang || lang === 'unknown' || lang === 'text') return []

        try {
          var result = low.highlight(lang, node.textContent)
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
            },
            // Keyboard behaviour (Tab/Enter/Home) is owned by the
            // interaction-policy extension via interactionPolicy above —
            // no per-renderer key handling (contract rule).
          }
        })
      ]
    },
  }

  // Ask AI, Explain, and Delete are injected by sieve-block-extension.js framework.
  CodeNodeView.buildAiCtx = function (node) {
    var lang = node.attrs.language
    var label = lang && lang !== 'unknown' ? lang + ' block' : 'Code block'
    return { contextLabel: label }
  }

  CodeNodeView.buildContextMenuItems = function ({ node }) {
    var lang = node.attrs.language
    var label = lang && lang !== 'unknown' ? lang + ' block' : 'Code block'
    return [
      { type: 'header', label: label },
    ]
  }

  registerSieveRenderer('code', CodeNodeView)

})()
