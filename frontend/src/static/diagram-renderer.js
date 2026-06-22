// diagram-renderer.js — Sieve block renderer for the 'diagram' kind.
//
// Edit mode: textarea + syntax-highlight overlay + line gutter (same pattern as code-renderer.js).
// Render mode: SVG from mermaid.js, lazy-loaded from vendor/mermaid.min.js.
// Mode and cursor position are persisted in YAML via sieve:block-update so they survive reloads.

import { esc, getLowlight, hastToHtml } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  // ── Mermaid lazy-loader ───────────────────────────────────────────────────────

  var mermaidReady = null

  function ensureMermaid() {
    if (mermaidReady) return mermaidReady
    mermaidReady = new Promise(function (resolve, reject) {
      if (window.mermaid) { initMermaid(); resolve(); return }
      var s = document.createElement('script')
      s.src = '/static/vendor/mermaid.min.js'
      s.onload = function () { initMermaid(); resolve() }
      s.onerror = function () { mermaidReady = null; reject(new Error('Failed to load mermaid.min.js')) }
      document.head.appendChild(s)
    })
    return mermaidReady
  }
  T.ensureMermaid = ensureMermaid

  function buildMermaidTheme() {
    var s = getComputedStyle(document.documentElement)
    function v(name) { return s.getPropertyValue(name).trim() }
    var bgDark    = v('--theme-bgDark')        || '#0e0e0e'
    var bgAlt     = v('--theme-bgAlt')         || '#1a1a1a'
    var text      = v('--theme-text')          || '#cccccc'
    var textDim   = v('--theme-textDim')       || '#888888'
    var accent    = v('--theme-accentPrimary') || '#7aa2f7'
    var accentCy  = v('--theme-accentCyan')    || '#7dcfff'
    var accentGr  = v('--theme-accentGreen')   || '#9ece6a'
    var border    = v('--theme-border')        || '#2a2a2a'
    var border2   = v('--theme-border2')       || '#3a3a3a'

    return {
      startOnLoad: false,
      theme: 'base',
      themeVariables: {
        // Typography
        fontFamily:           v('--theme-monoFont') || 'monospace',
        fontSize:             '12px',

        // Nodes
        background:           bgDark,
        primaryColor:         accent,
        primaryBorderColor:   accent,
        primaryTextColor:     bgDark,
        secondaryColor:       accentCy,
        secondaryBorderColor: accentCy,
        secondaryTextColor:   bgDark,
        tertiaryColor:        accentGr,
        tertiaryBorderColor:  accentGr,
        tertiaryTextColor:    bgDark,

        // Edges & labels
        lineColor:            textDim,
        edgeLabelBackground:  'transparent',
        labelColor:           text,
        labelTextColor:       text,

        // Subgraphs / clusters
        clusterBkg:           bgAlt,
        clusterBorder:        border2,
        titleColor:           textDim,

        // Special shapes (diamonds, cylinders, circles)
        nodeBorder:           border2,
        mainBkg:              accent,
        specNodeLabelColor:   bgDark,
        attributeBackgroundColorOdd:  bgAlt,
        attributeBackgroundColorEven: bgDark,
      },
    }
  }

  function initMermaid() {
    if (!window.mermaid) return
    window.mermaid.initialize(buildMermaidTheme())
  }

  // All active NodeViews register a rerender fn so theme changes re-render live SVGs.
  var activeRenderers = []

  document.addEventListener('sse:settings:changed', function () {
    if (window.mermaid) {
      initMermaid()
      activeRenderers.forEach(function (r) { r() })
    }
  })

  // ── Helpers ───────────────────────────────────────────────────────────────────

  var renderCounter = 0

  function uniqueMermaidId(blockId) {
    return 'mermaid-' + (blockId || 'di') + '-' + (++renderCounter)
  }

  function updateGutter(gutter, source) {
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

  function applyHighlight(highlightCode, source) {
    var low = getLowlight()
    if (low && source) {
      try {
        var result = low.highlight('mermaid', source)
        highlightCode.innerHTML = hastToHtml(result.children) + '\n'
        highlightCode.className = 'language-mermaid hljs'
        return
      } catch (_) {
        // lowlight doesn't know mermaid — fall through to plain text
      }
    }
    highlightCode.textContent = (source ? source + '\n' : '\n')
    highlightCode.className = 'hljs'
  }

  // ── Header (toolbar) ──────────────────────────────────────────────────────────
  // Declared header: badge + 'mermaid' label + an edit/render toggle. The framework
  // seam renders this and re-runs it on attr change, so the active toggle tracks
  // attrs.mode. Toggle clicks persist via ctx.updateAttribute (the one update path);
  // for the prototype the toggle keeps diagram's existing classes/SVGs (zero visual
  // change) — sharing segmentedToggle + CSS promotion is a follow-up.
  var EDIT_SVG = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
    '<path d="M1 7.5 L6 2 L8 4 L3 9 L1 9 Z"/><line x1="5" y1="3" x2="7" y2="5"/></svg>'
  var RENDER_SVG = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
    '<ellipse cx="5" cy="5" rx="4" ry="2.5"/><circle cx="5" cy="5" r="1.2" fill="currentColor" stroke="none"/></svg>'

  function toggleBtn(label, icon, active, activeCls, onClick) {
    var b = document.createElement('button')
    b.className = 'diagram-block__toggle-btn' + (active ? ' ' + activeCls : '')
    b.innerHTML = icon + ' ' + label
    b.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); onClick() })
    return b
  }

  class DiagramHeader extends window.TipTap.AdvancedHeaderProvider {
    badge() { return 'diagram' }
    left() {
      var t = document.createElement('span')
      t.className = 'sieve-block__type-label'
      t.textContent = 'mermaid'
      return [t]
    }
    right(attrs, ctx) {
      var mode = attrs.mode || 'render'
      var toggle = document.createElement('div')
      toggle.className = 'diagram-block__toggle'
      toggle.appendChild(toggleBtn('Edit', EDIT_SVG, mode === 'edit', 'diagram-block__toggle-btn--active-edit', function () {
        if (mode !== 'edit') ctx.updateAttribute({ mode: 'edit' })
      }))
      toggle.appendChild(toggleBtn('Render', RENDER_SVG, mode === 'render', 'diagram-block__toggle-btn--active-render', function () {
        if (mode === 'render') return
        var patch = { mode: 'render' }
        var sel = ctx.editor.view.state.selection
        if (sel.$from.parent.type.name === 'sieve-diagram' && sel.$from.parent.attrs.id === ctx.id) {
          patch.cursorPos = sel.$from.parentOffset
        }
        ctx.updateAttribute(patch)
      }))
      return [toggle]
    }
  }

  // ── DiagramRenderer ───────────────────────────────────────────────────────────

  var DiagramRenderer = {

    headerProvider: new DiagramHeader(),

    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,  // reorder via custom gutter handle; native node-drag fights it (see sieve-block-extension.js DEFAULT_NODE_CONFIG)
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
      source:      { default: '', parseHTML: function (el) { return el.getAttribute('data-source')       || '' } },
      diagramType: { default: 'mermaid', parseHTML: function (el) { return el.getAttribute('data-diagram-type') || 'mermaid' } },
      mode:        { default: 'render', parseHTML: function (el) { return el.getAttribute('data-mode')   || 'render' } },
      cursorPos:   { default: 0,        parseHTML: function (el) { return parseInt(el.getAttribute('data-cursor-pos'))  || 0 } },
    },

    getFriendlyName: function() { return 'Diagram' },
    getIcon: function() { return window.SieveIcons && window.SieveIcons.diagram },


    asContentEntry: function(node) {
      var src = node.textContent || node.attrs.source
      if (!src) return null
      return  [{ mimeType: 'text/plain', content: src }]
    },

    parseAttrs: function (data) {
      return {
        source:      typeof data.source === 'string' ? data.source : '',
        diagramType: data.diagramType || 'mermaid',
        mode:        data.mode        || 'render',
        cursorPos:   typeof data.cursorPos === 'number' ? data.cursorPos : 0,
      }
    },

    makeNodeView: function (node, editor, getPos) {
      var nodeTypeName = node.type.name
      var currentAttrs = Object.assign({}, node.attrs)
      var destroyed    = false

      // ── DOM shell ─────────────────────────────────────────────────────────────

      var dom = document.createElement('div')
      dom.className = 'sieve-block sieve-block--diagram'
      dom.setAttribute('data-id', node.attrs.id || '')

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })

      // ── Header ────────────────────────────────────────────────────────────────
      // The toolbar (badge + mermaid label + edit/render toggle) is now declared as
      // `headerProvider: new DiagramHeader()` and rendered by the framework seam.
      // The toggle dispatches via ctx.updateAttribute instead of the old switchMode.

      // ── Edit body ─────────────────────────────────────────────────────────────

      var editBody = document.createElement('div')
      editBody.className = 'sieve-block__body'

      var gutter = document.createElement('div')
      gutter.className = 'sieve-block__gutter'
      gutter.contentEditable = 'false'
      var codeArea = document.createElement('div')
      codeArea.className = 'sieve-block__code-area'

      var pre = document.createElement('pre')
      pre.className = 'sieve-block__edit' 
      pre.style.whiteSpace = 'pre-wrap'
      pre.style.pointerEvents = 'auto'
      pre.style.outline = 'none'
      pre.style.color = 'var(--theme-text)'
      
      var contentDOM = document.createElement('code')
      contentDOM.className = 'hljs'
      
      pre.appendChild(contentDOM)
      codeArea.appendChild(pre)
      editBody.appendChild(gutter)
      editBody.appendChild(codeArea)

      // ── Render body ───────────────────────────────────────────────────────────

      var renderBody = document.createElement('div')
      renderBody.className = 'diagram-block__render'
      renderBody.setAttribute('tabindex', '0')
      renderBody.style.outline = 'none'

      // ── Helpers ───────────────────────────────────────────────────────────────

      // No flushSource needed; PM natively handles input

      // Dispatch a mode change.
      function switchMode(newMode, pos) {
        var attrs = { mode: newMode, cursorPos: typeof pos === 'number' ? pos : currentAttrs.cursorPos }
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'diagram', attrs: attrs },
        }))
      }

      // (toggle active-state is now rendered by DiagramHeader from attrs.mode,
      // re-run by the seam on each update — no updateToggle needed here.)

      // ── Render functions ──────────────────────────────────────────────────────

      function showEdit(attrs, textContent) {
        var comingFromRender = dom.contains(renderBody)
        if (comingFromRender) dom.removeChild(renderBody)
        if (!dom.contains(editBody)) dom.appendChild(editBody)
        updateGutter(gutter, textContent || '')
        if (comingFromRender) {
          var pos = typeof attrs.cursorPos === 'number' ? attrs.cursorPos : 0
          if (editor && editor.commands && getPos) {
            setTimeout(function() {
              try {
                var pmPos = getPos() + 1 + Math.min(pos, (textContent || '').length)
                editor.commands.setTextSelection(pmPos)
                editor.commands.focus()
              } catch (e) {
                console.error('Failed to restore cursor', e)
                contentDOM.focus()
              }
            }, 0)
          } else {
            contentDOM.focus()
          }
        }
      }

      function showRender(attrs, textContent) {
        var comingFromEdit = dom.contains(editBody)
        if (comingFromEdit) dom.removeChild(editBody)
        if (!dom.contains(renderBody)) dom.appendChild(renderBody)
        // Give the render area keyboard focus so Ctrl+Enter can flip back to edit.
        if (comingFromEdit) renderBody.focus()

        var src = (textContent || '').trim()

        if (!src) {
          renderBody.innerHTML =
            '<div class="diagram-block__loading" style="color:var(--theme-fg3);font-size:12px;padding:20px">' +
            'Add diagram source in Edit mode</div>'
          return
        }

        renderBody.innerHTML = '<div class="diagram-block__loading"><span class="diagram-block__spinner"></span>Rendering…</div>'

        ensureMermaid().then(function () {
          var id = uniqueMermaidId(attrs.id)
          return window.mermaid.render(id, src)
        }).then(function (result) {
          if (destroyed) return
          renderBody.innerHTML = result.svg
        }).catch(function (err) {
          if (destroyed) return
          var msg = (err && err.message) ? err.message : String(err)
          renderBody.innerHTML =
            '<div class="diagram-block__error">' +
            '<div class="diagram-block__error-icon">⚠</div>' +
            '<div>' +
            '<div class="diagram-block__error-title">Diagram syntax error</div>' +
            '<div class="diagram-block__error-msg">' + msg.replace(/</g, '&lt;') + '</div>' +
            '</div></div>'
        })
      }

      function render(attrs, textContent) {
        currentAttrs = attrs
        if (attrs.mode === 'render') {
          showRender(attrs, textContent)
        } else {
          showEdit(attrs, textContent)
        }
      }

      render(node.attrs, node.textContent)

      // Register for theme-change re-renders; cleaned up in destroy().
      function rerender() {
        if (currentAttrs.mode === 'render') showRender(currentAttrs, node.textContent)
      }
      activeRenderers.push(rerender)
      
      var updateTimer = null
      var observer = new MutationObserver(function() {
        var text = contentDOM.textContent
        updateGutter(gutter, text)
        clearTimeout(updateTimer)
        updateTimer = setTimeout(function() {
          if (currentAttrs.id) {
            document.dispatchEvent(new CustomEvent('sieve:block-update', {
              detail: { id: currentAttrs.id, kind: 'diagram', attrs: { source: text } }
            }))
          }
        }, 200)
      })
      observer.observe(contentDOM, { characterData: true, childList: true, subtree: true })

      // ── Events ────────────────────────────────────────────────────────────────

      // (edit/render toggle clicks are wired in DiagramHeader via ctx.updateAttribute.)

      // Note: contentDOM keydown is usually swallowed by ProseMirror's root listener.
      // Ctrl+Enter for switching to render mode is handled in buildPlugins below.

      // Ctrl+Enter / Cmd+Enter in render mode: flip back to edit.
      // stopPropagation prevents the event bubbling to TipTap's root listener.
      renderBody.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          switchMode('edit')
        }
      })

      // ── NodeView ──────────────────────────────────────────────────────────────

      return {
        dom:        dom,
        contentDOM: contentDOM,

        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          node = updatedNode // update ref for rerender
          render(updatedNode.attrs, updatedNode.textContent)
          return true
        },

        selectNode: function () {
          if (currentAttrs.mode === 'edit') contentDOM.focus()
        },

        ignoreMutation: function (mutation) {
          // Allow ProseMirror to handle content mutations natively.
          return !contentDOM.contains(mutation.target)
        },

        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },

        destroy: function () {
          destroyed = true
          clearTimeout(updateTimer)
          observer.disconnect()
          activeRenderers = activeRenderers.filter(function (r) { return r !== rerender })
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
        
        try {
          var result = low.highlight('mermaid', node.textContent)
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
            handleKeyDown: function(view, event) {
              if (event.key !== 'Enter' && event.key !== 'Tab') return false
              
              var state = view.state
              var selection = state.selection
              var isDiagram = false
              var node = null
              var isNodeSelection = !!selection.node
              var pos = 0
              
              if (isNodeSelection) {
                if (selection.node.type === nodeType) {
                  isDiagram = true
                  node = selection.node
                }
              } else {
                if (selection.$from.parent.type === nodeType) {
                  isDiagram = true
                  node = selection.$from.parent
                  pos = selection.$from.parentOffset
                }
              }
              
              if (!isDiagram) return false
              
              if (event.key === 'Enter') {
                if (event.metaKey || event.ctrlKey) {
                  var id = node.attrs.id
                  if (id) {
                    var currentPos = isNodeSelection ? (typeof node.attrs.cursorPos === 'number' ? node.attrs.cursorPos : 0) : pos
                    var newMode = node.attrs.mode === 'render' ? 'edit' : 'render'
                    document.dispatchEvent(new CustomEvent('sieve:block-update', {
                      detail: { id: id, kind: 'diagram', attrs: { mode: newMode, cursorPos: currentPos } }
                    }))
                  }
                  return true
                }
                
                if (!isNodeSelection && node.attrs.mode !== 'render') {
                  view.dispatch(state.tr.insertText('\n').scrollIntoView())
                  return true
                }
                return false
              }
              
              if (event.key === 'Tab' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                if (!isNodeSelection && node.attrs.mode !== 'render') {
                  view.dispatch(state.tr.insertText('  ').scrollIntoView())
                  return true
                }
              }
              return false
            }
          }
        })
      ]
    },
  }

  // ── Context menu ──────────────────────────────────────────────────────────────
  // Ask AI, Explain, and Delete are injected by sieve-block-extension.js framework.

  DiagramRenderer.buildAiCtx = function () { return { contextLabel: 'Diagram' } }

  DiagramRenderer.buildContextMenuItems = function (ctx) {
    var n = ctx.node, editor = ctx.editor, getPos = ctx.getPos
    var IC = window.SieveIcons || {}

    function toggleMode() {
      var newMode = n.attrs.mode === 'render' ? 'edit' : 'render'
      document.dispatchEvent(new CustomEvent('sieve:block-update', {
        detail: { id: n.attrs.id, kind: 'diagram', attrs: { mode: newMode } },
      }))
    }

    function copySource() {
      if (n.attrs.source) navigator.clipboard.writeText(n.attrs.source)
    }

    var modeLabel = n.attrs.mode === 'render' ? 'Edit source' : 'Render'

    var headerLabel = n.attrs.diagramType + ' Diagram'

    return [
       { type: 'header', label: headerLabel},
      { icon: IC.edit, label: modeLabel, action: toggleMode },
      { icon: IC.copy, label: 'Copy source', action: copySource },
    ]
  }

  T.registerSieveRenderer('diagram', DiagramRenderer)

})()
