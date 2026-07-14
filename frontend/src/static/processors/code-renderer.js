// code-renderer.js — Sieve block renderer for the 'code' kind.
//
// Editing surface: a ProseMirror contentDOM (pre>code, code:true node) — NOT
// a textarea (that implementation is long gone). Syntax highlighting is
// decoration-based (plugin below); the node's text content is authoritative.
// Keyboard behaviour (Tab/Enter/Home) comes from the shared interaction-policy
// extension via this renderer's interactionPolicy declaration — do NOT add
// handleKeyDown here (docs/editor-interaction-contract.md is normative).

import { esc, isJobStale, getLowlight, hastToHtml } from '../base/fenced-block-base.js'
import { T } from '../base/tiptap-vendor.js'
import { registerSieveRenderer, AdvancedHeaderProvider, badgeEl } from '../block/sieve-block-extension.js'

;(function () {
  'use strict'

  // ── Header (toolbar) ──────────────────────────────────────────────────────────
  // Badge only — but stateful: 'detecting…' while the language job runs, the
  // language once known, else 'CODE'. badge() returns a styled Element so the
  // pending/unknown classes and the detection-method tooltip carry over.
  class CodeHeader extends AdvancedHeaderProvider {
    badge(attrs) {
      var isPending     = attrs.status === 'PENDING' || attrs.status === 'DISPATCHED'
      var isStale       = isPending && isJobStale(attrs.createdAt, attrs.id)
      var showDetecting = isPending && !isStale && (!attrs.language || attrs.language === '')
      var text, cls
      if (showDetecting) { text = 'detecting…'; cls = 'sieve-block__badge--pending' }
      else if (attrs.language && attrs.language !== 'unknown') { text = attrs.language; cls = '' }
      else { text = (attrs.language === 'unknown' ? 'CODE' : attrs.language) || 'CODE'; cls = 'sieve-block__badge--unknown' }
      var b = badgeEl(text, cls)
      if (attrs.detectionMethod) {
        b.setAttribute('data-detection-method', attrs.detectionMethod)
        b.title = 'Detected via ' + attrs.detectionMethod
      }
      return b
    }
  }

  // ── CodeRenderer ─────────────────────────────────────────────────────────────

  var CodeRenderer = {

    headerProvider: new CodeHeader(),

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

    makeNodeView: function (node) {
      var nodeTypeName = node.type.name
      var currentAttrs = Object.assign({}, node.attrs)

      // ── DOM ──────────────────────────────────────────────────────────────────

      var dom = document.createElement('div')
      dom.className = 'sieve-block sieve-block--code'
      dom.setAttribute('data-id', node.attrs.id || '')

      // Header (badge: language / detecting… / CODE) is declared as
      // `headerProvider: new CodeHeader()` and rendered by the framework seam,
      // re-run on attr change so the badge tracks status/language.

      // Body: flex row — gutter + code-area
      var body = document.createElement('div')
      body.className = 'sieve-block__body'

      var gutter = document.createElement('div')
      gutter.className = 'sieve-block__gutter'
      gutter.contentEditable = 'false'

      // CSS Grid cell — code area
      var codeArea = document.createElement('div')
      codeArea.className = 'sieve-block__code-area'

      var pre = document.createElement('pre')
      // Re-use the edit class for padding/fonts, but ensure it acts like a block
      pre.className = 'sieve-block__edit' 
      pre.style.whiteSpace = 'pre-wrap'
      pre.style.pointerEvents = 'auto'
      pre.style.outline = 'none'
      pre.style.color = 'var(--theme-text)' // Fix transparent text
      
      var contentDOM = document.createElement('code')
      contentDOM.className = 'hljs'
      
      pre.appendChild(contentDOM)
      codeArea.appendChild(pre)
      body.appendChild(gutter)
      body.appendChild(codeArea)
      dom.appendChild(body)

      // ── Helpers ───────────────────────────────────────────────────────────────

      function updateGutter(source) {
        var lines = (source || '').split('\n')
        var count = Math.max(lines.length, 1)
        if (gutter.childElementCount === count) return
        gutter.innerHTML = ''
        for (var i = 1; i <= count; i++) {
          var span = document.createElement('span')
          span.textContent = String(i)
          gutter.appendChild(span)
        }
      }

      // Syntax highlighting is handled by the ProseMirror plugin below.
      function applyHighlight(lang) {
        contentDOM.className = (lang && lang !== 'unknown') ? 'language-' + lang + ' hljs' : 'hljs'
      }

      // (badge is rendered by CodeHeader from attrs, re-run by the seam on update.)

      // Content updates are now managed by ProseMirror.
      // We just update the non-content UI (gutter).
      function render(attrs, textContent) {
        currentAttrs = attrs
        applyHighlight(attrs.language || '')
        updateGutter(textContent || '')
      }

      render(node.attrs, node.textContent)

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
        updateGutter(text)
        clearTimeout(updateTimer)
        updateTimer = setTimeout(function() {
          if (currentAttrs.id) {
            document.dispatchEvent(new CustomEvent('sieve:block-update', {
              detail: { id: currentAttrs.id, kind: 'code', attrs: { source: lastSource } }
            }))
          }
        }, 200)
      })
      observer.observe(contentDOM, { characterData: true, childList: true, subtree: true })

      // ── NodeView ──────────────────────────────────────────────────────────────

      return {
        dom:        dom,
        contentDOM: contentDOM,

        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          render(updatedNode.attrs, updatedNode.textContent)
          return true
        },

        ignoreMutation: function (mutation) {
          // Allow ProseMirror to handle content mutations natively.
          return !contentDOM.contains(mutation.target)
        },

        destroy: function () {
          observer.disconnect()
          clearTimeout(updateTimer)
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
  CodeRenderer.buildAiCtx = function (node) {
    var lang = node.attrs.language
    var label = lang && lang !== 'unknown' ? lang + ' block' : 'Code block'
    return { contextLabel: label }
  }

  CodeRenderer.buildContextMenuItems = function ({ node }) {
    var lang = node.attrs.language
    var label = lang && lang !== 'unknown' ? lang + ' block' : 'Code block'
    return [
      { type: 'header', label: label },
    ]
  }

  registerSieveRenderer('code', CodeRenderer)

})()
