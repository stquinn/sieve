// web-clip-node-view.js — Sieve NodeView ADAPTER for the 'web-clip' kind (the
// PM half of the renderer/NodeView split; NORMATIVE contract:
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md
// Phase 4 / issue #47). Look-and-feel (the block shell, status chrome, this
// kind's stylesheet) lives in WebClipRenderer
// (frontend/src/static/block/renderers/web-clip-renderer.js — a DIFFERENT
// class). This file HOLDS a
// WebClipRenderer instance by COMPOSITION and owns everything that genuinely
// speaks ProseMirror or is cross-block: contentDOM binding/ignoreMutation,
// the framework schema data (nodeConfig/attrs/parseAttrs/titleProvider/
// contentProvider — the actual title/body rendering is the framework's
// title/content slot seam, see WebClipRenderer's header comment for why that
// stays out of the renderer), the read-only-container guard plugin, and
// reverse chain-glow hover (cross-block DOM querying to light up referencing
// ai-blocks) — framework-layer material, deliberately left untouched here
// (same restraint ai-block's applyChain already established).

import { T } from '../../../base/tiptap-vendor.js'
import { registerSieveRenderer, sieveBlockFor } from '../../../block/sieve-block-extension.js'
import { REGION } from '../../../block/renderers/block-renderer.js'
import { WebClipRenderer } from '../../../block/renderers/web-clip-renderer.js'

