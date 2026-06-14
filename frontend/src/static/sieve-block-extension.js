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

import { esc, isJobStale, getLowlight, extractTextFromDOM, renderMarkdown } from './fenced-block-base.js'

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

  // draggable:false — reordering is done via the custom gutter handle (block-chrome.js),
  // not ProseMirror's native node drag.  Native node-drag on a draggable block stole
  // textarea/text-selection gestures (a drag inside a code textarea moved the whole block).
  var DEFAULT_NODE_CONFIG = { atom: true, selectable: true, draggable: false, group: 'block', inline: false }

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
      content:    cfg.content,
      marks:      cfg.marks,
      code:       cfg.code,
      defining:   cfg.defining,

      addProseMirrorPlugins() {
        return renderer.buildPlugins ? renderer.buildPlugins(this.type) : []
      },

      addAttributes() {
        return Object.assign({}, BASE_ATTRS, renderer.attrs || {})
      },

      parseHTML() {
        return [{ tag: tag + '[data-type="' + dataType + '"]' }]
      },

      renderHTML({ HTMLAttributes }) {
        return [tag, mergeAttributes({ 'data-type': dataType }, HTMLAttributes)]
      },

      renderText({ node }) {
        return node.attrs.serialisedForm || ''
      },

      addNodeView() {
        return function ({ node, editor, getPos }) {
          var view = renderer.makeNodeView(node, editor, getPos)
          if (view.dom) {
            // Inject the chrome host slot as the FIRST child.
            // BlockChrome will find it via .block-chrome-host and populate it
            // with the line number, drag handle, and rail.  Must be
            // contenteditable="false" so PM never tries to edit it.
            var chromeHost = document.createElement('div')
            chromeHost.className = 'block-chrome-host'
            chromeHost.setAttribute('contenteditable', 'false')
            view.dom.insertBefore(chromeHost, view.dom.firstChild)

            // Explicitly non-editable: prevents the block root from inheriting
            // contentEditable="true" from the ProseMirror root, which would let
            // the browser treat it as an editable area and break PM atom snapping.
            // Only apply this to blocks without a contentDOM (i.e., pure atoms).
            if (!view.contentDOM) {
              view.dom.contentEditable = 'false'
            }

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

              //now lets see if we clicked on something interesting within the block that we can extract data from. 
              var { entries, extractSourceLabel } = extractContentEntryFromEditor( e, editor);

              if(entries == undefined || !entries) {
                //nothign more intersting than the sieve block itself was clicked on, 
                // but if the renderer supports it, we can extract a content entry from 
                extractSourceLabel = renderer.getFriendlyName ? renderer.getFriendlyName(n) : n.attrs.kind || 'block';
                entries =  renderer.asContentEntry(n);
              }
              
              //framework-level auto extraction for any sieve block, if the renderer supports it.
              entries.push({ mimeType: 'sieve/' + node.attrs.kind, content: node.attrs.serialisedForm })
              

              if (entries) {
                detectAndAppendExtractions({
                  sourceNode: n,
                  sourceKind: n.attrs.kind,
                  entries: entries,
                  blockId: n.attrs.id,
                  extractSourceLabel: extractSourceLabel
                })
              }
            })
          }

          // ── Central stopEvent: shield interactive sub-elements from ProseMirror ──
          // Now that every sieve block is selectable+draggable (uniform schema),
          // we must stop clicks/typing inside a block's own form controls from
          // reaching ProseMirror — otherwise a click in a code textarea would
          // create/clear a NodeSelection and fight the editor caret.  Renderers
          // may also define their own stopEvent (e.g. key handling); we compose
          // with it rather than replacing it.
          var rendererStopEvent = view.stopEvent
          view.stopEvent = function (event) {
            var t = event.target
            // 1. Modifier keyboard shortcuts (Ctrl/Cmd + C/V/S/E…) must reach the
            //    main editor keymap — never stop them here.
            if ((event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress') &&
                (event.ctrlKey || event.metaKey)) {
              return false
            }
            // 2. Drag handle / gutter chrome → let ProseMirror see it (drag-reorder,
            //    whole-block selection are wired off these).
            if (t && t.closest && t.closest('.block-chrome-host, .block-chrome-handle, .drag-handle')) {
              return false
            }
            // 3. Interactive form controls inside the block → shield from PM so
            //    editing/clicking them doesn't disturb the document selection.
            if (t && t.closest &&
                t.closest('textarea, input, button, select, option, a[href], .CodeMirror, .cm-editor')) {
              return true
            }
            // 4. Otherwise defer to the renderer's own stopEvent (if any), else let PM handle it.
            if (typeof rendererStopEvent === 'function') return rendererStopEvent.call(view, event)
            return false
          }

          // ── Framework-level markdown body sync ──────────────────────────────────
          // Any display block that declares `markdownAttr` (e.g. ai-block → 'response',
          // web-clip → 'content') gets that markdown rendered into its contentDOM as
          // real ProseMirror nodes, using the LIVE editor. renderMarkdown needs the
          // editor's markdownit instance, which getInitialContentHTML cannot reach
          // during parse — so this NodeView seam is where it belongs. Declare the attr
          // and a markdown display block "just works": rich render + native copy/paste.
          if (view.contentDOM && renderer.markdownAttr) {
            var mdAttr = renderer.markdownAttr
            var lastMd = node.attrs[mdAttr]
            var syncMd = function (md) {
              setTimeout(function () {
                if (!editor || !editor.view) return
                var html = renderMarkdown(md || '', editor) || '<p></p>'
                var tmp = document.createElement('div')
                tmp.innerHTML = html
                var PMDP = window.TipTap.ProseMirrorDOMParser || window.TipTap.DOMParser
                var slice = PMDP.fromSchema(editor.state.schema).parseSlice(tmp)
                var pos = typeof getPos === 'function' ? getPos() : -1
                if (pos === -1) return
                var cur = editor.state.doc.nodeAt(pos)
                if (!cur || !cur.type.name.startsWith('sieve-')) return
                var tr = editor.state.tr
                tr.replace(pos + 1, pos + 1 + cur.content.size, slice)
                tr.setMeta('sieve-md-sync', true)
                tr.setMeta('addToHistory', false)
                editor.view.dispatch(tr)
              }, 0)
            }
            if (lastMd) syncMd(lastMd)
            var origUpdate = (typeof view.update === 'function') ? view.update.bind(view) : null
            view.update = function (updatedNode) {
              var ok = origUpdate ? origUpdate(updatedNode) : true
              if (!ok) return false
              if (updatedNode.attrs[mdAttr] !== lastMd) {
                lastMd = updatedNode.attrs[mdAttr]
                syncMd(lastMd)
              }
              return true
            }
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

                  var innerHTML = ''
                  if (!cfg.atom && renderer.getInitialContentHTML) {
                    innerHTML = renderer.getInitialContentHTML(data)
                  }

                  return '<' + tag + ' ' + htmlAttrs.join(' ') + '>' + innerHTML + '</' + tag + '>\n'
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

  // Canonical friendly name for a sieve block node — the ONE source the live
  // label, the context menu, and the commit path share. Reuses each renderer's
  // optional buildAiCtx(node).contextLabel (e.g. a code block surfacing its
  // language), falling back to a title-cased kind.
  T.getSieveBlockLabel = function (node) {
    var kind = node && node.attrs ? node.attrs.kind : ''
    var r = renderers[kind]
    var base = (r && typeof r.buildAiCtx === 'function') ? r.buildAiCtx(node) : null
    var fallback = kind ? (kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')) : 'Block'
    return (base && base.contextLabel) || fallback
  }

  T.getSieveIcon = function(kind) {
    var r = renderers[kind]
    if (r && typeof r.getIcon === 'function') return r.getIcon()
    return window.SieveIcons ? window.SieveIcons.code : '' // fallback
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

  // replaceSource: when true the source node is REPLACED by the new Sieve block
  // (an in-place upgrade — used for native nodes, whose content IS the block).
  // When false/omitted the operation is additive — the source survives (used for
  // Sieve-block sources like AI/Web Clip, which are read-only composites).
  //
  // additiveKinds: target kinds that stay ADDITIVE even when replaceSource is true.
  // A native source can replace in place only when the target occupies the same slot
  // (block image → smart-image, inline link → smart-link). When the target is a
  // different shape (inline link → block smart-card/web-clip) there is no node to
  // swap, so those kinds are inserted alongside instead. Decided per candidate.
  function detectAndAppendExtractions({ sourceNode, sourceKind, entries, blockId, sourcePos, extractSourceLabel, replaceSource, additiveKinds }) {
    var additive = additiveKinds || []
    fetch('/api/detect-extractions', {
      method: 'POST',
      body: JSON.stringify({ sourceKind: sourceKind, entries: entries }),
      headers: { 'Content-Type': 'application/json' }
    }).then(function (res) { return res.json() }).then(function (candidates) {
      if (!candidates || candidates.length === 0) return
      if (!window.SieveContextMenu || !window.SieveContextMenu.appendItems) return

      var IC = window.SieveIcons || {}
      // Header always names the SOURCE (what was clicked) — "EXTRACT FROM IMAGE" /
      // "CONVERT FROM CODE". The verb signals additive vs in-place; the menu items
      // themselves name the target, so the header must not.
      var headerLabel = (replaceSource ? 'CONVERT FROM ' : 'EXTRACT FROM ') +
        (extractSourceLabel || sourceKind).toUpperCase().replace('-', ' ')
      var extraItems = [
        { type: 'divider' },
        { type: 'header', label: headerLabel }
      ]
      candidates.forEach(function (c) {
        var icon = IC[c.kind] || IC.code
        var r = renderers[c.kind]
        var prettyKind = (r && typeof r.getFriendlyName === 'function')
          ? r.getFriendlyName()
          : c.kind.split('-').map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1) }).join(' ')

        var replace = !!replaceSource && additive.indexOf(c.kind) === -1

        var defaultAction = function (context) {
          document.dispatchEvent(new CustomEvent('sieve:extract', {
            detail: {
              blockId: blockId || null,
              targetKind: c.kind,
              sourceNode: sourceNode,
              sourcePos: sourcePos,
              entries: entries,
              context: context || {},
              replaceSource: replace
            }
          }))
        }

        if (r && typeof r.getExtractionMenuItems === 'function') {
          // Pass the operation kind so a renderer that emits its own labels can match
          // the framework's verb: replace=true is an in-place UPGRADE (native → sieve),
          // replace=false is additive EXTRACTION (a child of a sieve block — the source
          // survives). Without this a renderer can't tell the two apart and mislabels.
          var items = r.getExtractionMenuItems(sourceNode, entries, defaultAction, { replace: replace })
          if (items && items.length) {
            items.forEach(function(item) { extraItems.push(item) })
            return
          }
        }

        extraItems.push({
          icon: icon,
          label: (replace ? 'Convert to ' : 'Extract as ') + prettyKind,
          action: function () { defaultAction({}) }
        })
      })
      window.SieveContextMenu.appendItems(extraItems)
    }).catch(function() {})
  }

  // ── Native Code Block (syntax highlighting via CodeBlockLowlight) ─────────────
  // Uses CodeBlockLowlight's decoration system for highlighting. Visual appearance
  // is handled by the existing .tiptap .code-block CSS + .hljs-* token colours.

  if (T.CodeBlockLowlight) {
    window.SieveNativeCodeBlock = T.CodeBlockLowlight.extend({
      // The bundled tiptap-markdown serialiser for code blocks hardcodes a
      // 3-backtick fence. A code block whose own content contains a ``` run
      // (e.g. a ````markdown block wrapping ```http) therefore has its fence
      // collapsed to 3 ticks on save, which corrupts the document on reload.
      // Override the serialiser to size the fence longer than any backtick run
      // in the content (standard prosemirror-markdown behaviour). The parse
      // spec is replicated verbatim from the bundle so loading is unaffected.
      addStorage() {
        var parent = (this.parent && this.parent()) || {}
        var out = {}
        Object.keys(parent).forEach(function (k) { out[k] = parent[k] })
        out.markdown = {
          serialize: function (state, node) {
            var content = node.textContent || ''
            var longest = 0
            var runs = content.match(/`+/g)
            if (runs) runs.forEach(function (r) { if (r.length > longest) longest = r.length })
            var fence = new Array(Math.max(3, longest + 1) + 1).join('`')
            state.write(fence + (node.attrs.language || '') + '\n')
            state.text(content, false)
            state.ensureNewLine()
            state.write(fence)
            state.closeBlock(node)
          },
          parse: {
            setup: function (markdownit) {
              markdownit.set({ langPrefix: 'language-' })
            },
            updateDOM: function (el) {
              el.innerHTML = el.innerHTML.replace(/\n<\/code><\/pre>/g, '</code></pre>')
            },
          },
        }
        return out
      },
    }).configure({
      lowlight: getLowlight(),
      HTMLAttributes: { class: 'code-block' },
    })
  }

  // ── Exports ───────────────────────────────────────────────────────────────────

  T.registerSieveRenderer = registerSieveRenderer
  T.getSieveNodes         = getSieveNodes
  // serializeNode turns a single block node into markdown via the editor's OWN
  // markdown serialiser. The serialiser sizes code fences longer than any backtick
  // run in the content, so this is the only safe way to render a node to a fence —
  // never hand-build ```. The node is wrapped in a fresh doc so the serialiser has a
  // valid root. Returns '' on failure (e.g. a node the serialiser can't handle).
  function serializeNode(editor, node) {
    try {
      var wrapper = editor.state.schema.topNodeType.create(null, node)
      return (editor.storage.markdown.serializer.serialize(wrapper) || '').trim()
    } catch (err) {
      console.error('[sieve] serializeNode failed', err)
      return ''
    }
  }

  T.detectAndAppendExtractions = detectAndAppendExtractions
  T.extractContentEntryFromEditor = extractContentEntryFromEditor
  T.serializeNode = serializeNode

})()
// extractContentEntryFromEditor inspects whatever DOM element was clicked (event.target)
// and, if it sits on something extractable, returns the ContentEntry array detection
// needs. It is shared by two callers: the Sieve-block NodeView (real DOM event) and the
// editor context menu (a synthetic { target: elementFromPoint(x,y) } — see context-menu.js).
// It therefore reads ONLY event.target; nothing else off the event.
function extractContentEntryFromEditor(event, editor) {
  var entries = null;
  var extractSourceLabel = "";
  var view = editor.view;

  //an image would be interesting to extract, and we can get a data-uri for it if needed.
  var closestImg = event.target.tagName === 'IMG' ? event.target : (event.target.closest ? event.target.closest('img') : null);
  if (closestImg && closestImg.src && view.dom.contains(closestImg)) {
    //not sure this is the right MIME type to use for an image
    entries = [{ mimeType: 'sieve/image', content: closestImg.src }];
    extractSourceLabel = 'image';
  }

  // Anchor click
  var closestA = event.target.tagName === 'A' ? event.target : (event.target.closest ? event.target.closest('a') : null);
  if (!entries && closestA && closestA.href && view.dom.contains(closestA)) {
    entries = [{ mimeType: 'text/uri-list', content: closestA.href }];
    extractSourceLabel = 'link';
  }

  if (!entries) {
    var closestPre = event.target.closest && event.target.closest('pre');
    if (closestPre && view.dom.contains(closestPre)) {
      // Resolve the clicked <pre> back to its ProseMirror codeBlock node so the
      // markdown serialiser can fence it correctly (nested ``` runs and all). A
      // Sieve block's rendered <pre> is NodeView DOM, not a real codeBlock node — it
      // resolves to no codeBlock here and is left to asContentEntry / the sieve/<kind>
      // entry instead, which is the correct path for those.
      var codeNode = null;
      try {
        var $pos = view.state.doc.resolve(view.posAtDOM(closestPre, 0));
        for (var d = $pos.depth; d >= 0; d--) {
          if ($pos.node(d).type.name === 'codeBlock') { codeNode = $pos.node(d); break; }
        }
      } catch (err) { /* pre isn't a mappable PM position — fall through */ }

      if (codeNode) {
        var fenced = window.TipTap.serializeNode(editor, codeNode);
        if (fenced) {
          entries = [{ mimeType: 'text/plain', content: fenced }];
          extractSourceLabel = codeNode.attrs.language === 'mermaid' ? 'diagram' : 'code';
        }
      }
    }
  }
  return { entries, extractSourceLabel };
}

