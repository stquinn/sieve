// sieve-block-extension.js — Sieve block node factory.
//
// Renderer interface (each renderer file must supply these fields):
//
//   nodeConfig   { atom, selectable, draggable, group, inline }
//       ProseMirror schema overrides. Defaults: atom:true, selectable:true, draggable:true, group:'block', inline:false.
//       These are schema-level — fixed at editor init time, cannot change at runtime.
//       Use selectable:false + draggable:false for user-editable blocks (code, diagram).
//       Use group:'inline', inline:true for nodes that render inside text flow (e.g. smart-link).
//
//   attrs   { [key]: TipTap attr definition }
//       Kind-specific TipTap attributes. Merged with the five base attrs that every
//       sieve block shares: kind, id, rawYaml, status, createdAt.
//
//   parseAttrs(data) → { key: value }
//       Called by the fence parser. Receives the parsed YAML object; returns the
//       extra data-* HTML attributes the renderer needs on initial parse.
//
//   makeNodeView(node, editor) → TipTap NodeView
//       Returns the NodeView object (dom, update, stopEvent, etc.).
//
// Optional renderer fields (framework injects these behaviours automatically):
//
//   buildContextMenuItems({ node, editor, getPos }) → [ item, ... ]
//       Block-specific context menu items prepended before the framework items.
//       The framework always appends: Ask AI, Explain, Delete, Retry/Replay, Promote.
//
//   buildAiCtx(node) → { contextLabel, imageIds? }
//       Customise the "Ask About [X]" popup label and any image IDs to include.
//       Defaults to a capitalised version of the block kind if omitted.
//
// Registration:
//   window.TipTap.registerSieveRenderer('code', CodeRenderer)
//   → creates a TipTap node named 'sieve-code' with the renderer's config/attrs
//   → getSieveNodes() includes it automatically — no editor.js changes needed
//
// Adding a new block kind:
//   1. Create <kind>-renderer.js following the interface above
//   2. Add <script type="module" src="/static/<kind>-renderer.js"> to index.html
//      after sieve-block-extension.js
//   That's it.

