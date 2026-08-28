// The NodeView adapter for the 'code' kind. Look-and-feel — the block shell,
// header badge, gutter and code-area chrome, this kind's stylesheet — belongs to
// CodeRenderer, which this file holds by composition. What lives here is
// everything that speaks ProseMirror: the contentDOM binding and ignoreMutation,
// the lowlight decoration plugin, and the MutationObserver that watches
// contentDOM and reports live text through renderer.setContent.
//
// Keyboard behaviour (Tab/Enter/Home) comes from the shared interaction-policy
// extension via this kind's interactionPolicy declaration — do NOT add a
// handleKeyDown here; docs/editor-interaction-contract.md is normative.

import { esc } from '../../../../renderers/html-escape.js'
import { getLowlight, listRegisteredLanguages } from '../../../../renderers/highlighting.js'
import { T } from '../tiptap-vendor.js'
import { registerSieveRenderer, sieveBlockFor } from '../sieve-block-extension.js'
import { CODE_TEXT_POLICY } from '../../interaction-policy.js'
import { CodeRenderer } from '../../../../renderers/code-renderer.js'

;(function () {
  'use strict'

  // The descriptor sieve-block-extension.js's registerSieveRenderer() consumes.
  // Named distinctly from the imported CodeRenderer CLASS: this is the PM-adapter
  // descriptor, that is the look-and-feel class it holds.

  var CodeNodeView = {

    // Code is the canonical literal-source-text kind, so it takes the preset
    // whole. Spread rather than referenced, so policyFor still sees plain flags
    // and any single line stays overridable here.
    interactionPolicy: { ...CODE_TEXT_POLICY },

    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,
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

      // The typed block with `source` overlaid as the LIVE PM text, never the
      // debounced attrs.source, which can lag 200ms behind the document.
      function blockFor(n) {
        return sieveBlockFor(n, { source: n.textContent }, ctx && ctx.provider)
      }

      var renderer = new CodeRenderer(blockFor(node), ctx.provider || null)

      var dom = renderer.render()

      // The <code> element the renderer built is ProseMirror's contentDOM; the
      // word "contentDOM" stays adapter-side, the renderer names no PM concept.
      var contentDOM = renderer.codeElement

      var updateTimer = null
      // The text last OBSERVED. Syntax highlighting rewrites the inner <span> tree
      // whenever the language attr changes, firing this observer with
      // byte-identical text; guarding on a real text change skips that
      // decoration-only re-render, which would otherwise emit a phantom `source`
      // update. Updated ONLY here, never in update(), so genuine edits dispatch.
      var lastSource = node.textContent
      var observer = new MutationObserver(function() {
        var text = contentDOM.textContent
        if (text === lastSource) return   // decoration-only re-render — not an edit
        lastSource = text
        renderer.syncGutterLineCount(text)
        clearTimeout(updateTimer)
        updateTimer = setTimeout(function() {
          if (currentAttrs.id) renderer.setContent(lastSource)
        }, 200)
      })
      observer.observe(contentDOM, { characterData: true, childList: true, subtree: true })

      return {
        dom:        dom,
        contentDOM: contentDOM,
        renderer:   renderer,   // marks this a MIGRATED kind for the seam's branch

        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          currentAttrs = updatedNode.attrs
          renderer.update(blockFor(updatedNode))
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

  /** The Language flyout for a CODE BLOCK: the same registry list a fence
   *  offers, but committed through the wall as a block attr change — and
   *  stamped `manual`, because a hand-picked language is a detection METHOD,
   *  the one the server's detection pipeline never second-guesses.
   *  @param {any} node @param {any} provider @returns {any[]} */
  function blockLanguageItems(node, provider) {
    var IC = window.SieveIcons || {}
    var current = node.attrs.language || ''
    /** @param {string} label @param {string|null} language @param {boolean} isCurrent */
    function item(label, language, isCurrent) {
      return {
        icon: isCurrent ? IC.check : null,
        label: label,
        cls: isCurrent ? 'ctx-item--active' : '',
        action: function () {
          provider.requestSetBlock(node.attrs.id, {
            language: language === null ? '' : language,
            detectionMethod: 'manual',
          })
        },
      }
    }
    var items = [item('Plain', null, !current)]
    listRegisteredLanguages().forEach(function (name) {
      items.push(item(name, name, name === current))
    })
    return items
  }

  CodeNodeView.buildContextMenuItems = function ({ node, provider }) {
    var lang = node.attrs.language
    var label = lang && lang !== 'unknown' ? lang + ' block' : 'Code block'
    var items = [
      { type: 'header', label: label },
    ]
    if (provider && typeof provider.requestSetBlock === 'function') {
      items.push({
        icon: (window.SieveIcons || {}).code || '',
        label: 'Language',
        children: blockLanguageItems(node, provider),
      })
    }
    return items
  }

  registerSieveRenderer('code', CodeNodeView)

})()
