// The NodeView adapter for the 'log' kind. Look-and-feel — the block shell,
// header toolbar, raw-text body, Explore table, this kind's stylesheet — belongs
// to LogRenderer, which this file holds by composition. What lives here is
// everything that speaks ProseMirror: the contentDOM binding and ignoreMutation,
// the log-line decoration plugin, the read-only guard plugin, and resolving
// parsedAssetRef → URL against the held Editor's uuid.

import { esc } from '../../../../renderers/html-escape.js'
import { getLowlight } from '../../../../renderers/highlighting.js'
import { T } from '../tiptap-vendor.js'
import { registerSieveRenderer, sieveBlockFor } from '../sieve-block-extension.js'
import { MODE } from '../../../../contract/sieve-block.js'
import { LogRenderer } from '../../../../renderers/log-renderer.js'
import { documentAssetUrl } from '../../../../renderers/asset-urls.js'

;(function () {
  'use strict'

  // Spring Boot log line, compiled once.
  var SPRING_LINE_RE = /^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(\w+)\s+(.*?)\s+---\s+\[(.*?)\]\s+(.*?)\s+:\s+(.*)$/

  // id → live LogRenderer instance. The behaviour-registry path (policy
  // Mod+Enter) resolves the block's renderer here, so every trigger lands on the
  // same verb methods the header toggle calls.
  /** @type {Record<string, any>} */
  var liveRenderers = {}

  var LogNodeView = {
    // THE mode-flip op: lands on the live renderer's setMode, the same verb the
    // header toggle calls. The enum→wire mapping stays private to LogRenderer.
    flipMode: function (attrs) {
      if (!attrs || !attrs.id) return false
      var r = liveRenderers[attrs.id]
      if (!r) return false
      r.setMode(LogRenderer.mode(attrs) === 'explore' ? MODE.EDIT : MODE.RENDER)
      return true
    },
    attrs: {
      source:          { default: '', parseHTML: function (el) { return el.getAttribute('data-source')           || '' } },
      language:        { default: 'log', parseHTML: function (el) { return el.getAttribute('data-language')         || 'log' } },
      detectionMethod: { default: '', parseHTML: function (el) { return el.getAttribute('data-detection-method') || '' } },
      parsedAssetRef:  { default: '', parseHTML: function (el) { return el.getAttribute('data-parsed-asset-ref') || '' } },
      logFormatName:   { default: '', parseHTML: function (el) { return el.getAttribute('data-log-format-name') || '' } },
      logFormatRegex:  { default: '', parseHTML: function (el) { return el.getAttribute('data-log-format-regex') || '' } },
      status:          { default: 'COMPLETE', parseHTML: function (el) { return el.getAttribute('data-status') || 'COMPLETE' } },
      // Persisted view settings — the header controls write these through the
      // renderer's semantic verbs, so a configured log comes back configured.
      mode:            { default: '', parseHTML: function (el) { return el.getAttribute('data-mode') || '' } },
      filter:          { default: '', parseHTML: function (el) { return el.getAttribute('data-filter') || '' } },
      disabledCols:    { default: '', parseHTML: function (el) { return el.getAttribute('data-disabled-cols') || '' } },
      hideNoise:       { default: false, parseHTML: function (el) { return el.getAttribute('data-hide-noise') === 'true' } },
    },

    // Read-only text: the caret may enter (select/copy), typing is consumed.
    // Mod+Enter toggles raw↔explore. readOnlyText is load-bearing: the node is
    // `atom: false` with `content: 'text*'` and a real contentDOM, so the
    // handleTextInput guard below stops typing but nothing else stops Backspace
    // or Delete.
    interactionPolicy: { caretStop: true, modEnterTogglesMode: true, readOnlyText: true },

    // Policy-extension entry point: flip raw↔explore.
    onModEnter: function (view, selection, _host) {
      var node = selection.node || selection.$from.parent

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
              if (resolvedNode && resolvedNode.type.name === 'sieve-log') {
                node = resolvedNode
              }
            }
          } catch (e) {}
        }
      }

      if (!node || node.type.name !== 'sieve-log' || !node.attrs.id) return false
      return LogNodeView.flipMode(node.attrs)
    },

    // text* + code:true — the raw captured log lines ARE the node's text content.
    // Editing is blocked by the read-only plugin below.
    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,
      content: 'text*',
      marks: '',
      code: true,
      defining: true
    },

    getFriendlyName: function() { return 'Log' },
    getIcon: function() { return window.SieveIcons && window.SieveIcons.terminal },

    getInitialContentHTML: function(data) {
      return esc(typeof data.source === 'string' ? data.source : '')
    },

    asContentEntry: function(node) {
      var src = node.textContent || node.attrs.source
      if (!src) return null
      return  [
        { mimeType: 'text/plain', content: src }
      ]
    },

    parseAttrs: function (data) {
      return {
        language:        'log',
        source:          typeof data.source === 'string' ? data.source : '',
        detectionMethod: data.detectionMethod || '',
        parsedAssetRef:  data.parsedAssetRef || '',
        logFormatName:   data.logFormatName || '',
        logFormatRegex:  data.logFormatRegex || '',
        status:          data.status || 'COMPLETE',
        mode:            data.mode || '',
        filter:          data.filter || '',
        disabledCols:    data.disabledCols || '',
        hideNoise:       !!data.hideNoise,
      }
    },

    makeNodeView: function (node, editorPane, getPos, ctx) {
      var nodeTypeName = node.type.name
      var currentAttrs = Object.assign({}, node.attrs)

      // Resolving parsedAssetRef → a fetchable URL needs the held Editor's
      // document uuid, a PM-framework concern, so it stays adapter-side; the
      // RESOLVED url travels to LogRenderer as a block overlay field.
      function resolveAssetUrl(ref) {
        return documentAssetUrl(ctx && ctx.getEditor() && ctx.getEditor().uuid || '', ref)
      }

      function blockFor(n) {
        return sieveBlockFor(n, { source: n.textContent, resolvedAssetUrl: resolveAssetUrl(n.attrs.parsedAssetRef) }, ctx && ctx.provider)
      }

      var renderer = new LogRenderer(blockFor(node), ctx.provider || null)

      var dom = renderer.render()
      if (currentAttrs.id) liveRenderers[currentAttrs.id] = renderer

      var contentDOM = renderer.codeElement

      return {
        dom:        dom,
        contentDOM: contentDOM,
        renderer:   renderer,   // marks this a MIGRATED kind for the seam's branch
        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          currentAttrs = updatedNode.attrs
          // Late-id hardening: a block whose id lands via attr update on THIS
          // NodeView still reaches the policy/menu triggers.
          if (currentAttrs.id && !liveRenderers[currentAttrs.id]) liveRenderers[currentAttrs.id] = renderer
          renderer.update(blockFor(updatedNode))
          return true
        },
        ignoreMutation: function (mutation) {
          return !contentDOM.contains(mutation.target)
        },
        destroy: function () {
          if (currentAttrs.id && liveRenderers[currentAttrs.id] === renderer) delete liveRenderers[currentAttrs.id]
          renderer.destroy()
        },
      }
    },

    buildPlugins: function(nodeType) {
      var Plugin = T.Plugin
      var Decoration = T.Decoration
      var DecorationSet = T.DecorationSet

      function isInside(state, from, to) {
        var inside = false
        state.doc.nodesBetween(from, to, function(node) {
          if (node.type === nodeType) inside = true
        })
        return inside
      }

      // Semantic classes only — colours and noise-dimming live in CSS, so the
      // noise toggle stays a pure view concern.
      function decorateLine(line, start, decos) {
        var spring = line.match(SPRING_LINE_RE)
        if (spring) {
          var level = spring[2].toUpperCase()
          var levelCls = /ERROR|FATAL/.test(level) ? 'log-tok-error'
                       : /WARN/.test(level)        ? 'log-tok-warn'
                       :                              'log-tok-info'
          var lineCls = /ERROR|FATAL/.test(level) ? 'log-line-error'
                      : /WARN/.test(level)        ? 'log-line-warn'
                      :                              'log-line-info'
          decos.push(Decoration.inline(start, start + line.length, { class: lineCls }))

          var idx = 0
          function span(text, cls) {
            if (!text) return
            var i = line.indexOf(text, idx)
            if (i < 0) return
            decos.push(Decoration.inline(start + i, start + i + text.length, { class: cls }))
            idx = i + text.length
          }
          span(spring[1], 'log-tok-noise')                 // date
          span(spring[2], levelCls + ' log-tok-level')     // level
          span(spring[3], 'log-tok-noise')                 // pid
          span('[' + spring[4] + ']', 'log-tok-thread log-tok-noise') // thread
          span(spring[5], 'log-tok-logger log-tok-noise')  // logger
          return
        }

        // Fallback: bracketed tokens, whole-line severity, timestamps.
        var br = /\[(.*?)\]/g, m
        while ((m = br.exec(line))) {
          var inner = m[1]
          var cls = /error|fatal|fail|exception/i.test(inner) ? 'log-tok-error'
                  : /warn/i.test(inner)                        ? 'log-tok-warn'
                  : /info|debug|trace/i.test(inner)            ? 'log-tok-info'
                  :                                              'log-tok-bracket'
          decos.push(Decoration.inline(start + m.index, start + m.index + m[0].length, { class: cls + ' log-tok-noise' }))
        }
        if (/\b(ERROR|FATAL|Exception)\b/i.test(line)) {
          decos.push(Decoration.inline(start, start + line.length, { class: 'log-line-error' }))
        } else if (/\b(WARN|Warning)\b/i.test(line)) {
          decos.push(Decoration.inline(start, start + line.length, { class: 'log-line-warn' }))
        } else if (/\b(INFO|DEBUG|TRACE)\b/i.test(line)) {
          decos.push(Decoration.inline(start, start + line.length, { class: 'log-line-info' }))
        }
        var dre = /(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/g, dm
        while ((dm = dre.exec(line))) {
          decos.push(Decoration.inline(start + dm.index, start + dm.index + dm[0].length, { class: 'log-tok-noise' }))
        }
      }

      function getDecorations(node, pos) {
        var text = node.textContent || ''
        var decos = []
        var lineStart = 0
        text.split('\n').forEach(function (line) {
          if (line.length) decorateLine(line, pos + 1 + lineStart, decos)
          lineStart += line.length + 1 // +1 for the newline
        })
        return decos
      }

      function buildSet(doc) {
        var decos = []
        doc.descendants(function (node, pos) {
          if (node.type === nodeType) decos = decos.concat(getDecorations(node, pos))
        })
        return DecorationSet.create(doc, decos)
      }

      return [
        new Plugin({
          state: {
            init: function (_, instance) { return buildSet(instance.doc) },
            apply: function (tr, set) { return tr.docChanged ? buildSet(tr.doc) : set.map(tr.mapping, tr.doc) }
          },
          props: {
            decorations: function (state) { return this.getState(state) }
          }
        }),
        new Plugin({
          props: {
            handleTextInput: function(view, from, to, text) {
              return isInside(view.state, from, to)
            },
            // Keyboard read-only enforcement belongs to the interaction-policy
            // extension (interactionPolicy.readOnlyText above); handleTextInput,
            // Paste and Drop stay here because they guard input paths, not keys.
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
  }

  LogNodeView.buildAiCtx = function (node) {
    return { contextLabel: 'Log block' }
  }

  LogNodeView.buildContextMenuItems = function ({ node }) {
    return [
      { type: 'header', label: 'Log' },
    ]
  }

  registerSieveRenderer('log', LogNodeView)

})()