import { esc, isJobStale, getLowlight, extractTextFromDOM } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap
  var Node = T.Node
  var mergeAttributes = T.mergeAttributes

  // ── Base attributes shared by every sieve block kind ─────────────────────────

  var BASE_ATTRS = {
    kind:             { default: '',        parseHTML: function (el) { return el.getAttribute('data-kind')        || '' } },
    id:               { default: '',        parseHTML: function (el) { return el.getAttribute('data-id')          || '' } },
    serialisedForm:   { default: '',        parseHTML: function (el) { return el.getAttribute('data-serialised-form') || '' } },
    status:           { default: 'PENDING', parseHTML: function (el) { return el.getAttribute('data-status')      || 'PENDING' } },
    createdAt:        { default: null,      parseHTML: function (el) { return el.getAttribute('data-created-at')  || null } },
    supportsEmbedding: { default: false, parseHTML: function (el) { return el.getAttribute('data-supports-embedding') === 'true' } },
  }

  var DEFAULT_NODE_CONFIG = { atom: true, selectable: true, draggable: true, group: 'block', inline: false }

  // ── Node factory ─────────────────────────────────────────────────────────────

  function createSieveNode(kind, renderer) {
    var cfg      = Object.assign({}, DEFAULT_NODE_CONFIG, renderer.nodeConfig || {})
    var nodeName = 'sieve-' + kind   // e.g. 'sieve-code', 'sieve-diagram'
    var dataType = 'sieve-' + kind   // value of the data-type HTML attribute

    var tag = cfg.inline ? 'span' : 'div'

    return Node.create({
      name:       nodeName,
      group:      cfg.group,
      inline:     cfg.inline,
      atom:       cfg.atom,
      selectable: cfg.selectable,
      draggable:  cfg.draggable,

      addAttributes() {
        return Object.assign({}, BASE_ATTRS, renderer.attrs || {})
      },

      parseHTML() {
        return [{ tag: tag + '[data-type="' + dataType + '"]' }]
      },

      renderHTML({ HTMLAttributes }) {
        return [tag, mergeAttributes({ 'data-type': dataType }, HTMLAttributes)]
      },

      addNodeView() {
        return function ({ node, editor, getPos }) {
          var view = renderer.makeNodeView(node, editor)
          if (view.dom) {

            view.dom.addEventListener('contextmenu', function (e) {
              e.preventDefault()
              e.stopPropagation()
              var currentNode = (typeof getPos === 'function') ? editor.state.doc.nodeAt(getPos()) : node
              var n = currentNode || node
              var IC = window.SieveIcons || {}

              var items = renderer.buildContextMenuItems
                ? renderer.buildContextMenuItems({ node: n, editor: editor, getPos: getPos })
                : []

              // Ask AI + Explain — universal for every sieve block.
              // blockRef is the block's own ID; Go's BuildContext + expandAIBlockRefs handle context assembly.
              // Optionally declare buildAiCtx(node) → { contextLabel, imageIds? } to customise the popup label.
              var aiBase = renderer.buildAiCtx ? renderer.buildAiCtx(n) : {}
              var kindLabel = n.attrs.kind
                ? n.attrs.kind.charAt(0).toUpperCase() + n.attrs.kind.slice(1).replace(/-/g, ' ')
                : 'Block'
              var aiCtx = {
                content:      '',
                blockRef:     n.attrs.id || 'doc',
                history:      '',
                contextLabel: (aiBase && aiBase.contextLabel) || kindLabel,
                imageIds:     (aiBase && aiBase.imageIds) || [],
              }
              items = items.concat([
                { type: 'divider' },
                { icon: IC.sparkle, label: 'Ask AI…', action: function () {
                  if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
                  else editor.commands.focus()
                  document.dispatchEvent(new CustomEvent('sieve:ai-ask', { detail: { precomputedCtx: aiCtx } }))
                }},
                { icon: IC.info,    label: 'Explain',  action: function () {
                  if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
                  else editor.commands.focus()
                  document.dispatchEvent(new CustomEvent('sieve:ai-explain', { detail: { precomputedCtx: aiCtx } }))
                }},
              ])

              // Delete — universal for every sieve block.
              items = items.concat([
                { type: 'divider' },
                { icon: IC.trash, label: 'Delete', action: function () {
                  if (typeof getPos === 'function') {
                    var pos = getPos()
                    editor.view.dispatch(editor.state.tr.delete(pos, pos + n.nodeSize))
                  }
                }},
              ])

              // Retry / Replay — automatic for all sieve blocks with a job lifecycle.
              // PENDING/DISPATCHED = stale if job no longer active and createdAt > 15s ago.
              var status = n.attrs.status || 'PENDING'
              var isStale = (status === 'PENDING' || status === 'DISPATCHED') && isJobStale(n.attrs.createdAt, n.attrs.id)
              var isError = status === 'ERROR' || status === 'TIMEOUT'
              if (isStale || isError || status === 'COMPLETE') {
                items = items.concat([
                  { type: 'divider' },
                  { icon: IC.refresh, label: (isStale || isError) ? 'Retry' : 'Replay',
                    action: function () {
                      document.dispatchEvent(new CustomEvent('sieve:block-retry', { detail: { id: n.attrs.id } }))
                    }
                  },
                ])
              }

              // Embed in document — automatic for any block with supportsEmbedding: true.
              if (n.attrs.supportsEmbedding && status === 'COMPLETE') {
                items = items.concat([
                  { type: 'divider' },
                  { icon: IC.promote, label: 'Embed in document',
                    action: function () {
                      document.dispatchEvent(new CustomEvent('sieve:promote-block', {
                        detail: { id: n.attrs.id }
                      }))
                    }
                  },
                ])
              }

              document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
                detail: { x: e.clientX, y: e.clientY, context: { type: 'sieveBlock', items: items } },
              }))

              var entries = null
              var extractSourceLabel = ''

              // Image click — check before <pre> so a click on an <img> inside a
              // code-adjacent block takes the image path, not the text path.
              var closestImg = e.target.tagName === 'IMG' ? e.target
                : (e.target.closest ? e.target.closest('img') : null)
              if (closestImg && closestImg.src && view.dom.contains(closestImg)) {
                entries = [{ mimeType: 'text/uri-list', content: closestImg.src }]
                extractSourceLabel = 'image'
              }

              // Anchor click
              var closestA = e.target.tagName === 'A' ? e.target
                : (e.target.closest ? e.target.closest('a') : null)
              if (!entries && closestA && closestA.href && view.dom.contains(closestA)) {
                entries = [{ mimeType: 'text/uri-list', content: closestA.href }]
                extractSourceLabel = 'link'
              }

              if (!entries) {
                var textContent = ''
                var closestPre = e.target.closest && e.target.closest('pre')
                if (closestPre && view.dom.contains(closestPre)) {
                  var lang = ''
                  var codeEl = closestPre.querySelector('code') || closestPre
                  ;(codeEl.className || '').split(' ').forEach(function (cls) {
                    if (cls.indexOf('language-') === 0) lang = cls.slice(9)
                  })
                  textContent = '```' + lang + '\n' + codeEl.textContent + '\n```'
                  extractSourceLabel = lang === 'mermaid' ? 'diagram' : 'code'
                }

                if (!textContent) {
                  extractSourceLabel = n.attrs.kind || 'text'
                  if (n.attrs.kind === 'code' || n.attrs.kind === 'diagram') {
                    var lang = n.attrs.language || (n.attrs.kind === 'diagram' ? 'mermaid' : '')
                    textContent = '```' + lang + '\n' + (n.attrs.source || '') + '\n```'
                  } else if (n.attrs.serialisedForm) {
                    textContent = n.attrs.serialisedForm
                  } else {
                    textContent = extractTextFromDOM(view.dom)
                  }
                }

                if (textContent) {
                  entries = [{ mimeType: 'text/plain', content: textContent }]
                }
              }

              if (entries) {
                fetch('/api/detect-extractions', {
                  method: 'POST',
                  body: JSON.stringify({ sourceKind: n.attrs.kind, entries: entries }),
                  headers: { 'Content-Type': 'application/json' }
                }).then(function (res) { return res.json() }).then(function (candidates) {
                  if (!candidates || candidates.length === 0) return
                  if (!window.SieveContextMenu || !window.SieveContextMenu.appendItems) return

                  var extraItems = [
                    { type: 'divider' },
                    { type: 'header', label: 'EXTRACT FROM ' + extractSourceLabel.toUpperCase().replace('-', ' ') }
                  ]
                  candidates.forEach(function (c) {
                    var icon = IC[c.kind] || IC.code
                    var r = renderers[c.kind]
                    var prettyKind = (r && typeof r.getFriendlyName === 'function')
                      ? r.getFriendlyName()
                      : c.kind.split('-').map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1) }).join(' ')
                    
                    var defaultAction = function (context) {
                      document.dispatchEvent(new CustomEvent('sieve:extract', {
                        detail: { blockId: n.attrs.id, targetKind: c.kind, sourceNode: n, entries: entries, context: context || {} }
                      }))
                    }

                    if (r && typeof r.getExtractionMenuItems === 'function') {
                      var items = r.getExtractionMenuItems(n, entries, defaultAction)
                      if (items && items.length) {
                        items.forEach(function(item) { extraItems.push(item) })
                        return
                      }
                    }

                    extraItems.push({
                      icon: icon,
                      label: 'Extract as ' + prettyKind,
                      action: function () { defaultAction({}) }
                    })
                  })
                  window.SieveContextMenu.appendItems(extraItems)
                }).catch(function() {})
              }
            })
          }
          return view
        }
      },

      addStorage() {
        return {
          markdown: {
            // Serialise: replay serialisedForm verbatim.
            // Go owns all Markdown generation; JS never reconstructs fences or inline blocks manually.
            serialize: function (state, node) {
              if (cfg.inline) {
                state.write(node.attrs.serialisedForm || '')
              } else {
                state.ensureNewLine()
                state.write(node.attrs.serialisedForm || '```' + kind + '\n\n```')
                state.closeBlock(node)
              }
            },

            parse: {
              // Wrap the markdownit fence rule. Only intercepts fences whose info
              // string matches this kind AND whose YAML body contains an id field.
              // All other fences fall through to the previous handler in the chain.
              setup: function (markdownit) {
                // 1. Inline parsing rule for `[!kind] {json} [!kind-end]`
                markdownit.inline.ruler.before('link', 'sieve_inline_' + kind, function(state, silent) {
                  var start = state.pos
                  if (state.src.charCodeAt(start) !== 0x5B /* [ */) return false
                  if (state.src.charCodeAt(start + 1) !== 0x21 /* ! */) return false

                  var regex = new RegExp('^\\\[!' + kind + '\\\]\\s*(\\\{.*?\\\})\\s*\\\[!' + kind + '-end\\\]')
                  var match = regex.exec(state.src.slice(start))
                  if (!match) return false

                  if (!silent) {
                    var jsonStr = match[1]
                    var data = null
                    try { data = JSON.parse(jsonStr) } catch (e) {}

                    if (data && data.id) {
                      var token = state.push('sieve_inline_' + kind, tag, 0)
                      var htmlAttrs = [
                        ['data-type', dataType],
                        ['data-kind', kind],
                        ['data-id', data.id],
                        ['data-serialised-form', match[0]],
                        ['data-status', data.status || 'PENDING']
                      ]
                      if (renderer.parseAttrs) {
                        var extra = renderer.parseAttrs(data)
                        Object.keys(extra).forEach(function (k) {
                          var kebab = k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
                          htmlAttrs.push(['data-' + kebab, String(extra[k] != null ? extra[k] : '')])
                        })
                      }
                      if (data.createdAt) {
                        htmlAttrs.push(['data-created-at', data.createdAt])
                      }
                      if (data.supportsEmbedding) {
                        htmlAttrs.push(['data-supports-embedding', 'true'])
                      }
                      token.attrs = htmlAttrs
                    } else {
                      state.pos += match[0].length
                      return false
                    }
                  }
                  state.pos += match[0].length
                  return true
                })

                markdownit.renderer.rules['sieve_inline_' + kind] = function(tokens, idx) {
                  var token = tokens[idx]
                  var attrsStr = token.attrs.map(function(a) { return a[0] + '="' + esc(a[1]) + '"' }).join(' ')
                  return '<' + tag + ' ' + attrsStr + '></' + tag + '>'
                }

                // 2. Block parsing rule for fences
                var prevFence = markdownit.renderer.rules.fence
                markdownit.renderer.rules.fence = function (tokens, idx, options, env, self) {
                  var token     = tokens[idx]
                  var tokenKind = (token.info || '').trim()

                  if (tokenKind !== kind) {
                    return prevFence
                      ? prevFence(tokens, idx, options, env, self)
                      : self.renderToken(tokens, idx, options)
                  }

                  var data
                  try { data = window.jsyaml.load(token.content) } catch (e) { data = null }
                  if (!data || !data.id) {
                    return prevFence
                      ? prevFence(tokens, idx, options, env, self)
                      : self.renderToken(tokens, idx, options)
                  }

                  var markup = token.markup || '```'
                  var serialisedForm = markup + token.info + '\n' + token.content + markup

                  var htmlAttrs = [
                    'data-type="'     + dataType + '"',
                    'data-kind="'     + esc(kind) + '"',
                    'data-id="'       + esc(data.id) + '"',
                    'data-serialised-form="' + esc(serialisedForm) + '"',
                    'data-status="'   + esc(data.status || 'PENDING') + '"',
                  ]
                  if (renderer.parseAttrs) {
                    var extra = renderer.parseAttrs(data)
                    Object.keys(extra).forEach(function (k) {
                      var kebab = k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
                      htmlAttrs.push('data-' + kebab + '="' + esc(String(extra[k] != null ? extra[k] : '')) + '"')
                    })
                  }
                  if (data.createdAt) {
                    htmlAttrs.push('data-created-at="' + esc(data.createdAt) + '"')
                  }
                  if (data.supportsEmbedding) {
                    htmlAttrs.push('data-supports-embedding="true"')
                  }
                  return '<' + tag + ' ' + htmlAttrs.join(' ') + '></' + tag + '>\n'
                }
              },
            },
          },
        }
      },
    })
  }

  // ── Registry ─────────────────────────────────────────────────────────────────

  var nodeRegistry = {}
  var renderers = {}

  function registerSieveRenderer(kind, renderer) {
    nodeRegistry[kind] = createSieveNode(kind, renderer)
    renderers[kind] = renderer
  }

  T.resolveEntriesForKind = function(kind, sourceNode, entries) {
    var r = renderers[kind]
    if (r && typeof r.resolveEntries === 'function') {
      return r.resolveEntries(sourceNode, entries)
    }
    return entries
  }

  function getSieveNodes() {
    return Object.keys(nodeRegistry).map(function (k) { return nodeRegistry[k] })
  }

  // ── Native Code Block (syntax highlighting via CodeBlockLowlight) ─────────────
  // Uses CodeBlockLowlight's decoration system for highlighting. Visual appearance
  // is handled by the existing .tiptap .code-block CSS + .hljs-* token colours.

  if (T.CodeBlockLowlight) {
    window.SieveNativeCodeBlock = T.CodeBlockLowlight.configure({
      lowlight: getLowlight(),
      HTMLAttributes: { class: 'code-block' },
    })
  }

  // ── Exports ───────────────────────────────────────────────────────────────────

  T.registerSieveRenderer = registerSieveRenderer
  T.getSieveNodes         = getSieveNodes

})()
