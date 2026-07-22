// log-renderer.js — Sieve NodeView ADAPTER for the 'log' kind (the PM half of
// the renderer/NodeView split, docs/design/archive/specs/2026-07-20-block-renderer-extraction.md
// Phase 4 / issue #47). Look-and-feel (the block shell, raw-text body, Explore
// table, this kind's stylesheet) lives in LogRenderer
// (frontend/src/static/block/renderers/log-renderer.js — a DIFFERENT class,
// deliberately same basename, different directory). This file HOLDS a
// LogRenderer instance by COMPOSITION and owns everything that genuinely
// speaks ProseMirror: contentDOM binding/ignoreMutation, the log-line
// decoration plugin (buildPlugins), the read-only guard plugin, and the
// header toolbar (badge/format/raw-explore toggle/noise/filter/column
// buttons — a PM-framework headerProvider slot, same as diagram's
// DiagramHeader and code's CodeHeader). LogHeader reads LogRenderer's static
// mode/disabledCols helpers rather than re-deriving them.

import { esc, getLowlight } from '../base/fenced-block-base.js'
import { T } from '../base/tiptap-vendor.js'
import { registerSieveRenderer, AdvancedHeaderProvider, badgeEl } from '../block/sieve-block-extension.js'
import { updateBlockOp } from '../block/block-sync.js'
import { LogRenderer } from '../block/renderers/log-renderer.js'

