// sieve-block-extension.js — Sieve block node factory.
//
// Renderer interface (each renderer file must supply these fields):
//
//   nodeConfig   { atom, selectable, draggable }
//       ProseMirror schema overrides. Defaults: atom:true, selectable:true, draggable:true.
//       These are schema-level — fixed at editor init time, cannot change at runtime.
//       Use selectable:false + draggable:false for user-editable blocks (code, diagram)
//       so mouse drag selects text rather than moving the block.
//
//   attrs   { [key]: TipTap attr definition }
//       Kind-specific TipTap attributes. Merged with the five base attrs that every
//       sieve block shares: kind, id, rawYaml, status, createdAt.
//
//   parseAttrs(data) → { key: value }
//       Called by the fence parser. Receives the parsed YAML object; returns the
//       extra data-* HTML attributes the renderer needs on initial parse.
//
//   makeNodeView(node) → TipTap NodeView
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

import { esc } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap
  var Node = T.Node
  var mergeAttributes = T.mergeAttributes

  // ── Base attributes shared by every sieve block kind ─────────────────────────

  var BASE_ATTRS = {
    kind:      { default: '',        parseHTML: function (el) { return el.getAttribute('data-kind')        || '' } },
    id:        { default: '',        parseHTML: function (el) { return el.getAttribute('data-id')          || '' } },
    rawYaml:   { default: '',        parseHTML: function (el) { return el.getAttribute('data-raw-yaml')    || '' } },
    status:    { default: 'PENDING', parseHTML: function (el) { return el.getAttribute('data-status')      || 'PENDING' } },
    createdAt: { default: null,      parseHTML: function (el) { return el.getAttribute('data-created-at')  || null } },
  }

  // Schema defaults for display-only blocks (AI, WebClip). Editable blocks
  // (code, diagram) override selectable and draggable via nodeConfig.
  var DEFAULT_NODE_CONFIG = { atom: true, selectable: true, draggable: true }

  // ── Node factory ─────────────────────────────────────────────────────────────

  function createSieveNode(kind, renderer) {
    var cfg      = Object.assign({}, DEFAULT_NODE_CONFIG, renderer.nodeConfig || {})
    var nodeName = 'sieve-' + kind   // e.g. 'sieve-code', 'sieve-diagram'
    var dataType = 'sieve-' + kind   // value of the data-type HTML attribute

    return Node.create({
      name:       nodeName,
      group:      'block',
      atom:       cfg.atom,
      selectable: cfg.selectable,
      draggable:  cfg.draggable,

      addAttributes() {
        return Object.assign({}, BASE_ATTRS, renderer.attrs || {})
      },

      parseHTML() {
        return [{ tag: 'div[data-type="' + dataType + '"]' }]
      },

      renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes({ 'data-type': dataType }, HTMLAttributes)]
      },

      addNodeView() {
        return function ({ node }) { return renderer.makeNodeView(node) }
      },

      addStorage() {
        return {
          markdown: {
            // Serialise: replay rawYaml verbatim inside a ```kind fence.
            // Go owns all YAML generation; JS never constructs YAML.
            serialize: function (state, node) {
              state.ensureNewLine()
              if (node.attrs.kind && node.attrs.rawYaml) {
                state.write('```' + node.attrs.kind + '\n' + node.attrs.rawYaml + '\n```')
              } else {
                state.write('```\n\n```')
              }
              state.closeBlock(node)
            },

            parse: {
              // Wrap the markdownit fence rule. Only intercepts fences whose info
              // string matches this kind AND whose YAML body contains an id field.
              // All other fences fall through to the previous handler in the chain.
              setup: function (markdownit) {
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

                  var htmlAttrs = [
                    'data-type="'     + dataType + '"',
                    'data-kind="'     + esc(kind) + '"',
                    'data-id="'       + esc(data.id) + '"',
                    'data-raw-yaml="' + esc(token.content) + '"',
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
                  return '<div ' + htmlAttrs.join(' ') + '></div>\n'
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

  // ── Exports ───────────────────────────────────────────────────────────────────

  T.registerSieveRenderer = registerSieveRenderer
  T.getSieveNodes         = getSieveNodes

})()
