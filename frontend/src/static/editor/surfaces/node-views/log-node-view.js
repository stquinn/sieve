// log-node-view.js — Sieve NodeView ADAPTER for the 'log' kind (the PM half of
// the renderer/NodeView split, Block Renderer Contract:
// docs/design/specs/2026-07-21-block-renderer-contract.md). Look-and-feel (the
// block shell, header toolbar, raw-text body, Explore table, this kind's
// stylesheet) lives in LogRenderer
// (frontend/src/static/block/renderers/log-renderer.js — a DIFFERENT class,
// deliberately same basename, different directory). This file HOLDS a
// LogRenderer instance by COMPOSITION and owns everything that genuinely
// speaks ProseMirror: contentDOM binding/ignoreMutation, the log-line
// decoration plugin (buildPlugins), the read-only guard plugin, resolving
// parsedAssetRef → URL against the held Editor's uuid, and the v1 APPLIER
// registered with the BlockService (where the renderer's outbound verbs
// become tracked PM transactions).

import { esc, getLowlight } from '../../../base/fenced-block-base.js'
import { T } from '../../../base/tiptap-vendor.js'
import { registerSieveRenderer, sieveBlockFor } from '../../../block/sieve-block-extension.js'
import { MODE } from '../../../block/sieve-block.js'
import { LogRenderer } from '../../../block/renderers/log-renderer.js'

;(function () {
  'use strict'

  // Spring Boot log line — compiled once (was recompiled per line in applyHighlight).
  var SPRING_LINE_RE = /^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(\w+)\s+(.*?)\s+---\s+\[(.*?)\]\s+(.*?)\s+:\s+(.*)$/

  // The header toolbar (badge/format/raw-explore toggle/noise/filter/column
  // buttons) is built by LogRenderer, whose controls call its OWN semantic
  // verbs (setMode / setFilter / toggleNoise / toggleColumn). It self-refreshes
  // once the parsed-JSON columns load.

  // liveRenderers — id → live LogRenderer instance. The behaviour-registry
  // path (policy Mod+Enter) resolves the block's renderer here so every
  // trigger lands on the SAME verb methods the header toggle calls.
  /** @type {Record<string, any>} */
  var liveRenderers = {}

  // ── LogNodeView ────────────────────────────────────────────────────────

  var LogNodeView = {
    // flipMode — THE mode-flip op (contract: one function, N entry points).
    // Lands on the live renderer's setMode — the SAME verb the header toggle
    // calls; the enum→wire mapping stays private to LogRenderer.
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
      // renderer's semantic verbs (via the v1 applier below), so a configured
      // log comes back configured.
      mode:            { default: '', parseHTML: function (el) { return el.getAttribute('data-mode') || '' } },
      filter:          { default: '', parseHTML: function (el) { return el.getAttribute('data-filter') || '' } },
      disabledCols:    { default: '', parseHTML: function (el) { return el.getAttribute('data-disabled-cols') || '' } },
      hideNoise:       { default: false, parseHTML: function (el) { return el.getAttribute('data-hide-noise') === 'true' } },
    },

    // Read-only text: caret may enter (select/copy), typing is consumed.
    // Mod+Enter toggles raw↔explore (declared policy override, same
    // mechanism as diagram's edit↔render — see interaction-policy.js).
    interactionPolicy: { caretStop: true, modEnterTogglesMode: true },

    // onModEnter — policy-extension entry point: flip raw↔explore. `_host` is
    // the parent Editor, threaded by the interaction-policy extension (unused
    // — the flip routes through the live renderer's verb).
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

    // text* + code:true — the raw captured log lines ARE the node's text content,
    // exactly like code/diagram. Editing is blocked by the read-only plugin below.
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

      // resolveAssetUrl — the parsedAssetRef → fetchable URL resolution needs
      // the held Editor's document uuid (a PM-framework concern via
      // ctx.getEditor()), so it stays adapter-side; the RESOLVED url travels to
      // LogRenderer as an envelope overlay field (alongside `source` as the
      // live PM text — the overlay keys are this kind's own knowledge).
      function resolveAssetUrl(ref) {
        if (!ref) return ''
        if (ref.startsWith('/')) return ref
        return '/sieve/' + (ctx && ctx.getEditor() && ctx.getEditor().uuid || '') + '/' + ref.split('/').pop()
      }

      // envelopeFor — the typed envelope for this NodeView's renderer.
      function envelopeFor(n) {
        return sieveBlockFor(n, { source: n.textContent, resolvedAssetUrl: resolveAssetUrl(n.attrs.parsedAssetRef) })
      }

      // The renderer instance this NodeView HOLDS by composition. It builds its
      // own header (raw/explore toggle, filter, column buttons — self-refreshing
      // once the parsed-JSON columns load) and the raw/explore bodies; this
      // adapter only supplies PM-only concerns around it. Its semantic verbs
      // effect through the BlockService, whose v1 applier is registered below.
      var renderer = new LogRenderer(envelopeFor(node), ctx.blockService || null)

      // v1 APPLIER — today's PM-transaction behaviour behind the service
      // boundary: the renderer's outbound verbs land here, where PM knowledge
      // lives (the content→source mapping, tracked attr transactions via
      // ctx.updateAttributes — the applier IS the sanctioned PM-side
      // implementation).
      var unregisterApplier = ctx.blockService ? ctx.blockService.registerApplier({
        owns: function (id) { return !!id && id === (currentAttrs.id || '') },
        updateAttributes: function (_id, patch) { ctx.updateAttributes(patch) },
        setContent: function (_id, text) { ctx.updateAttributes({ source: text }) },
        retry: function () { ctx.retry() },
      }) : null

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
          renderer.update(envelopeFor(updatedNode))
          return true
        },
        ignoreMutation: function (mutation) {
          return !contentDOM.contains(mutation.target)
        },
        destroy: function () {
          if (unregisterApplier) unregisterApplier()
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

      function isInside(state, from, to) {
        var inside = false
        state.doc.nodesBetween(from, to, function(node) {
          if (node.type === nodeType) inside = true
        })
        return inside
      }

      // ── Log syntax highlighting via decorations ───────────────────────────────
      // Semantic classes only — colours and noise-dimming live in CSS
      // (log-renderer.styles.js) so the noise toggle is a pure view concern
      // (a class on the block root).
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
            // Keyboard read-only enforcement lives in the interaction-policy
            // extension (interactionPolicy.readOnlyText above) — contract
            // rule: no per-renderer key handling. handleTextInput/Paste/Drop
            // stay here: they guard input paths, not keys.
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
