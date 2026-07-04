// diagram-renderer.js — Sieve block renderer for the 'diagram' kind.
//
// Edit mode: textarea + syntax-highlight overlay + line gutter (same pattern as code-renderer.js).
// Render mode: SVG from mermaid.js, lazy-loaded from vendor/mermaid.min.js.
// Mode and cursor position are persisted in YAML via sieve:block-update so they survive reloads.

import { esc, getLowlight, hastToHtml } from '../base/fenced-block-base.js'

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

  // renderMermaidSvgEntry renders a mermaid source — from a diagram node OR an embedded
  // ```mermaid fence among the entries — into an image/svg+xml ContentEntry. Resolves to
  // null when there is no mermaid here; render FAILURES reject so each caller chooses to
  // alert (smart-image extract) or degrade (prose embed). Browser-only (window.mermaid).
  // Shared by smart-image's and prose's resolveEntries — keep it; both call it.
  T.renderMermaidSvgEntry = function (sourceNode, entries) {
    var src = ''
    if (sourceNode && sourceNode.attrs && sourceNode.attrs.kind === 'diagram') {
      src = String(sourceNode.attrs.source || '').trim()
    }
    if (!src) {
      for (var i = 0; i < (entries || []).length; i++) {
        var m = /^```mermaid\n([\s\S]*?)```$/.exec(String((entries[i] && entries[i].content) || '').trim())
        if (m) { src = m[1].trim(); break }
      }
    }
    if (!src) return Promise.resolve(null)
    return ensureMermaid().then(function () {
      var id = 'mermaid-render-' + Date.now() + '-' + Math.floor(Math.random() * 1000)
      return window.mermaid.render(id, src)
    }).then(function (result) {
      return { mimeType: 'image/svg+xml', content: result.svg }
    })
  }

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
    var accentOr  = v('--theme-accentOrange')  || '#ff9e64'
    var accentYe  = v('--theme-accentYellow')  || '#e0af68'
    var accentPu  = v('--theme-accentPurple')  || '#bb9af7'
    var accentRe  = v('--theme-accentRed')     || '#f7768e'
    var accentTe  = v('--theme-accentTeal')    || '#73daca'
    var border2   = v('--theme-border2')       || '#3a3a3a'

    // Rotating series palette for multi-series diagrams (pie slices, gitgraph
    // branches, journey/mindmap/timeline cScale, flowchart fillType). Distinct
    // theme accents so adjacent series read apart; assigned via the loop below.
    var palette = [accent, accentCy, accentGr, accentOr, accentYe, accentPu, accentTe, accentRe]

    // CONTRAST MODEL — mermaid's `base` theme assumes a LIGHT canvas with LIGHT
    // node fills, so one dark `textColor` reads everywhere. We invert to a DARK
    // canvas but keep LIGHT accent fills, which breaks that assumption: text on a
    // light fill needs DARK (bgDark); a label on the dark canvas needs LIGHT
    // (text). Mermaid derives ~every per-diagram text colour from `textColor`
    // (which itself defaults to primaryTextColor = bgDark here → dark-on-dark,
    // the whack-a-mole). So: set textColor LIGHT as the canvas default, then
    // override each on-a-fill text colour to bgDark per diagram family below.
    var tv = {
      // ── Typography ──
      fontFamily:           v('--theme-monoFont') || 'monospace',
      fontSize:             '12px',

      // ── Roots ──
      background:           bgDark,
      textColor:            text,        // master label colour (canvas) — the key fix
      lineColor:            textDim,
      arrowheadColor:       textDim,
      titleColor:           text,

      // ── Flowchart / generic nodes (light accent fills → dark text) ──
      primaryColor:         accent,
      primaryBorderColor:   accent,
      primaryTextColor:     bgDark,
      secondaryColor:       accentCy,
      secondaryBorderColor: accentCy,
      secondaryTextColor:   bgDark,
      tertiaryColor:        accentGr,
      tertiaryBorderColor:  accentGr,
      tertiaryTextColor:    bgDark,
      mainBkg:              accent,
      nodeBkg:              accent,
      nodeBorder:           border2,
      nodeTextColor:        bgDark,
      defaultLinkColor:     textDim,

      // ── Edge / generic labels (float on the dark canvas → light) ──
      // NOT 'transparent': flowchart's .labelBkg does fade(edgeLabelBackground, .5),
      // and fade('transparent') → semi-opaque BLACK (a black box behind edge
      // labels like Yes/No). Use the canvas colour so the box blends into the bg.
      edgeLabelBackground:  bgDark,
      labelColor:           text,
      labelTextColor:       text,
      labelBackgroundColor: bgAlt,

      // ── Subgraphs / clusters ──
      clusterBkg:           bgAlt,
      clusterBorder:        border2,

      // ── ER attributes + Class members (boxes are light → dark member text;
      //    relation labels float on the canvas → light) ──
      attributeBackgroundColorOdd:  bgAlt,
      attributeBackgroundColorEven: bgDark,
      classText:            bgDark,
      relationColor:        textDim,
      relationLabelColor:   text,
      relationLabelBackground: bgAlt,

      // ── State diagrams (state boxes light → dark labels; composites +
      //    transition labels live on the canvas → light) ──
      stateBkg:             accent,
      stateLabelColor:      bgDark,
      altBackground:        bgAlt,
      compositeBackground:  bgAlt,
      compositeBorder:      border2,
      compositeTitleBackground: bgAlt,
      innerEndBackground:   bgAlt,
      specialStateColor:    accentRe,
      transitionColor:      textDim,
      transitionLabelColor: text,

      // ── Sequence diagrams (own variable set, ignore the generic labels) ──
      actorBkg:             accent,
      actorBorder:          accent,
      actorTextColor:       bgDark,
      actorLineColor:       textDim,
      signalColor:          textDim,   // arrow/lifeline lines
      signalTextColor:      text,      // message labels above arrows
      labelBoxBkgColor:     bgAlt,
      labelBoxBorderColor:  border2,
      loopTextColor:        text,
      noteBkgColor:         bgAlt,
      noteBorderColor:      border2,
      noteTextColor:        text,
      activationBkgColor:   bgAlt,
      activationBorderColor: border2,
      sequenceNumberColor:  bgDark,

      // ── Gantt (task bars are light accents → dark in-bar text; section bands
      //    and outside/clickable text live on the canvas → light) ──
      sectionBkgColor:      bgAlt,
      sectionBkgColor2:     bgDark,
      altSectionBkgColor:   bgDark,
      taskBkgColor:         accent,
      taskBorderColor:      accent,
      taskTextColor:        bgDark,
      taskTextDarkColor:    bgDark,
      taskTextLightColor:   text,
      taskTextOutsideColor: text,
      taskTextClickableColor: accentCy,
      activeTaskBkgColor:   accentCy,
      activeTaskBorderColor: accentCy,
      doneTaskBkgColor:     bgAlt,
      doneTaskBorderColor:  border2,
      critBkgColor:         accentRe,
      critBorderColor:      accentRe,
      gridColor:            border2,
      todayLineColor:       accentRe,
      excludeBkgColor:      bgAlt,

      // ── Pie (slices = palette accents → dark slice text; title + legend on
      //    the canvas → light) ──
      pieTitleTextColor:    text,
      pieSectionTextColor:  bgDark,
      pieLegendTextColor:   text,
      pieStrokeColor:       bgDark,
      pieOuterStrokeColor:  border2,

      // ── Gitgraph (branch colours = palette below; commit/tag labels) ──
      commitLabelColor:     text,
      commitLabelBackground: bgAlt,
      branchLabelColor:     bgDark,
      tagLabelColor:        bgDark,
      tagLabelBackground:   accentYe,
      tagLabelBorder:       border2,

      // ── Quadrant charts (distinct accent per quadrant; on-fill text dark;
      //    chart title + axis labels on the canvas → light) ──
      quadrant1Fill: accentOr, quadrant2Fill: accentCy, quadrant3Fill: accentGr, quadrant4Fill: accentYe,
      quadrant1TextFill: bgDark, quadrant2TextFill: bgDark, quadrant3TextFill: bgDark, quadrant4TextFill: bgDark,
      quadrantPointFill: bgDark, quadrantPointTextFill: bgDark,
      quadrantTitleFill: text, quadrantXAxisTextFill: text, quadrantYAxisTextFill: text,
      quadrantInternalBorderStrokeFill: border2, quadrantExternalBorderStrokeFill: border2,

      // ── Requirement diagrams (light box → dark text) ──
      requirementBackground: accent,
      requirementBorderColor: accent,
      requirementTextColor:  bgDark,
    }

    // Multi-series scales — cycle the accent palette so adjacent series differ.
    // cScale 0-11 (journey/mindmap/timeline) and pie 1-12 share one cycle;
    // git/fillType/gitBranchLabel are 0-7. Branch labels sit on the (light)
    // branch colour, so their text is dark.
    for (var i = 0; i < 12; i++) {
      var c = palette[i % palette.length]
      tv['cScale' + i] = c
      tv['pie' + (i + 1)] = c
      if (i < 8) {
        tv['fillType' + i] = c
        tv['git' + i] = c
        tv['gitBranchLabel' + i] = bgDark
      }
    }

    return { startOnLoad: false, theme: 'base', themeVariables: tv }
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
    // flipMode — THE mode-flip dispatch (contract: one function, two entry
    // points). Called by onModEnter (caret/selection inside PM, via the
    // interaction-policy extension) and by the render body's DOM keydown
    // listener (focus outside PM in render mode). Both MUST dispatch the
    // identical sieve:block-update.
    flipMode: function (attrs, cursorPos) {
      if (!attrs || !attrs.id) return false
      var newMode = attrs.mode === 'render' ? 'edit' : 'render'
      document.dispatchEvent(new CustomEvent('sieve:block-update', {
        detail: { id: attrs.id, kind: 'diagram', attrs: { mode: newMode, cursorPos: typeof cursorPos === 'number' ? cursorPos : (attrs.cursorPos || 0) } }
      }))
      return true
    },

    // onModEnter — policy-extension entry point (modEnterTogglesMode).
    onModEnter: function (view, selection) {
      var node = selection.node || selection.$from.parent
      if (!node || node.type.name !== 'sieve-diagram') return false
      var cursorPos = selection.node
        ? (typeof node.attrs.cursorPos === 'number' ? node.attrs.cursorPos : 0)
        : selection.$from.parentOffset
      return DiagramRenderer.flipMode(node.attrs, cursorPos)
    },


    headerProvider: new DiagramHeader(),

    // caretStop:'render' — a caret stop only in render mode; edit mode is raw text.
    // Mod+Enter is this kind's declared override: mode toggle, not escape.
    interactionPolicy: { rawText: true, indentWidth: 2, enterInsertsNewline: true, autoIndentOnEnter: true, modEnterTogglesMode: true, caretStop: 'render' },

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
      return  [
        { mimeType: 'text/plain', content: src },
        { mimeType: 'image/svg', content: "<MERMAID RENDERED CONTENT" }
      ]
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

      // Ctrl+Enter / Cmd+Enter in render mode: flip back to edit — via the
      // SAME flipMode dispatch the policy extension uses (contract: one
      // function, two entry points). stopPropagation prevents the event
      // bubbling to TipTap's root listener.
      renderBody.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          DiagramRenderer.flipMode(currentAttrs, currentAttrs.cursorPos)
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
            }
            // Keyboard behaviour (Tab/Enter/Mod+Enter) is owned by the
            // interaction-policy extension via interactionPolicy + onModEnter
            // above — no per-renderer key handling (contract rule).
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
