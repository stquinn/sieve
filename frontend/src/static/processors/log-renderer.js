// log-renderer.js — Sieve block renderer for the 'log' kind.

import { esc, isJobStale, getLowlight, hastToHtml } from '../base/fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  // Spring Boot log line — compiled once (was recompiled per line in applyHighlight).
  var SPRING_LINE_RE = /^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(\w+)\s+(.*?)\s+---\s+\[(.*?)\]\s+(.*?)\s+:\s+(.*)$/

  // ── Header (toolbar) ──────────────────────────────────────────────────────────
  // The richest toolbar: badge + format + raw/explore toggle + (noise | filter +
  // column toggles), all mode-dependent. State is persisted attrs (mode/filter/
  // disabledCols/hideNoise), written via ctx.updateAttribute. WHICH column buttons
  // exist is data-driven — the body sets ctx.state.cols (+ ctx.refreshHeader) once
  // the parsed JSON loads; disabledCols is the pocketed on/off state.
  var RAW_SVG = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
    '<path d="M1 7.5 L6 2 L8 4 L3 9 L1 9 Z"/><line x1="5" y1="3" x2="7" y2="5"/></svg>'
  var EXPLORE_SVG = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
    '<rect x="1" y="1" width="8" height="8" rx="1"/><line x1="1" y1="4" x2="9" y2="4"/><line x1="4" y1="4" x2="4" y2="9"/></svg>'

  function logMode(attrs)  { return attrs.mode || (attrs.parsedAssetRef ? 'explore' : 'edit') }
  function isExplore(attrs) { return logMode(attrs) === 'explore' }
  function disabledSet(attrs) {
    var s = {}
    ;(attrs.disabledCols || '').split(',').forEach(function (k) { if (k) s[k] = true })
    return s
  }
  function toggleDisabled(attrs, key) {
    var s = disabledSet(attrs)
    if (s[key]) delete s[key]; else s[key] = true
    return Object.keys(s).join(',')
  }

  class LogHeader extends T.AdvancedHeaderProvider {
    badge() { return 'Log' }

    left(attrs, ctx) {
      var items = []
      if (attrs.logFormatName) {
        var fb = T.badgeEl('Format: ' + attrs.logFormatName)
        fb.style.background = 'var(--theme-bg)'
        fb.style.color = 'var(--theme-textSubtle)'
        fb.style.border = '1px solid var(--theme-border)'
        fb.style.fontWeight = 'normal'
        fb.style.marginLeft = '12px'
        if (attrs.logFormatRegex) fb.title = 'Regex: ' + attrs.logFormatRegex
        items.push(fb)
      }
      var explore = isExplore(attrs)
      var toggle = document.createElement('div')
      toggle.className = 'diagram-block__toggle'
      toggle.style.marginLeft = '8px'
      var rawBtn = document.createElement('button')
      rawBtn.className = 'diagram-block__toggle-btn' + (!explore ? ' diagram-block__toggle-btn--active-edit' : '')
      rawBtn.innerHTML = RAW_SVG + ' Raw'
      rawBtn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); if (explore) ctx.updateAttribute({ mode: 'raw' }) })
      var exploreBtn = document.createElement('button')
      exploreBtn.className = 'diagram-block__toggle-btn' + (explore ? ' diagram-block__toggle-btn--active-render' : '')
      exploreBtn.innerHTML = EXPLORE_SVG + ' Explore'
      exploreBtn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); if (!explore) ctx.updateAttribute({ mode: 'explore' }) })
      toggle.appendChild(rawBtn); toggle.appendChild(exploreBtn)
      items.push(toggle)
      if (!explore) {
        var noiseBtn = document.createElement('button')
        noiseBtn.className = 'sieve-block__badge sieve-block__badge--clickable' + (attrs.hideNoise ? ' sieve-block__badge--active' : '')
        noiseBtn.textContent = attrs.hideNoise ? 'Show Noise' : 'Toggle Noise'
        noiseBtn.style.cursor = 'pointer'
        noiseBtn.style.marginLeft = '8px'
        noiseBtn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); ctx.updateAttribute({ hideNoise: !attrs.hideNoise }) })
        items.push(noiseBtn)
      }
      return items
    }

    right(attrs, ctx) {
      if (!isExplore(attrs)) return []
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
      filter.addEventListener('input', function (e) { e.stopPropagation(); ctx.updateAttribute({ filter: filter.value }) })
      items.push(filter)

      var cols = ctx.state.cols || []
      if (cols.length) {
        var disabled = disabledSet(attrs)
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
          btn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); ctx.updateAttribute({ disabledCols: toggleDisabled(attrs, col.key) }) })
          wrap.appendChild(btn)
        })
        items.push(wrap)
      }
      return items
    }
  }

  var LogRenderer = {
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
      // ctx.updateAttribute, so a configured log comes back configured.
      mode:            { default: '', parseHTML: function (el) { return el.getAttribute('data-mode') || '' } },
      filter:          { default: '', parseHTML: function (el) { return el.getAttribute('data-filter') || '' } },
      disabledCols:    { default: '', parseHTML: function (el) { return el.getAttribute('data-disabled-cols') || '' } },
      hideNoise:       { default: false, parseHTML: function (el) { return el.getAttribute('data-hide-noise') === 'true' } },
    },

    // Read-only text: caret may enter (select/copy), typing is consumed.
    // Mod+Enter toggles raw↔explore (declared policy override, same
    // mechanism as diagram's edit↔render — see interaction-policy.js).
    interactionPolicy: { readOnlyText: true, modEnterTogglesMode: true },

    // onModEnter — policy-extension entry point: flip raw↔explore.
    onModEnter: function (view, selection) {
      var node = selection.node || selection.$from.parent
      if (!node || node.type.name !== 'sieve-log' || !node.attrs.id) return false
      var newMode = logMode(node.attrs) === 'explore' ? 'raw' : 'explore'
      document.dispatchEvent(new CustomEvent('sieve:block-update', {
        detail: { id: node.attrs.id, kind: 'log', attrs: { mode: newMode } }
      }))
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

    makeNodeView: function (node, editor, getPos, ctx) {
      var nodeTypeName = node.type.name
      var currentAttrs = Object.assign({}, node.attrs)
      var loadedJson = null
      var loadingAsset = false       // guards against a double-fetch on first explore render
      var logObserver = null         // per-instance lazy-scroll observer (was a global → clobbered sibling log blocks)

      var dom = document.createElement('div')
      dom.className = 'sieve-block sieve-block--code sieve-block--log'
      dom.setAttribute('data-id', node.attrs.id || '')

      // Header (badge + format + raw/explore toggle + noise|filter+cols) is declared
      // as `headerProvider: new LogHeader()` and rendered by the framework seam. The
      // view settings (mode/filter/disabledCols/hideNoise) are persisted attrs the
      // header writes via ctx.updateAttribute; this NodeView only reads them.

      var body = document.createElement('div')
      body.className = 'sieve-block__body'

      var editArea = document.createElement('div')
      editArea.style.display = 'flex'
      editArea.style.flexDirection = 'row'
      editArea.style.width = '100%'
      editArea.style.maxHeight = '600px'
      editArea.style.overflowY = 'auto'
      // Let the gutter + code grid grow to their natural (full) height and have
      // THIS wrapper scroll. Without this, flex's default align-items:stretch pins
      // the grid to the 600px container height and the highlight/textarea
      // (overflow:hidden) clip everything past ~28 lines with nothing to scroll.
      editArea.style.alignItems = 'flex-start'

      var gutter = document.createElement('div')
      gutter.className = 'sieve-block__gutter'
      gutter.contentEditable = 'false'

      var codeArea = document.createElement('div')
      codeArea.className = 'sieve-block__code-area'
      codeArea.style.flex = '1'

      // Real PM-owned contentDOM holding the raw log text — read-only via the plugin.
      // Highlighting is applied as decorations (buildPlugins), not innerHTML overlay.
      var pre = document.createElement('pre')
      pre.className = 'sieve-block__edit'
      pre.style.whiteSpace = 'pre-wrap'
      pre.style.pointerEvents = 'auto'
      pre.style.outline = 'none'
      pre.style.color = 'var(--theme-text)'

      var contentDOM = document.createElement('code')
      contentDOM.className = 'hljs language-log'

      pre.appendChild(contentDOM)
      codeArea.appendChild(pre)
      editArea.appendChild(gutter)
      editArea.appendChild(codeArea)

      var exploreArea = document.createElement('div')
      exploreArea.style.display = 'none'
      exploreArea.style.flexDirection = 'row'
      exploreArea.style.width = '100%'
      
      var tableContainer = document.createElement('div')
      tableContainer.style.flex = '1'
      tableContainer.style.overflow = 'auto'
      tableContainer.style.maxHeight = '600px'
      tableContainer.style.padding = '12px 16px'
      tableContainer.style.fontFamily = 'monospace'
      tableContainer.style.fontSize = '13px'
      tableContainer.style.lineHeight = '1.5'
      tableContainer.style.userSelect = 'text'
      tableContainer.style.webkitUserSelect = 'text'
      tableContainer.style.cursor = 'text'
      
      // Stop Prosemirror from hijacking native text selection
      exploreArea.addEventListener('mousedown', function(e) {
          e.stopPropagation()
      })
      exploreArea.addEventListener('dragstart', function(e) {
          e.preventDefault()
          e.stopPropagation()
      })

      exploreArea.appendChild(tableContainer)

      body.appendChild(editArea)
      body.appendChild(exploreArea)
      dom.appendChild(body)

      // availableCols scans the loaded JSON for which columns exist, and publishes
      // them to the header (ctx.state.cols) so LogHeader can render their toggles.
      // The enabled/disabled state is the pocketed disabledCols attr.
      function availableCols() {
          if (!loadedJson || !loadedJson.lines) return [];
          var out = [];
          if (loadedJson.lines.some(function(l){ return l.date }))   out.push({ key: 'date',   name: 'Date' });
          if (loadedJson.lines.some(function(l){ return l.level }))  out.push({ key: 'level',  name: 'Level' });
          if (loadedJson.lines.some(function(l){ return l.thread })) out.push({ key: 'thread', name: 'Thread' });
          if (loadedJson.lines.some(function(l){ return l.logger })) out.push({ key: 'logger', name: 'Logger' });
          return out;
      }

      function renderTable() {
          if (!loadedJson || !loadedJson.lines) return;
          tableContainer.innerHTML = '';
          var filterText = (currentAttrs.filter || '').toLowerCase();
          var disabled = disabledSet(currentAttrs);

          var hasDate = loadedJson.lines.some(function(l) { return l.date });
          var hasLevel = loadedJson.lines.some(function(l) { return l.level });
          var hasThread = loadedJson.lines.some(function(l) { return l.thread });
          var hasLogger = loadedJson.lines.some(function(l) { return l.logger });

          var showDate = hasDate && !disabled['date'];
          var showLevel = hasLevel && !disabled['level'];
          var showThread = hasThread && !disabled['thread'];
          var showLogger = hasLogger && !disabled['logger'];

          if (logObserver) {
              logObserver.disconnect();
              logObserver = null;
          }

          var cols = [{key: 'line', width: '40px'}];
          if (showDate) cols.push({key: 'date', width: '160px'});
          if (showLevel) cols.push({key: 'level', width: '60px'});
          if (showThread) cols.push({key: 'thread', width: '120px'});
          if (showLogger) cols.push({key: 'logger', width: '200px'});
          cols.push({key: 'message', width: '1fr'});
          
          function makeCell(text, width, color, opacity) {
              var c = document.createElement('div');
              c.textContent = text || '';
              c.style.overflow = 'hidden';
              c.style.textOverflow = 'ellipsis';
              c.style.whiteSpace = 'nowrap';
              if (color) c.style.color = color;
              if (opacity !== undefined) c.style.opacity = opacity;
              if (width === '1fr') {
                  c.style.flex = '1';
              } else {
                  c.style.width = width;
                  c.style.flexShrink = '0';
              }
              return c;
          }
          
          var headerRow = document.createElement('div');
          headerRow.style.display = 'flex';
          headerRow.style.gap = '12px';
          headerRow.style.position = 'sticky';
          headerRow.style.top = '0';
          headerRow.style.background = 'var(--theme-bgDark)';
          headerRow.style.zIndex = '10';
          headerRow.style.paddingBottom = '4px';
          headerRow.style.marginBottom = '4px';
          headerRow.style.borderBottom = '1px solid var(--theme-border)';
          headerRow.style.textTransform = 'uppercase';
          headerRow.style.fontSize = '11px';
          headerRow.style.letterSpacing = '0.5px';
          headerRow.style.fontWeight = 'bold';
          headerRow.style.color = 'var(--theme-textSubtle)';
          
          cols.forEach(function(col) {
             var label = col.key === 'line' ? '#' : col.key;
             headerRow.appendChild(makeCell(label, col.width));
          });
          
          tableContainer.appendChild(headerRow);
          
          var rowsContainer = document.createElement('div');
          rowsContainer.style.display = 'flex';
          rowsContainer.style.flexDirection = 'column';
          tableContainer.appendChild(rowsContainer);
          
          var filteredLines = loadedJson.lines.filter(function(l) {
             if (!filterText) return true;
             return (l.raw || '').toLowerCase().indexOf(filterText) > -1;
          });
          
          var currentIndex = 0;
          var chunkSize = 100;
          
          function renderChunk() {
              var chunk = filteredLines.slice(currentIndex, currentIndex + chunkSize);
              if (chunk.length === 0) return false;
              
              chunk.forEach(function(l) {
                  var row = document.createElement('div');
                  row.style.display = 'flex';
                  row.style.gap = '12px';
                  row.style.marginBottom = '4px';
                  
                  var rowColor = '';
                  if (l.severity === 'error') rowColor = 'var(--theme-red)';
                  else if (l.severity === 'warn') rowColor = 'var(--theme-yellow)';
                  else if (l.severity === 'info') rowColor = 'var(--theme-textSubtle)';
                  
                  cols.forEach(function(col) {
                      var cell;
                      if (col.key === 'line') cell = makeCell(l.lineNumber, col.width, 'var(--theme-textSubtle)', 0.5);
                      else if (col.key === 'date') cell = makeCell(l.date, col.width, 'var(--theme-textSubtle)', 0.5);
                      else if (col.key === 'level') {
                          cell = makeCell(l.level, col.width, rowColor, 1);
                          cell.style.fontWeight = 'bold';
                      }
                      else if (col.key === 'thread') cell = makeCell(l.thread, col.width, 'var(--theme-magenta)', 0.7);
                      else if (col.key === 'logger') cell = makeCell(l.logger, col.width, 'var(--theme-green)', 0.7);
                      else if (col.key === 'message') {
                          cell = makeCell(l.message, col.width, rowColor || 'var(--theme-text)', l.severity === 'info' ? 0.8 : 1);
                          cell.style.whiteSpace = 'pre-wrap';
                      }
                      row.appendChild(cell);
                  });
                  rowsContainer.appendChild(row);
              });
              
              currentIndex += chunkSize;
              return currentIndex < filteredLines.length;
          }
          
          var hasMore = renderChunk();
          
          if (hasMore) {
              var sentinel = document.createElement('div');
              sentinel.style.height = '1px';
              tableContainer.appendChild(sentinel);
              
              var observer = new IntersectionObserver(function(entries) {
                  if (entries[0].isIntersecting) {
                      var more = renderChunk();
                      if (!more) {
                          observer.disconnect();
                          if (sentinel.parentNode) sentinel.parentNode.removeChild(sentinel);
                      }
                  }
              }, { root: tableContainer, rootMargin: '200px' });
              
              observer.observe(sentinel);
              logObserver = observer;
          }
          
      }
      
      function loadAsset() {
          if (!currentAttrs.parsedAssetRef || loadingAsset) return;
          if (currentAttrs.status === 'PENDING' || currentAttrs.status === 'DISPATCHED') {
              tableContainer.innerHTML = '<div style="padding: 16px; color: var(--theme-textSubtle);">Processing logs...</div>';
              return;
          }
          var url = currentAttrs.parsedAssetRef;
          if (!url.startsWith('/')) {
              url = '/sieve/' + (window.__stashActiveTabUuid || '') + '/' + url.split('/').pop();
          }
          loadingAsset = true;
          fetch(url).then(function(res) { return res.json(); }).then(function(data) {
              loadingAsset = false;
              loadedJson = data;
              // Publish which columns the data has so LogHeader can render their
              // toggles; their disabled state is the pocketed disabledCols attr.
              if (ctx) { ctx.state.cols = availableCols(); ctx.refreshHeader(); }
              renderTable();
          }).catch(function(err) {
              loadingAsset = false;
              tableContainer.innerHTML = '<div style="padding: 16px; color: var(--theme-red);">Failed to load parsed logs.</div>';
          });
      }

      // updateUI switches ONLY the body (raw/edit text vs explore table). Toolbar
      // state (toggle active, noise/filter/cols visibility) is the header's job now,
      // driven by the persisted attrs.
      function updateUI() {
          if (isExplore(currentAttrs)) {
              editArea.style.display = 'none';
              exploreArea.style.display = 'flex';
              if (!loadedJson) loadAsset();
              else renderTable();
          } else {
              editArea.style.display = 'flex';
              exploreArea.style.display = 'none';
          }
      }

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

      function render(attrs, textContent) {
        var statusChanged = currentAttrs.status !== attrs.status;
        var assetChanged = currentAttrs.parsedAssetRef !== attrs.parsedAssetRef;
        currentAttrs = attrs;

        // Noise dimming is a persisted view setting (hideNoise attr); CSS dims
        // .log-tok-noise / .log-line-info under .log--hide-noise. (Format badge,
        // mode toggle, filter and column toggles are all the header's job now.)
        dom.classList.toggle('log--hide-noise', !!attrs.hideNoise);

        if (statusChanged || assetChanged) {
            loadAsset();
        }
        updateUI();

        updateGutter(textContent || '')
      }

      render(node.attrs, node.textContent)

      // The log source is a read-only captured input — never edited in-place. The
      // text lives in the PM document (text* content); highlighting is applied as
      // decorations, the gutter is driven by render(), and editing is blocked by the
      // read-only plugin in buildPlugins.

      return {
        dom:        dom,
        contentDOM: contentDOM,
        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          render(updatedNode.attrs, updatedNode.textContent)
          return true
        },
        ignoreMutation: function (mutation) {
          return !contentDOM.contains(mutation.target)
        },
        destroy: function () {
          if (logObserver) { logObserver.disconnect(); logObserver = null }
        },
      }
    },

    // ── Plugins ───────────────────────────────────────────────────────────────

    buildPlugins: function(nodeType) {
      var Plugin = window.TipTap.Plugin
      var Decoration = window.TipTap.Decoration
      var DecorationSet = window.TipTap.DecorationSet

      function isInside(state, from, to) {
        var inside = false
        state.doc.nodesBetween(from, to, function(node) {
          if (node.type === nodeType) inside = true
        })
        return inside
      }

      // ── Log syntax highlighting via decorations ───────────────────────────────
      // Semantic classes only — colours and noise-dimming live in CSS so the
      // noise toggle is a pure view concern (a class on the block root).
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
            handleKeyDown: function(view, event) {
              if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter') {
                return isInside(view.state, view.state.selection.from, view.state.selection.to)
              }
              if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
                return isInside(view.state, view.state.selection.from, view.state.selection.to)
              }
              return false
            },
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

  LogRenderer.buildAiCtx = function (node) {
    return { contextLabel: 'Log block' }
  }

  LogRenderer.buildContextMenuItems = function ({ node }) {
    return [
      { type: 'header', label: 'Log' },
    ]
  }

  T.registerSieveRenderer('log', LogRenderer)

})()