;(function () {
  'use strict'

  // Spring Boot log line — compiled once (was recompiled per line in applyHighlight).
  var SPRING_LINE_RE = /^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(\w+)\s+(.*?)\s+---\s+\[(.*?)\]\s+(.*?)\s+:\s+(.*)$/

  // ── Header (toolbar) ──────────────────────────────────────────────────────────
  // The richest toolbar: badge + format + raw/explore toggle + (noise | filter +
  // column toggles), all mode-dependent. State is persisted attrs (mode/filter/
  // disabledCols/hideNoise), written via ctx.updateAttributes. WHICH column buttons
  // exist is data-driven — LogRenderer publishes them via onColumnsAvailable into
  // ctx.state.cols + ctx.refreshHeader() once the parsed JSON loads.
  var RAW_SVG = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
    '<path d="M1 7.5 L6 2 L8 4 L3 9 L1 9 Z"/><line x1="5" y1="3" x2="7" y2="5"/></svg>'
  var EXPLORE_SVG = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
    '<rect x="1" y="1" width="8" height="8" rx="1"/><line x1="1" y1="4" x2="9" y2="4"/><line x1="4" y1="4" x2="4" y2="9"/></svg>'

  class LogHeader extends AdvancedHeaderProvider {
    badge() { return 'Log' }

    left(attrs, ctx) {
      var items = []
      if (attrs.logFormatName) {
        var fb = badgeEl('Format: ' + attrs.logFormatName)
        fb.style.background = 'var(--theme-bg)'
        fb.style.color = 'var(--theme-textSubtle)'
        fb.style.border = '1px solid var(--theme-border)'
        fb.style.fontWeight = 'normal'
        fb.style.marginLeft = '12px'
        if (attrs.logFormatRegex) fb.title = 'Regex: ' + attrs.logFormatRegex
        items.push(fb)
      }
      var explore = LogRenderer.isExplore(attrs)
      var toggle = document.createElement('div')
      toggle.className = 'log-block__toggle'
      toggle.style.marginLeft = '8px'
      var rawBtn = document.createElement('button')
      rawBtn.className = 'log-block__toggle-btn' + (!explore ? ' log-block__toggle-btn--active-raw' : '')
      rawBtn.innerHTML = RAW_SVG + ' Raw'
      rawBtn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); if (explore) ctx.updateAttributes({ mode: 'raw' }) })
      var exploreBtn = document.createElement('button')
      exploreBtn.className = 'log-block__toggle-btn' + (explore ? ' log-block__toggle-btn--active-explore' : '')
      exploreBtn.innerHTML = EXPLORE_SVG + ' Explore'
      exploreBtn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); if (!explore) ctx.updateAttributes({ mode: 'explore' }) })
      toggle.appendChild(rawBtn); toggle.appendChild(exploreBtn)
      items.push(toggle)
      if (!explore) {
        var noiseBtn = document.createElement('button')
        noiseBtn.className = 'sieve-block__badge sieve-block__badge--clickable' + (attrs.hideNoise ? ' sieve-block__badge--active' : '')
        noiseBtn.textContent = attrs.hideNoise ? 'Show Noise' : 'Toggle Noise'
        noiseBtn.style.cursor = 'pointer'
        noiseBtn.style.marginLeft = '8px'
        noiseBtn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); ctx.updateAttributes({ hideNoise: !attrs.hideNoise }) })
        items.push(noiseBtn)
      }
      return items
    }

    right(attrs, ctx) {
      if (!LogRenderer.isExplore(attrs)) return []
      var items = []
      var filter = document.createElement('input')
      filter.type = 'text'
      filter.placeholder = 'Filter...'
      filter.className = 'sieve-block__badge'
      filter.value = attrs.filter || ''
      filter.style.background = 'transparent'
      filter.style.border = '1px solid var(--theme-border)'
      filter.style.color = 'var(--theme-text)'
      filter.style.outline = 'none'
      filter.addEventListener('mousedown', function (e) { e.stopPropagation() })
      filter.addEventListener('input', function (e) { e.stopPropagation(); ctx.updateAttributes({ filter: filter.value }) })
      items.push(filter)

      var cols = ctx.state.cols || []
      if (cols.length) {
        var disabled = LogRenderer.disabledSet(attrs)
        var wrap = document.createElement('div')
        wrap.style.display = 'flex'
        wrap.style.alignItems = 'center'
        wrap.style.marginLeft = '8px'
        cols.forEach(function (col) {
          var btn = document.createElement('div')
          btn.className = 'sieve-block__badge sieve-block__badge--clickable' + (!disabled[col.key] ? ' sieve-block__badge--active' : '')
          btn.textContent = col.name
          btn.style.opacity = disabled[col.key] ? '0.4' : '1'
          btn.style.cursor = 'pointer'
          btn.style.marginLeft = '4px'
          btn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); ctx.updateAttributes({ disabledCols: LogRenderer.toggleDisabled(attrs, col.key) }) })
          wrap.appendChild(btn)
        })
        items.push(wrap)
      }
      return items
    }
  }

  // ── LogNodeAdapter ────────────────────────────────────────────────────────
  // The registered descriptor sieve-block-extension.js's duck-typed
  // registerSieveRenderer() consumes. Named distinctly from the imported
  // LogRenderer CLASS above — same word, two different layers — to keep the
  // two unambiguous in this file.

  var LogNodeAdapter = {
    headerProvider: new LogHeader(),

    attrs: {
      source:          { default: '', parseHTML: function (el) { return el.getAttribute('data-source')           || '' } },
      language:        { default: 'log', parseHTML: function (el) { return el.getAttribute('data-language')         || 'log' } },
      detectionMethod: { default: '', parseHTML: function (el) { return el.getAttribute('data-detection-method') || '' } },
      parsedAssetRef:  { default: '', parseHTML: function (el) { return el.getAttribute('data-parsed-asset-ref') || '' } },
      logFormatName:   { default: '', parseHTML: function (el) { return el.getAttribute('data-log-format-name') || '' } },
      logFormatRegex:  { default: '', parseHTML: function (el) { return el.getAttribute('data-log-format-regex') || '' } },
      status:          { default: 'COMPLETE', parseHTML: function (el) { return el.getAttribute('data-status') || 'COMPLETE' } },
      // Persisted view settings — the header controls write these via
      // ctx.updateAttributes, so a configured log comes back configured.
      mode:            { default: '', parseHTML: function (el) { return el.getAttribute('data-mode') || '' } },
      filter:          { default: '', parseHTML: function (el) { return el.getAttribute('data-filter') || '' } },
      disabledCols:    { default: '', parseHTML: function (el) { return el.getAttribute('data-disabled-cols') || '' } },
      hideNoise:       { default: false, parseHTML: function (el) { return el.getAttribute('data-hide-noise') === 'true' } },
    },

    // Read-only text: caret may enter (select/copy), typing is consumed.
    // Mod+Enter toggles raw↔explore (declared policy override, same
    // mechanism as diagram's edit↔render — see interaction-policy.js).
    interactionPolicy: { caretStop: true, modEnterTogglesMode: true },

    // onModEnter — policy-extension entry point: flip raw↔explore. `host` is the
    // parent Editor, threaded by the interaction-policy extension.
    onModEnter: function (view, selection, host) {
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
      var newMode = LogRenderer.mode(node.attrs) === 'explore' ? 'raw' : 'explore'
      if (host) host.applyBlockOps([updateBlockOp({ id: node.attrs.id, kind: 'log', attrs: { mode: newMode } })])
      return true
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

      // The renderer instance this NodeView HOLDS by composition (never
      // inheritance — see the file header). All look-and-feel (shell, raw
      // body, Explore table) is its job; this adapter only supplies PM-only
      // and framework concerns around it.
      var renderer = new LogRenderer()
      renderer.onColumnsAvailable(function (cols) {
        ctx.state.cols = cols
        ctx.refreshHeader()
      })

      // resolveAssetUrl — the parsedAssetRef → fetchable URL resolution needs
      // the held Editor's document uuid (a PM-framework concern via
      // ctx.getEditor()), so it stays adapter-side; the RESOLVED url travels
      // to LogRenderer as a plain attrs field (mirrors DiagramRenderer/
      // CodeRenderer's effectiveAttrs pattern for injecting the live text).
      function resolveAssetUrl(ref) {
        if (!ref) return ''
        if (ref.startsWith('/')) return ref
        return '/sieve/' + (ctx && ctx.getEditor() && ctx.getEditor().uuid || '') + '/' + ref.split('/').pop()
      }

      function effectiveAttrs(attrs, textContent) {
        return Object.assign({}, attrs, { source: textContent, resolvedAssetUrl: resolveAssetUrl(attrs.parsedAssetRef) })
      }

      var dom = renderer.mount(effectiveAttrs(node.attrs, node.textContent))
      dom.setAttribute('data-id', node.attrs.id || '')

      var contentDOM = renderer.contentDOM

      // Header (badge + format + raw/explore toggle + noise|filter+cols) is declared
      // as `headerProvider: new LogHeader()` and rendered by the framework seam.

      return {
        dom:        dom,
        contentDOM: contentDOM,
        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          renderer.update(dom, effectiveAttrs(updatedNode.attrs, updatedNode.textContent))
          return true
        },
        ignoreMutation: function (mutation) {
          return !contentDOM.contains(mutation.target)
        },
        destroy: function () {
          renderer.destroy(dom)
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

  LogNodeAdapter.buildAiCtx = function (node) {
    return { contextLabel: 'Log block' }
  }

  LogNodeAdapter.buildContextMenuItems = function ({ node }) {
    return [
      { type: 'header', label: 'Log' },
    ]
  }

  registerSieveRenderer('log', LogNodeAdapter)

})()
