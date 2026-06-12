// log-renderer.js — Sieve block renderer for the 'log' kind.

import { isJobStale, getLowlight, hastToHtml } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  // Spring Boot log line — compiled once (was recompiled per line in applyHighlight).
  var SPRING_LINE_RE = /^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(\w+)\s+(.*?)\s+---\s+\[(.*?)\]\s+(.*?)\s+:\s+(.*)$/

  var LogRenderer = {
    attrs: {
      source:          { default: '', parseHTML: function (el) { return el.getAttribute('data-source')           || '' } },
      language:        { default: 'log', parseHTML: function (el) { return el.getAttribute('data-language')         || 'log' } },
      detectionMethod: { default: '', parseHTML: function (el) { return el.getAttribute('data-detection-method') || '' } },
      parsedAssetRef:  { default: '', parseHTML: function (el) { return el.getAttribute('data-parsed-asset-ref') || '' } },
      logFormatName:   { default: '', parseHTML: function (el) { return el.getAttribute('data-log-format-name') || '' } },
      logFormatRegex:  { default: '', parseHTML: function (el) { return el.getAttribute('data-log-format-regex') || '' } },
      status:          { default: 'COMPLETE', parseHTML: function (el) { return el.getAttribute('data-status') || 'COMPLETE' } },
    },

    getFriendlyName: function() { return 'Log' },
    getIcon: function() { return window.SieveIcons && window.SieveIcons.terminal },

    asContentEntry: function(node) {
      if (!node.attrs.source) return null
      return  [
        { mimeType: 'text/plain', content: node.attrs.source }
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
      }
    },

    makeNodeView: function (node) {
      var nodeTypeName = node.type.name
      var currentAttrs = Object.assign({}, node.attrs)
      var mode = currentAttrs.parsedAssetRef ? 'explore' : 'edit'
      var loadedJson = null
      var loadingAsset = false       // guards against a double-fetch on first explore render
      var logObserver = null         // per-instance lazy-scroll observer (was a global → clobbered sibling log blocks)

      var dom = document.createElement('div')
      dom.className = 'sieve-block sieve-block--code sieve-block--log'
      dom.setAttribute('data-id', node.attrs.id || '')

      var header = document.createElement('div')
      header.className = 'sieve-block__header'
      
      var title = document.createElement('span')
      title.className = 'sieve-block__badge'
      title.innerText = LogRenderer.getFriendlyName()
      header.appendChild(title)

      var formatBadge = document.createElement('span')
      formatBadge.className = 'sieve-block__badge'
      formatBadge.style.background = 'var(--theme-bg)'
      formatBadge.style.color = 'var(--theme-textSubtle)'
      formatBadge.style.border = '1px solid var(--theme-border)'
      formatBadge.style.fontWeight = 'normal'
      formatBadge.style.marginLeft = '12px'
      
      if (currentAttrs.logFormatName) {
        formatBadge.innerText = 'Format: ' + currentAttrs.logFormatName
        formatBadge.style.display = 'inline-block'
        if (currentAttrs.logFormatRegex) {
          formatBadge.title = 'Regex: ' + currentAttrs.logFormatRegex
        }
      } else {
        formatBadge.style.display = 'none'
      }
      header.appendChild(formatBadge)
      
      var toggle = document.createElement('div')
      toggle.className = 'diagram-block__toggle'
      toggle.style.marginLeft = '8px'

      var rawBtn = document.createElement('button')
      rawBtn.className = 'diagram-block__toggle-btn diagram-block__toggle-btn--active-edit'
      rawBtn.innerHTML = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<path d="M1 7.5 L6 2 L8 4 L3 9 L1 9 Z"/><line x1="5" y1="3" x2="7" y2="5"/></svg> Raw'
      rawBtn.onclick = function(e) { e.preventDefault(); e.stopPropagation(); mode = 'raw'; updateUI(); }

      var exploreBtn = document.createElement('button')
      exploreBtn.className = 'diagram-block__toggle-btn'
      exploreBtn.innerHTML = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<rect x="1" y="1" width="8" height="8" rx="1"/><line x1="1" y1="4" x2="9" y2="4"/><line x1="4" y1="4" x2="4" y2="9"/></svg> Explore'
      exploreBtn.onclick = function(e) { e.preventDefault(); e.stopPropagation(); mode = 'explore'; updateUI(); }

      toggle.appendChild(rawBtn)
      toggle.appendChild(exploreBtn)
      header.appendChild(toggle)

      var noiseBtn = document.createElement('button')
      noiseBtn.className = 'sieve-block__badge sieve-block__badge--clickable'
      noiseBtn.textContent = 'Toggle Noise'
      noiseBtn.style.cursor = 'pointer'
      noiseBtn.style.marginLeft = '8px'
      header.appendChild(noiseBtn)

      var filterInput = document.createElement('input')
      filterInput.type = 'text'
      filterInput.placeholder = 'Filter...'
      filterInput.className = 'sieve-block__badge'
      filterInput.style.marginLeft = 'auto'
      filterInput.style.background = 'transparent'
      filterInput.style.border = '1px solid var(--theme-border)'
      filterInput.style.color = 'var(--theme-text)'
      filterInput.style.outline = 'none'
      filterInput.style.display = 'none'
      header.appendChild(filterInput)

      var colsContainer = document.createElement('div')
      colsContainer.style.display = 'none'
      colsContainer.style.flexDirection = 'row'
      colsContainer.style.alignItems = 'center'
      colsContainer.style.marginLeft = '8px'
      header.appendChild(colsContainer)

      dom.appendChild(header)

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

      var codeArea = document.createElement('div')
      codeArea.className = 'sieve-block__code-area'
      codeArea.style.flex = '1'

      var highlightPre = document.createElement('pre')
      highlightPre.className = 'sieve-block__highlight'
      var highlightCode = document.createElement('code')
      highlightPre.appendChild(highlightCode)

      var editEl = document.createElement('textarea')
      editEl.className = 'sieve-block__edit'
      editEl.spellcheck = false
      editEl.readOnly = true
      editEl.setAttribute('autocorrect', 'off')
      editEl.setAttribute('autocapitalize', 'off')
      editEl.setAttribute('autocomplete', 'off')

      codeArea.appendChild(highlightPre)
      codeArea.appendChild(editEl)
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

      var hideNoise = false
      var hiddenCols = {}
      
      function renderTable() {
          if (!loadedJson || !loadedJson.lines) return;
          tableContainer.innerHTML = '';
          var filterText = filterInput.value.toLowerCase();
          
          var hasDate = loadedJson.lines.some(function(l) { return l.date });
          var hasLevel = loadedJson.lines.some(function(l) { return l.level });
          var hasThread = loadedJson.lines.some(function(l) { return l.thread });
          var hasLogger = loadedJson.lines.some(function(l) { return l.logger });
          
          // Render Column Toggles
          colsContainer.innerHTML = '';
          function makeColToggle(name, key, exists) {
              if (!exists) return;
              var btn = document.createElement('div');
              btn.className = 'sieve-block__badge sieve-block__badge--clickable';
              btn.textContent = name;
              if (!hiddenCols[key]) {
                  btn.classList.add('sieve-block__badge--active');
                  btn.style.opacity = '1';
              } else {
                  btn.style.opacity = '0.4';
              }
              btn.style.cursor = 'pointer';
              btn.style.marginLeft = '4px';
              btn.onclick = function(e) {
                  e.preventDefault(); e.stopPropagation();
                  hiddenCols[key] = !hiddenCols[key];
                  renderTable();
              };
              colsContainer.appendChild(btn);
          }
          makeColToggle('Date', 'date', hasDate);
          makeColToggle('Level', 'level', hasLevel);
          makeColToggle('Thread', 'thread', hasThread);
          makeColToggle('Logger', 'logger', hasLogger);
          
          var showDate = hasDate && !hiddenCols['date'];
          var showLevel = hasLevel && !hiddenCols['level'];
          var showThread = hasThread && !hiddenCols['thread'];
          var showLogger = hasLogger && !hiddenCols['logger'];
          
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
              renderTable();
          }).catch(function(err) {
              loadingAsset = false;
              tableContainer.innerHTML = '<div style="padding: 16px; color: var(--theme-red);">Failed to load parsed logs.</div>';
          });
      }

      function updateUI() {
          if (mode === 'explore') {
              editArea.style.display = 'none';
              exploreArea.style.display = 'flex';
              noiseBtn.style.display = 'none';
              filterInput.style.display = 'inline-block';
              colsContainer.style.display = 'flex';
              
              rawBtn.className = 'diagram-block__toggle-btn';
              rawBtn.style.color = '';
              exploreBtn.className = 'diagram-block__toggle-btn diagram-block__toggle-btn--active-render';
              
              if (!loadedJson) loadAsset();
              else renderTable();
          } else {
              editArea.style.display = 'flex';
              exploreArea.style.display = 'none';
              noiseBtn.style.display = 'inline-block';
              filterInput.style.display = 'none';
              colsContainer.style.display = 'none';
              
              rawBtn.className = 'diagram-block__toggle-btn diagram-block__toggle-btn--active-edit';
              rawBtn.style.color = 'var(--theme-accentPrimary)';
              exploreBtn.className = 'diagram-block__toggle-btn';
          }
      }

      filterInput.addEventListener('input', function(e) {
          e.stopPropagation();
          renderTable();
      });

      noiseBtn.addEventListener('mousedown', function(e) {
          e.preventDefault()
          e.stopPropagation()
          hideNoise = !hideNoise
          noiseBtn.textContent = hideNoise ? 'Show Noise' : 'Toggle Noise'
          if (hideNoise) {
              noiseBtn.classList.add('sieve-block__badge--active')
          } else {
              noiseBtn.classList.remove('sieve-block__badge--active')
          }
          applyHighlight(editEl.value)
      })

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

      function applyHighlight(source) {
        var lines = (source || '').split('\n');
        var htmlLines = lines.map(function(line) {
           var safeLine = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
           
           // Match Spring Boot style log:
           // DATE TIME  LEVEL PID --- [THREAD] LOGGER : MESSAGE
           var springMatch = safeLine.match(SPRING_LINE_RE);
           
           if (springMatch) {
               var date = springMatch[1];
               var level = springMatch[2].toUpperCase();
               var pid = springMatch[3];
               var thread = springMatch[4];
               var logger = springMatch[5];
               var msg = springMatch[6];
               
               var levelColor = 'var(--theme-textSubtle)';
               if (level.match(/ERROR|FATAL/i)) levelColor = 'var(--theme-red)';
               else if (level.match(/WARN/i)) levelColor = 'var(--theme-yellow)';
               else if (level.match(/INFO|DEBUG|TRACE/i)) levelColor = 'var(--theme-accentCyan)';
               
               var noiseStyle = hideNoise ? 'opacity: 0.15;' : 'opacity: 0.5;';
               
               var dateSpan = '<span style="' + noiseStyle + '">' + date + '</span>';
               var levelSpan = '<span style="color: ' + levelColor + '; font-weight: bold;">' + level + '</span>';
               var pidSpan = '<span style="' + noiseStyle + '">' + pid + '</span>';
               var threadSpan = '<span style="color: var(--theme-magenta); ' + noiseStyle + '">[' + thread + ']</span>';
               var loggerSpan = '<span style="color: var(--theme-green); ' + noiseStyle + '">' + logger + '</span>';
               
               var formattedLine = dateSpan + '  ' + levelSpan + ' ' + pidSpan + ' --- ' + threadSpan + ' ' + loggerSpan + ' : ' + msg;
               
               if (hideNoise && level.match(/INFO|DEBUG|TRACE/i)) {
                   return '<span style="opacity: 0.25;">' + formattedLine + '</span>';
               } else if (level.match(/ERROR|FATAL/i)) {
                   return '<span style="color: var(--theme-red); font-weight: bold;">' + formattedLine + '</span>';
               } else if (level.match(/WARN/i)) {
                   return '<span style="color: var(--theme-yellow);">' + formattedLine + '</span>';
               }
               return formattedLine;
           }

           // Fallback for other log styles
           safeLine = safeLine.replace(/\[(.*?)\]/g, function(match, inner) {
             var color = 'var(--theme-textSubtle)';
             if (inner.match(/error|fatal|fail|exception/i)) color = 'var(--theme-red)';
             else if (inner.match(/warn/i)) color = 'var(--theme-yellow)';
             else if (inner.match(/info|debug|trace/i)) color = 'var(--theme-accentCyan)';
             var noiseStyle = hideNoise ? 'opacity: 0.3;' : 'opacity: 0.8;';
             return '<span style="color: ' + color + '; font-weight: 500; ' + noiseStyle + '">[' + inner + ']</span>';
           });

           if (safeLine.match(/\b(ERROR|FATAL|Exception)\b/i)) {
              return '<span style="color: var(--theme-red); font-weight: bold;">' + safeLine + '</span>';
           }
           if (safeLine.match(/\b(WARN|Warning)\b/i)) {
              return '<span style="color: var(--theme-yellow);">' + safeLine + '</span>';
           }
           if (safeLine.match(/\b(INFO|DEBUG|TRACE)\b/i) && hideNoise) {
              return '<span style="opacity: 0.25;">' + safeLine + '</span>';
           }
           
           var dateNoiseStyle = hideNoise ? 'opacity: 0.15;' : 'opacity: 0.5;';
           safeLine = safeLine.replace(/(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/g, '<span style="' + dateNoiseStyle + '">$1</span>');
           
           return safeLine;
        });
        var display = htmlLines.join('\n') + '\n';
        highlightCode.innerHTML = display;
      }

      function render(attrs) {
        var statusChanged = currentAttrs.status !== attrs.status;
        var assetChanged = currentAttrs.parsedAssetRef !== attrs.parsedAssetRef;
        currentAttrs = attrs;
        
        if (currentAttrs.logFormatName) {
            formatBadge.innerText = 'Format: ' + currentAttrs.logFormatName;
            formatBadge.style.display = 'inline-block';
        } else {
            formatBadge.style.display = 'none';
        }
        
        if (currentAttrs.logFormatRegex) {
            formatBadge.title = 'Regex: ' + currentAttrs.logFormatRegex;
        } else {
            formatBadge.title = '';
        }
        
        if (!mode) {
           mode = attrs.parsedAssetRef ? 'explore' : 'edit';
        }
        
        if (statusChanged || assetChanged) {
            loadAsset();
        }
        updateUI();

        if (document.activeElement !== editEl) {
          editEl.value = attrs.source || ''
          applyHighlight(attrs.source || '')
          updateGutter(attrs.source || '')
        }
      }

      render(node.attrs)

      // The log source is a read-only captured input — never edited in-place — so
      // there is NO input/Tab/flush wiring. Highlight + gutter are driven by render()
      // and the noise toggle. (Removing the old editable handlers also kills a
      // spurious re-parse that fired just from focusing+blurring the block.)

      return {
        dom:        dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          render(updatedNode.attrs)
          return true
        },
        selectNode: function () { if (mode === 'edit') editEl.focus() },
        ignoreMutation: function () { return true },
        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },
        destroy: function () {
          if (logObserver) { logObserver.disconnect(); logObserver = null }
        },
      }
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