;(function () {
  'use strict'

  // Returns a human-readable summary of a web-clip node for AI context (Rule 14).
  function webClipSummary(n) {
    var parts = []
    if (n.attrs.title)   parts.push('**' + n.attrs.title + '**')
    if (n.attrs.source)  parts.push('Source: ' + n.attrs.source)
    if (n.attrs.content) parts.push(n.attrs.content.trim())
    return parts.join('\n\n')
  }

  // ── WebClipNodeView ────────────────────────────────────────────────────────
  // The registered descriptor sieve-block-extension.js's duck-typed
  // registerSieveRenderer() consumes. Named distinctly from the imported
  // WebClipRenderer CLASS above — same word, two different layers — to keep
  // the two unambiguous in this file.

  var WebClipNodeView = {

    getIcon: function() { return window.SieveIcons && window.SieveIcons.externalLink },
    getFriendlyName: function(node) { return 'Web Clip' },

    // TITLE (the page title) and BODY (the fetched/summarised article) are
    // rendered by WebClipRenderer now (title region + bodyMarkdown → attrs.content).
    // The seam reads bodyMarkdown to project live PM nodes into the body
    // container (the handleBuild-claimed region). The source link stays header chrome.

    getInitialContentHTML: function() { return '<p></p>' },

    asContentEntry: function(node) {
      if (!node.attrs.source) return null
      return [{ mimeType: 'text/uri-list', content: node.attrs.source }]
    },

    getExtractionMenuItems: function(sourceNode, entries, defaultAction, opts) {
      var IC = window.SieveIcons || {}
      // "Upgrade" only when REPLACING a native source in place. Extracting a link out
      // of an existing sieve block is additive — the source block survives — so it must
      // read "Extract", matching the framework's verb for every other target kind.
      var verb = (opts && opts.operation === 'transform') ? 'Upgrade to' : 'Extract as'
      return [
        {
          icon: IC['web-clip'] || IC.code,
          label: verb + ' Web Clip (Fetch)',
          action: function() { defaultAction({ mode: 'fetch' }) }
        },
        {
          icon: IC['web-clip'] || IC.code,
          label: verb + ' Web Clip (Summarise)',
          action: function() { defaultAction({ mode: 'summarise' }) }
        }
      ]
    },

    // Read-only container: arrows treat it as a single caret stop.
    interactionPolicy: { caretStop: true },

    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,
      group: 'block',
      inline: false,
      content: 'block+'
    },

    attrs: {
      source:      { default: '',      parseHTML: function (el) { return el.getAttribute('data-source')       || '' } },
      title:       { default: null,    parseHTML: function (el) { return el.getAttribute('data-title')        || null } },
      mode:        { default: 'fetch', parseHTML: function (el) { return el.getAttribute('data-mode')         || 'fetch' } },
      model:       { default: null,    parseHTML: function (el) { return el.getAttribute('data-model')        || null } },
      completedAt: { default: null,    parseHTML: function (el) { return el.getAttribute('data-completed-at') || null } },
      content:     { default: null,    parseHTML: function (el) { return el.getAttribute('data-content')      || null } },
      error:       { default: null,    parseHTML: function (el) { return el.getAttribute('data-error')        || null } },
    },

    parseAttrs: function (data) {
      return {
        source:      data.source      || '',
        title:       data.title       || null,
        mode:        data.mode        || 'fetch',
        model:       data.model       || null,
        completedAt: data.completedAt || null,
        content:     data.content     || null,
        error:       data.error       || null,
      }
    },

    makeNodeView: function (node, editorPane, getPos, ctx) {

      var nodeTypeName = 'sieve-web-clip'

      // The renderer instance this NodeView HOLDS by composition (never
      // inheritance — see the file header). This lens CLAIMS the BODY region
      // via the handleBuild interceptor: PM owns the claimed container as its
      // contentDOM while the status chrome + title still render renderer-side;
      // the seam authors body content via fresh scratch instances. Retry is the
      // renderer's semantic verb, effected through the BlockService (the
      // web-clip body is server-written — no outbound content channel).
      var bodyContainer = null
      var handleBuild = function (_r, region, container) {
        if (region !== REGION.BODY) return true
        container.className = 'web-clip-block__content tiptap'
        bodyContainer = container
        return false
      }
      var renderer = new WebClipRenderer(sieveBlockFor(node), ctx.blockService || null, handleBuild)

      var dom = renderer.render()
      var contentDOM = bodyContainer   // the claimed body container PM binds as its contentDOM

      // Reverse chain highlight: when hovering the web-clip, light up any AI blocks
      // that reference it via data-ai-ref. Forward direction (AI → web-clip) is in
      // ai-block-renderer.js. Cross-block DOM querying — framework-layer material,
      // deliberately left adapter-side (same restraint ai-block's applyChain
      // already established).
      function applyReverseChain(action) {
        var id = dom.getAttribute('data-id') || ''
        if (!id) return
        document.querySelectorAll('.ai-block').forEach(function (el) {
          var refs = (el.getAttribute('data-ai-ref') || '').split(',').map(function (r) { return r.trim() })
          if (refs.indexOf(id) !== -1) el.classList[action]('ai-block--chain-active')
        })
      }
      dom.addEventListener('mouseenter', function () { applyReverseChain('add') })
      dom.addEventListener('mouseleave', function () { applyReverseChain('remove') })

      return {
        dom: dom,
        contentDOM: contentDOM,
        // Marks this a MIGRATED kind for the seam's branch; the seam authors
        // the projected body via fresh scratch WebClipRenderer instances.
        renderer: renderer,
        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          node = updatedNode
          renderer.update(sieveBlockFor(updatedNode))  // chrome + title; body is PM's (claimed region)
          return true
        },
        ignoreMutation: function (mutation) {
          return !contentDOM.contains(mutation.target)
        },
        destroy: function () {
          renderer.destroy()
        },
      }
    },

    // ── Plugins ───────────────────────────────────────────────────────────────

    buildPlugins: function(nodeType) {
      var Plugin = T.Plugin

      function isInside(state, from, to) {
        var inside = false
        state.doc.nodesBetween(from, to, function(node) {
          if (node.type === nodeType) inside = true
        })
        return inside
      }

      return [
        new Plugin({
          props: {
            handleTextInput: function(view, from, to, text) {
              return isInside(view.state, from, to)
            },
            handleKeyDown: function(view, event) {
              if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter') {
                return isInside(view.state, view.state.selection.from, view.state.selection.to)
              }
              if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
                return isInside(view.state, view.state.selection.from, view.state.selection.to)
              }
              return false
            },
            handlePaste: function(view, event, slice) {
              return isInside(view.state, view.state.selection.from, view.state.selection.to)
            },
            handleDrop: function(view, event, slice, moved) {
              var pos = view.posAtCoords({ left: event.clientX, top: event.clientY })
              if (pos && isInside(view.state, pos.pos, pos.pos)) return true
              return false
            }
          }
        })
      ]
    },

    buildContextMenuItems: function ({ node }) {
      var status = node.attrs.status || 'PENDING'
      var isComplete = status === 'COMPLETE'

      var domain = ''
      try { domain = new URL(node.attrs.source || '').hostname } catch (_) { domain = node.attrs.source || '' }
      var modeLabel = node.attrs.mode === 'summarise' ? 'Summarised' : 'Fetched'
      var headerLabel = isComplete ? (modeLabel + ' from ' + domain) : domain

      // Copy/Cut/Delete are intentionally NOT here. Highlighted text copies natively;
      // whole-block copy + the universal Delete come from the framework. The old
      // bespoke Copy wrote the entire block's YAML instead of the selection.
      return [{ type: 'header', label: headerLabel }]
    },

    buildAiCtx: function (node) {
      return { contextLabel: 'Web Clip' }
    },
  }

  registerSieveRenderer('web-clip', WebClipNodeView)
})()
