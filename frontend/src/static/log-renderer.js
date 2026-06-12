// log-renderer.js — Sieve block renderer for the 'log' kind.

import { isJobStale, getLowlight, hastToHtml } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  var LogRenderer = {
    attrs: {
      source:          { default: '', parseHTML: function (el) { return el.getAttribute('data-source')           || '' } },
      language:        { default: 'log', parseHTML: function (el) { return el.getAttribute('data-language')         || 'log' } },
      detectionMethod: { default: '', parseHTML: function (el) { return el.getAttribute('data-detection-method') || '' } },
    },

    getFriendlyName: function() { return 'Log Explorer' },
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
      }
    },

    makeNodeView: function (node) {
      var nodeTypeName = node.type.name
      var currentAttrs = Object.assign({}, node.attrs)

      var dom = document.createElement('div')
      dom.className = 'sieve-block sieve-block--code sieve-block--log'
      dom.setAttribute('data-id', node.attrs.id || '')

      var header = document.createElement('div')
      header.className = 'sieve-block__header'
      
      var title = document.createElement('span')
      title.className = 'sieve-block__badge'
      title.textContent = 'Log Explorer'
      header.appendChild(title)
      
      var noiseBtn = document.createElement('button')
      noiseBtn.className = 'sieve-block__badge sieve-block__badge--clickable'
      noiseBtn.textContent = 'Toggle Noise'
      noiseBtn.style.cursor = 'pointer'
      noiseBtn.style.marginLeft = '8px'
      header.appendChild(noiseBtn)

      dom.appendChild(header)

      var body = document.createElement('div')
      body.className = 'sieve-block__body'

      var gutter = document.createElement('div')
      gutter.className = 'sieve-block__gutter'

      var codeArea = document.createElement('div')
      codeArea.className = 'sieve-block__code-area'

      var highlightPre = document.createElement('pre')
      highlightPre.className = 'sieve-block__highlight'
      var highlightCode = document.createElement('code')
      highlightPre.appendChild(highlightCode)

      var editEl = document.createElement('textarea')
      editEl.className = 'sieve-block__edit'
      editEl.spellcheck = false
      editEl.setAttribute('autocorrect', 'off')
      editEl.setAttribute('autocapitalize', 'off')
      editEl.setAttribute('autocomplete', 'off')

      codeArea.appendChild(highlightPre)
      codeArea.appendChild(editEl)
      body.appendChild(gutter)
      body.appendChild(codeArea)
      dom.appendChild(body)

      var hideNoise = false
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
           var springMatch = safeLine.match(/^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(\w+)\s+(.*?)\s+---\s+\[(.*?)\]\s+(.*?)\s+:\s+(.*)$/);
           
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
        currentAttrs = attrs
        if (document.activeElement !== editEl) {
          editEl.value = attrs.source || ''
          applyHighlight(attrs.source || '')
          updateGutter(attrs.source || '')
        }
      }

      render(node.attrs)

      var inputTimer    = null
      var highlightTimer = null

      function flushSource() {
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'log', attrs: { source: editEl.value } },
        }))
      }

      editEl.addEventListener('input', function () {
        updateGutter(editEl.value)
        clearTimeout(highlightTimer)
        highlightTimer = setTimeout(function () {
          applyHighlight(editEl.value)
        }, 50)
        clearTimeout(inputTimer)
        inputTimer = setTimeout(flushSource, 200)
      })

      editEl.addEventListener('blur', function () {
        clearTimeout(highlightTimer)
        clearTimeout(inputTimer)
        flushSource()
        applyHighlight(editEl.value)
        updateGutter(editEl.value)
      })

      editEl.addEventListener('paste', function (e) {
        e.stopPropagation()
      })

      editEl.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') {
          e.preventDefault()
          var start = editEl.selectionStart
          var end   = editEl.selectionEnd
          editEl.value = editEl.value.substring(0, start) + '  ' + editEl.value.substring(end)
          editEl.selectionStart = editEl.selectionEnd = start + 2
          updateGutter(editEl.value)
          clearTimeout(highlightTimer)
          highlightTimer = setTimeout(function () { applyHighlight(editEl.value) }, 50)
          clearTimeout(inputTimer)
          inputTimer = setTimeout(flushSource, 200)
          return
        }
        if (e.metaKey || e.ctrlKey) return
        e.stopPropagation()
      })

      return {
        dom:        dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          render(updatedNode.attrs)
          return true
        },
        selectNode: function () { editEl.focus() },
        ignoreMutation: function () { return true },
        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },
        destroy: function () {
          clearTimeout(inputTimer)
          clearTimeout(highlightTimer)
        },
      }
    },
  }

  LogRenderer.buildAiCtx = function (node) {
    return { contextLabel: 'Log block' }
  }

  LogRenderer.buildContextMenuItems = function ({ node }) {
    return [
      { type: 'header', label: 'Log Explorer' },
    ]
  }

  T.registerSieveRenderer('log', LogRenderer)

})()
