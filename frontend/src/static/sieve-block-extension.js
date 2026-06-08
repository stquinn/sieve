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

import { esc, isJobStale, getLowlight } from './fenced-block-base.js'

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
    supportsPromotion: { default: false, parseHTML: function (el) { return el.getAttribute('data-supports-promotion') === 'true' } },
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
              var items = renderer.buildContextMenuItems
                ? renderer.buildContextMenuItems({ node: n, editor: editor, getPos: getPos })
                : []

              // Retry / Replay — automatic for all sieve blocks with a job lifecycle.
              // DISPATCHED = job actively running; never retryable.
              // PENDING = waiting to dispatch; stale if createdAt > 15s ago.
              var status = n.attrs.status || 'PENDING'
              var isStale = status === 'PENDING' && isJobStale(n.attrs.createdAt, n.attrs.id)
              var isError = status === 'ERROR' || status === 'TIMEOUT'
              if (isStale || isError || status === 'COMPLETE') {
                var IC = window.SieveIcons || {}
                items = items.concat([
                  { type: 'divider' },
                  { icon: IC.refresh, label: (isStale || isError) ? 'Retry' : 'Replay',
                    action: function () {
                      document.dispatchEvent(new CustomEvent('sieve:block-retry', { detail: { id: n.attrs.id } }))
                    }
                  },
                ])
              }

              // Promote to Document — automatic for any block with supportsPromotion: true.
              if (n.attrs.supportsPromotion && status === 'COMPLETE') {
                var IC2 = window.SieveIcons || {}
                items = items.concat([
                  { type: 'divider' },
                  { icon: IC2.promote, label: 'Promote to Document',
                    action: function () {
                      var promoteId = n.attrs.id
                      document.dispatchEvent(new CustomEvent('sieve:promote-block', {
                        detail: { id: promoteId }
                      }))
                    }
                  },
                ])
              }

              document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
                detail: { x: e.clientX, y: e.clientY, context: { type: 'sieveBlock', items: items } },
              }))
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
                      if (data.supportsPromotion) {
                        htmlAttrs.push(['data-supports-promotion', 'true'])
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
                  if (data.supportsPromotion) {
                    htmlAttrs.push('data-supports-promotion="true"')
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

  function registerSieveRenderer(kind, renderer) {
    nodeRegistry[kind] = createSieveNode(kind, renderer)
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
