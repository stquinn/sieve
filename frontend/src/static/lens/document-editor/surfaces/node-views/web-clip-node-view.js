// The NodeView adapter for the 'web-clip' kind. Look-and-feel — the block shell,
// status chrome, this kind's stylesheet — belongs to WebClipRenderer, which this
// file holds by composition. What lives here is everything that speaks
// ProseMirror or is cross-block: the contentDOM binding and ignoreMutation, the
// framework schema data (nodeConfig/attrs/parseAttrs/titleProvider/
// contentProvider), the read-only-container guard plugin, and reverse chain-glow
// hover, which queries across blocks to light up referencing ai-blocks.

import { T } from '../tiptap-vendor.js'
import { registerSieveRenderer, sieveBlockFor } from '../sieve-block-extension.js'
import { labelForAction } from '../../../../renderers/action-label.js'
import { REGION } from '../../../../renderers/block-renderer.js'
import { WebClipRenderer } from '../../../../renderers/web-clip-renderer.js'

;(function () {
  'use strict'

  // A human-readable summary of a web-clip node, for AI context.
  function webClipSummary(n) {
    var parts = []
    if (n.attrs.title)   parts.push('**' + n.attrs.title + '**')
    if (n.attrs.source)  parts.push('Source: ' + n.attrs.source)
    if (n.attrs.content) parts.push(n.attrs.content.trim())
    return parts.join('\n\n')
  }

  // The descriptor sieve-block-extension.js's registerSieveRenderer() consumes.
  // Named distinctly from the imported WebClipRenderer CLASS: this is the
  // PM-adapter descriptor, that is the look-and-feel class it holds.

  var WebClipNodeView = {

    getIcon: function() { return window.SieveIcons && window.SieveIcons.externalLink },
    getFriendlyName: function(node) { return 'Web Clip' },

    // The title and the body (the fetched or summarised article) are rendered by
    // WebClipRenderer; the seam reads its bodyMarkdown to project live PM nodes
    // into the handleBuild-claimed body container. The source link is header chrome.

    getInitialContentHTML: function() { return '<p></p>' },

    asContentEntry: function(node) {
      if (!node.attrs.source) return null
      return [{ mimeType: 'text/uri-list', content: node.attrs.source }]
    },

    // web-clip is the ONE kind that supplies its own extraction items, because it
    // is the one kind offering a CHOICE of how much of the page to bring in. That
    // choice — the "(Fetch)" / "(Summarise)" suffix — is all this kind owns. The
    // VERB is DERIVED from labelForAction, the single verb map, and never restated
    // here, which is what keeps this kind's wording from drifting from every other.
    getExtractionMenuItems: function(sourceNode, entries, defaultAction, opts) {
      var IC = window.SieveIcons || {}
      var action = (opts && opts.operation) || 'extract'
      // sourceKind is deliberately not passed: labelForAction's source-sensitive
      // cases are all prose-TARGET ones, and the target here is always web-clip.
      var verb = labelForAction(action, WebClipNodeView.getFriendlyName(), { kind: 'web-clip' })
      var item = function (mode, modeLabel) {
        return {
          icon: IC['web-clip'] || IC.code,
          label: verb + ' (' + modeLabel + ')',
          action: function() { defaultAction({ mode: mode }) }
        }
      }
      return [item('fetch', 'Fetch'), item('summarise', 'Summarise')]
    },

    // Read-only container: arrows treat it as a single caret stop.
    interactionPolicy: { caretStop: true },

    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,
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

      // This lens CLAIMS the BODY region through the handleBuild interceptor: PM
      // owns the claimed container as its contentDOM, while the status chrome and
      // title still render renderer-side. The web-clip body is server-written, so
      // there is no outbound content channel.
      var bodyContainer = null
      var handleBuild = function (_r, region, container) {
        if (region !== REGION.BODY) return true
        container.className = 'web-clip-block__content tiptap'
        bodyContainer = container
        return false
      }
      var renderer = new WebClipRenderer(sieveBlockFor(node, undefined, ctx && ctx.provider), ctx.provider || null, handleBuild)

      var dom = renderer.render()
      var contentDOM = bodyContainer   // the claimed body container PM binds as its contentDOM

      // Reverse chain highlight: hovering the web-clip lights up any AI blocks
      // referencing it via data-ai-ref. The forward direction lives in
      // ai-block-renderer.js.
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
          renderer.update(sieveBlockFor(updatedNode, undefined, ctx && ctx.provider))  // chrome + title; body is PM's (claimed region)
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

      // Copy/Cut/Delete are deliberately absent: highlighted text copies natively,
      // and whole-block copy plus the universal Delete come from the framework.
      return [{ type: 'header', label: headerLabel }]
    },

    buildAiCtx: function (node) {
      return { contextLabel: 'Web Clip' }
    },
  }

  registerSieveRenderer('web-clip', WebClipNodeView)
})()
