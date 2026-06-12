// editor.js — vanilla JS TipTap island. Loaded once; re-initialized per tab switch.
// Depends on window.TipTap (ui/static/vendor/tiptap.js).

(function () {
  'use strict'

  var currentEditor = null
  var currentUuid = ''
  var currentMountEl = null
  var currentMode = 'wysiwyg'
  var tabModes = {}
  var lastSyncedBody = ''
  var editorWs = null
  var editorWsPending = []
  var editorWsAwaiters = {}   // type → { resolve, reject }
  var docUpdateTimer = null
  var aiReloadInProgress = false
  var currentMarkdownTextarea = null
  var showAiBlocks = true
  var blobInterceptorCleanup = null
  var searchOverlay = null
  // Where the next inserted Sieve block goes. A number = insert at that point
  // (additive). A {from,to} object = replace that range (in-place conversion of a
  // native code block). Every block-creating operation sets this fresh, so a stale
  // value can never leak into a later insert.
  var sieveInsertPos = null


  var askDialog = null
  var internalizeDialog = null
  var richLinkDialog = null

  // ── Toolbar active-state sync ─────────────────────────────────────────────────

  function syncToolbar(editor) {
    var toolbar = document.getElementById('editor-toolbar')
    if (!toolbar || toolbar.style.display === 'none') return
    var map = {
      bold:        ['bold'],
      italic:      ['italic'],
      strike:      ['strike'],
      code:        ['code'],
      h1:          ['heading', { level: 1 }],
      h2:          ['heading', { level: 2 }],
      h3:          ['heading', { level: 3 }],
      bulletList:  ['bulletList'],
      orderedList: ['orderedList'],
      taskList:    ['taskList'],
      blockquote:  ['blockquote'],
    }
    toolbar.querySelectorAll('[data-cmd]').forEach(function(btn) {
      var args = map[btn.dataset.cmd]
      if (args) btn.classList.toggle('active', editor.isActive.apply(editor, args))
    })
    // Show the table toolbar when cursor is inside a table; update the CSS variable
    // so the fixed-position gutter separator adjusts its top offset accordingly.
    var tableToolbar = document.getElementById('table-toolbar')
    if (tableToolbar) {
      var inTable = editor.isActive('table')
      tableToolbar.style.display = inTable ? 'flex' : 'none'
      var appRoot = document.getElementById('app-root')
      if (appRoot) appRoot.style.setProperty('--table-toolbar-h', inTable ? '32px' : '0px')
    }
  }

  // ── Public entry point called from App.tsx htmx:afterSettle ─────────────────

  function initEditor(mountEl, uuid, mode) {
    if (currentEditor) {
      flushSave()
      currentEditor.destroy()
      currentEditor = null
      window.__tiptap = null
      if (currentUuid && !currentUuid.startsWith('prompt:')) closeEditorWs()
    }

    if (!mountEl || !uuid) {
      currentUuid = ''
      currentMode = 'wysiwyg'
      return
    }

    currentUuid = uuid
    if (!uuid.startsWith('prompt:')) openEditorWs(uuid)
    currentMountEl = mountEl
    currentMode = mode || tabModes[uuid] || 'wysiwyg'

    fetch('/api/editor/load?uuid=' + encodeURIComponent(uuid))
      .then(function (r) { return r.json() })
      .then(function (data) {
        window.SieveAI && window.SieveAI.loadActiveJobs()
        window.__stashActiveTabUuid = uuid
        lastSyncedBody = data.body || ''

        var isMarkdown = currentMode === 'markdown' || data.mode === 'markdown' || uuid.startsWith('prompt:')
        ensureOverlays()

        if (isMarkdown) {
          currentMode = 'markdown'
          mountMarkdown(mountEl, uuid, data.body || '')
        } else {
          currentMode = 'wysiwyg'
          mountWysiwyg(mountEl, uuid, data.body || '')
        }
        tabModes[uuid] = currentMode
        dispatchStats()
      })
      .catch(function (err) { console.error('[editor] load failed', err) })
  }

  // Listen for external changes (e.g. revert prompt or background edits)
  document.addEventListener('prompts:changed', function() {
    if (currentUuid && currentUuid.startsWith('prompt:')) {
      initEditor(currentMountEl, currentUuid, currentMode)
    }
  })

  document.addEventListener('notes:changed', function() {
    // If we're editing a prompt, notes:changed might also mean the prompt was reverted
    // (since the backend emits both). For regular notes, we usually don't want to 
    // force-reload while the user is typing, but for prompts it's safer.
    if (currentUuid && currentUuid.startsWith('prompt:')) {
      initEditor(currentMountEl, currentUuid, currentMode);
    }
  });

  // ── WYSIWYG mode ─────────────────────────────────────────────────────────────

  function mountWysiwyg(el, uuid, body) {
    var T = window.TipTap
    var initialized = false

    var editor = new T.Editor({
      element: el,
      extensions: [
        T.StarterKit.configure({ link: false, codeBlock: false, history: { depth: 10000, newGroupDelay: 500 } }),
        T.Placeholder.configure({ placeholder: function (p) { return p.editor.isEmpty ? 'Start writing\u2026' : '' } }),
        T.BlockNode,
        T.BlockChrome,
        T.AiTargetDecoration,
        T.Table.configure({ resizable: false }),
        T.TableRow,
        T.TableHeader,
        T.TableCell,
        T.Search,

        T.AiBlockLegacy,
        T.Image.configure({ inline: false, allowBase64: true, HTMLAttributes: { class: 'editor-image' } }),
        T.HighlightMark,
        T.SelectionHighlight,
      ].concat(window.SieveNativeCodeBlock ? [window.SieveNativeCodeBlock] : []).concat(T.getSieveNodes()).concat([
        T.TaskList,
        T.TaskItem.configure({ nested: true }),
        T.Markdown.configure({ html: true, transformPastedText: true, link: { openOnClick: false } }),
        T.AiShortcuts.configure({
          // Fire the same events as every other surface so the editor.js handler
          // runs identical business logic (target highlight + focus + run).
          onExplain: function () { document.dispatchEvent(new CustomEvent('sieve:ai-explain')) },
          onAsk: function () { document.dispatchEvent(new CustomEvent('sieve:ai-ask')) },
          onSmartFile: function () { window.SieveAI && window.SieveAI.smartFile(uuid) },
          onKeepAndSmartFile: function () { window.SieveAI && window.SieveAI.keepAndSmartFile(uuid) },
          onToggleAiBlocks: toggleAiBlocks,
        }),
      ]),
      content: body,
      editorProps: {
        attributes: { spellcheck: 'true' },
        handleDOMEvents: {
          copy: function(view, event) {
            var sel = view.state.selection
            // Authoritative selection range: our own block range (shift-click /
            // gutter drag) when set, else the live PM selection.  { from, to,
            // active, isBlockRange }.
            var er = (window.TipTap && window.TipTap.getBlockSelectionRange)
              ? window.TipTap.getBlockSelectionRange(view)
              : { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false }

            // ── Smart image copy ────────────────────────────────────────────────
            // Only for a lone image NodeSelection — never when a multi-block range
            // is active (then the image is just one item in the slice).
            if (!er.isBlockRange && sel && sel.node && sel.node.type.name === 'sieve-smart-image') {
              var src = sel.node.attrs.src
              if (!src) return false
              if (src.startsWith('http://') || src.startsWith('https://')) {
                src = window.location.origin + '/sieve-image-proxy?url=' + encodeURIComponent(src)
              } else if (!src.startsWith('data:') && !src.startsWith('blob:') && !src.startsWith('/')) {
                if (src.startsWith('.assets/')) src = src.substring(8)
                src = '/sieve/' + (window.__stashActiveTabUuid || uuid) + '/' + src.split('/').pop()
              }
              event.preventDefault()
              if (window._sieveCopyImageToClipboard) window._sieveCopyImageToClipboard(src)
              return true
            }

            // ── Sieve block copy ────────────────────────────────────────────────
            // If a textarea/input has a text selection, let the browser copy it
            // natively — the user is copying code/source text from within a block.
            var activeEl = document.activeElement
            if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
              if (activeEl.selectionStart !== activeEl.selectionEnd) return false
            }

            // Sub-block highlight: if the user highlighted text *within a single
            // block* (a rendered card's content), copy exactly that — not the whole
            // block.  (Textarea/input selections are handled by the guard above.)
            var domSel = window.getSelection && window.getSelection()
            if (domSel && !domSel.isCollapsed && String(domSel).trim()) {
              var blkOf = function (n) {
                var el = n && (n.nodeType === 1 ? n : n.parentElement)
                while (el && el !== view.dom) {
                  if (el.classList && el.classList.contains('block-with-chrome')) return el
                  el = el.parentElement
                }
                return null
              }
              var ab = blkOf(domSel.anchorNode)
              if (ab && ab === blkOf(domSel.focusNode)) return false   // native sub-text copy
            }

            // Per-block readable text / html (one consistent rule; chrome stripped).
            // text/plain priority: source (code/diagram) → response (AI) → DOM text → YAML.
            var blockText = function (node, dom) {
              if (node.attrs.source) return node.attrs.source
              if (node.attrs.response) return node.attrs.response
              if (dom) {
                var parts = []
                Array.prototype.forEach.call(dom.children, function (c) {
                  if (c.classList && c.classList.contains('block-chrome-host')) return
                  parts.push(c.innerText)
                })
                var t = parts.join('').trim()
                if (t) return t
              }
              return node.attrs.serialisedForm || ''
            }
            var blockHTML = function (dom) {
              if (!dom) return ''
              var clone = dom.cloneNode(true)
              var ch = clone.querySelector('.block-chrome-host')
              if (ch) ch.remove()
              return clone.outerHTML
            }

            // Collect top-level nodes overlapping the effective range (prose + sieve).
            // The range comes from our plugin-state block selection (shift-click /
            // gutter drag) or the live PM selection — either way it is a clean,
            // non-snapped span, so this collection reliably includes sieve atoms.
            var sliceItems = []
            var plainParts = []
            var htmlParts = []
            var hasSieve = false
            var singleSieveKind = null
            var singleSieveForm = ''

            view.state.doc.forEach(function (node, offset) {
              var nodeEnd = offset + node.nodeSize
              // Active range: include nodes that overlap it.
              if (er.active && (nodeEnd <= er.from || offset >= er.to)) return
              // Empty cursor: only include a sieve node the cursor sits within.
              if (!er.active && (er.from < offset || er.from >= nodeEnd)) return

              var dom = view.nodeDOM(offset)
              if (node.type.name.startsWith('sieve-')) {
                hasSieve = true
                singleSieveKind = node.attrs.kind
                singleSieveForm = node.attrs.serialisedForm || ''
                var attrs = {}
                for (var k in node.attrs) {
                  if (Object.prototype.hasOwnProperty.call(node.attrs, k)) attrs[k] = node.attrs[k]
                }
                sliceItems.push({ _type: 'sieve', kind: node.attrs.kind, attrs: attrs })
                plainParts.push(blockText(node, dom))
                htmlParts.push(blockHTML(dom))
              } else if (!sel.empty) {
                sliceItems.push({ _type: 'prose', json: node.toJSON() })
                plainParts.push(dom ? dom.innerText : '')
                htmlParts.push(blockHTML(dom))
              }
            })

            if (!hasSieve) return false   // pure prose — let TipTap/markdown handle it natively

            // Emit all four flavours.  sieve/slice (+ sieve/<kind> for a lone block)
            // are authoritative for in-app reconstruct and the Go paste handlers
            // (fresh IDs, smart-paste routing); text/plain + text/html are lossy
            // external fallbacks.
            event.preventDefault()
            event.clipboardData.setData('sieve/slice', JSON.stringify(sliceItems))
            event.clipboardData.setData('text/plain', plainParts.filter(Boolean).join('\n\n'))
            event.clipboardData.setData('text/html', htmlParts.filter(Boolean).join('\n'))
            if (sliceItems.length === 1 && sliceItems[0]._type === 'sieve') {
              event.clipboardData.setData('sieve/' + singleSieveKind, singleSieveForm)
            }
            return true
          },
          click: function (view, event) {
            if (!window.isMod(event)) return false
            var pos = view.posAtCoords({ left: event.clientX, top: event.clientY })
            if (pos) {
              var marks = view.state.doc.resolve(pos.pos).marks()
              for (var i = 0; i < marks.length; i++) {
                if (marks[i].type.name === 'link') {
                  var href = marks[i].attrs.href
                  setTimeout(function () { window.runtime && window.runtime.BrowserOpenURL(href) }, 50)
                  event.preventDefault()
                  return true
                }
              }
            }
            return false
          },
        },
        handlePaste: function (_view, event) { return handleSmartPaste(event) },
        handleDrop: function (_view, event, slice, moved) { return handleSmartDrop(event) },
        handleKeyDown: function (view, event) {
          if (event.key === 's' && window.isMod(event)) {
            event.preventDefault()
            flushSave()
            return true
          }
          if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (currentEditor && currentEditor.isActive('listItem')) return false
            if (event.shiftKey) return false
            event.preventDefault()
            view.dispatch(view.state.tr.insertText('    '))
            return true
          }
          if (event.key === 'W' && window.isMod(event) && event.shiftKey) {
            event.preventDefault()
            ensureOverlays()
            openInternalizeDialog()
            return true
          }
          if (event.key === 'L' && window.isMod(event) && event.shiftKey) {
            event.preventDefault()
            ensureOverlays()
            openSmartCardDialog()
            return true
          }
          return false
        },
      },
      onCreate: function () {
        initialized = true
      },
      onSelectionUpdate: function (p) {
        syncToolbar(p.editor)
        if (typeof updateAskPanelLabelLive === 'function') {
          updateAskPanelLabelLive(p.editor)
        }
      },
      onTransaction: function (p) {
        syncToolbar(p.editor)
      },
      onUpdate: function (p) {
        if (!initialized) return
        var md = p.editor.storage.markdown.getMarkdown() || ''
        if (md === lastSyncedBody) return
        lastSyncedBody = md
        document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
        document.dispatchEvent(new CustomEvent('editor:changed'))
        dispatchStats()
        if (docUpdateTimer) clearTimeout(docUpdateTimer)
        docUpdateTimer = setTimeout(function () {
          docUpdateTimer = null
          wsSend({ type: 'doc-update', uuid: uuid, markdown: md })
        }, 500)
      },
    })

    currentEditor = editor
    window.__tiptap = editor

    // Catch focus events on inner form controls (like Sieve Code block textareas)
    // where ProseMirror's native onSelectionUpdate won't fire.
    editor.view.dom.addEventListener('focusin', function() {
      if (typeof updateAskPanelLabelLive === 'function') {
        updateAskPanelLabelLive(editor)
      }
    })
  }

  // ── Markdown mode ─────────────────────────────────────────────────────────────

  function mountMarkdown(mountEl, uuid, body) {
    currentMode = 'markdown'
    currentMarkdownTextarea = null

    var wrapper = document.createElement('div')
    wrapper.style.cssText = 'display:flex;flex-direction:row;height:100%;overflow:hidden;background:var(--theme-bg);position:relative'

    var gutter = document.createElement('div')
    gutter.className = 'markdown-gutter'
    gutter.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0;padding:40px 0.6rem 0.85em;background-color:var(--theme-bgDark);border-right:1px solid var(--theme-border);color:var(--theme-muted);font-family:var(--theme-monoFont);font-size:14px;line-height:1.75;overflow:hidden'

    var textarea = document.createElement('textarea')
    currentMarkdownTextarea = textarea
    textarea.className = 'markdown-editor markdown-raw'
    textarea.spellcheck = true
    textarea.placeholder = 'Raw markdown \u2014 Mod+Shift+M to return'
    textarea.setAttribute('autocomplete', 'off')
    textarea.setAttribute('autocorrect', 'off')
    textarea.style.cssText = 'flex:1;padding-top:40px;padding-left:1rem;padding-right:1rem;padding-bottom:1rem'
    textarea.value = body

    updateGutter(gutter, body)

    textarea.addEventListener('input', function () {
      var val = textarea.value
      if (val === lastSyncedBody) return
      lastSyncedBody = val
      document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
      document.dispatchEvent(new CustomEvent('editor:changed'))
      updateGutter(gutter, val)
      dispatchStats()
      if (docUpdateTimer) clearTimeout(docUpdateTimer)
      docUpdateTimer = setTimeout(function () {
        docUpdateTimer = null
        wsSend({ type: 'doc-update', uuid: uuid, markdown: val })
      }, 500)
    })
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 's' && window.isMod(e)) {
        e.preventDefault()
        flushSave()
      }
      if (e.key === 'j' && window.isMod(e)) {
        e.preventDefault()
        toggleAiBlocks()
      }
    })
    textarea.addEventListener('scroll', function () { gutter.scrollTop = textarea.scrollTop })

    wrapper.appendChild(gutter)
    wrapper.appendChild(textarea)
    mountEl.appendChild(wrapper)

    requestAnimationFrame(function () { textarea.focus() })
  }

  function updateGutter(gutter, value) {
    var lines = value.split('\n')
    var count = lines.length
    gutter.innerHTML = ''
    for (var i = 0; i < count; i++) {
      var span = document.createElement('span')
      span.textContent = String(i + 1)
      gutter.appendChild(span)
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────────

  function flushSave() {
    if (!currentUuid) return Promise.resolve()
    // Flush any pending debounced doc-update immediately so Go has the latest content.
    if (docUpdateTimer) {
      clearTimeout(docUpdateTimer)
      docUpdateTimer = null
      wsSend({ type: 'doc-update', uuid: currentUuid, markdown: lastSyncedBody })
    }
    if (currentUuid.startsWith('prompt:')) {
      return doSave(currentUuid, getMarkdown())
    }
    return wsSendAndAwait('flush', { type: 'flush', uuid: currentUuid })
      .catch(function (err) {
        console.warn('[editor] flush timeout, continuing:', err)
      })
  }

  function doSave(uuid, body) {
    if (aiReloadInProgress) return Promise.resolve()
    return fetch('/api/editor/save?uuid=' + encodeURIComponent(uuid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: body, mode: currentMode }),
    }).then(function () {
      document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false } }))
      document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: uuid } }))
    }).catch(function (err) { console.error('[editor] save failed', err) })
  }

  function openEditorWs(uuid) {
    closeEditorWs()

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    var host = location.host
    if (window.__sieveDevServerPort) {
      host = '127.0.0.1:' + window.__sieveDevServerPort
    }
    editorWs = new WebSocket(proto + '//' + host + '/api/ws?uuid=' + encodeURIComponent(uuid))

    editorWs.onopen = function () {
      console.log('[editor] ws connected')
      reconnectDelay = 1000
      lastPong = Date.now()
      
      editorWsPending.forEach(function (m) { editorWs.send(m) })
      editorWsPending = []

      clearInterval(pingInterval)
      pingInterval = setInterval(function() {
        if (Date.now() - lastPong > 45000) {
          console.warn('[editor] ws: watchdog timeout, forcing reconnect')
          if (editorWs) editorWs.close()
          return
        }
        if (editorWs && editorWs.readyState === WebSocket.OPEN) {
          editorWs.send(JSON.stringify({ type: 'ping' }))
        }
      }, 15000)
    }

    editorWs.onmessage = function (event) {
      var msg = JSON.parse(event.data || '{}')
      if (msg.type === 'pong') {
        lastPong = Date.now()
        return
      }

      var awaiter = editorWsAwaiters[msg.type]
      if (awaiter) {
        delete editorWsAwaiters[msg.type]
        awaiter.resolve(msg)
      }
      if (msg.type === 'flush-ack') {
        document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false } }))
        document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: msg.uuid } }))
      }
      if (msg.type === 'error') {
        window.alert(msg.message || 'An error occurred.')
      }
      if (msg.type === 'markdown-content') {
        document.dispatchEvent(new CustomEvent('editor:markdown-content', { detail: msg }))
      }
      if (msg.type === 'insert-block') {
        document.dispatchEvent(new CustomEvent('editor:insert-block', { detail: msg }))
      }
      if (msg.type === 'block-attrs-updated') {
        document.dispatchEvent(new CustomEvent('editor:block-attrs-updated', { detail: msg }))
      }
      if (msg.type === 'block-promoted') {
        softReloadContent(currentUuid)
      }
      if (msg.type === 'block-extracted') {
        // Rely on insert-block to place the new node; do not reload.
      }
    }

    editorWs.onclose = function () {
      clearInterval(pingInterval)
      console.warn('[editor] ws closed. Reconnecting in ' + reconnectDelay + 'ms...')
      
      clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(function() {
        reconnectDelay = Math.min(reconnectDelay * 2, 30000)
        openEditorWs(uuid)
      }, reconnectDelay)
    }

    editorWs.onerror = function (err) { console.error('[editor] ws error', err) }
  }

  var editorWs = null
  var editorWsPending = []
  var editorWsAwaiters = {}
  
  var reconnectTimer = null
  var pingInterval = null
  var reconnectDelay = 1000
  var lastPong = Date.now()

  function closeEditorWs() {
    clearTimeout(reconnectTimer)
    clearInterval(pingInterval)
    if (editorWs) { 
      editorWs.onclose = null
      editorWs.close()
      editorWs = null 
    }
    editorWsPending = []
    editorWsAwaiters = {}
  }

  function wsSend(msg) {
    var data = JSON.stringify(msg)
    if (editorWs && editorWs.readyState === WebSocket.OPEN) {
      editorWs.send(data)
    } else {
      editorWsPending.push(data)
    }
  }

  function wsSendAndAwait(type, msg) {
    return new Promise(function (resolve, reject) {
      var ackType = type + '-ack'
      var timer = setTimeout(function () {
        delete editorWsAwaiters[ackType]
        reject(new Error('ws timeout: ' + type))
      }, 5000)
      editorWsAwaiters[ackType] = {
        resolve: function (m) { clearTimeout(timer); resolve(m) },
        reject: function (e) { clearTimeout(timer); reject(e) },
      }
      wsSend(msg)
    })
  }

  // Primary creation path. JS fires sieve:create-block when the user uses a
  // keyboard shortcut, toolbar button, or slash command to insert a block.
  // detail: { kind: 'code', attrs: {} }
  document.addEventListener('sieve:create-block', function (e) {
    if (!currentUuid || currentUuid.startsWith('prompt:') || !e.detail.kind) return
    sieveInsertPos = currentEditor ? currentEditor.state.selection.to : null
    var attrs = e.detail.attrs || {}
    if (e.detail.kind === 'diagram' && !attrs.source) {
      attrs.mode = 'edit'
    }
    wsSend({ type: 'create-block', kind: e.detail.kind, attrs: attrs, uuid: currentUuid })
  })

  // Explicitly capture insertion position for async flows (like image upload)
  document.addEventListener('sieve:capture-insert-pos', function () {
    sieveInsertPos = currentEditor ? currentEditor.state.selection.to : null
  })

  // NodeViews fire sieve:block-update when the user edits block content.
  document.addEventListener('sieve:block-update', function (e) {
    if (!currentUuid || !e.detail.id) return
    wsSend({ type: 'block-update', uuid: currentUuid, id: e.detail.id, kind: e.detail.kind, attrs: e.detail.attrs })
  })

  document.addEventListener('sieve:promote-block', function (e) {
    if (!currentUuid || !e.detail || !e.detail.id) return
    wsSend({ type: 'promote-block', id: e.detail.id, uuid: currentUuid })
  })

  document.addEventListener('editor:insert-block', function (e) {
    var msg = e.detail
    if (currentMode === 'markdown' && currentMarkdownTextarea) {
      sieveInsertPos = null
      lastSyncedBody = lastSyncedBody.trim() + '\n\n' + (msg.serialisedForm || '') + '\n'
      currentMarkdownTextarea.value = lastSyncedBody
      wsSend({ type: 'doc-update', uuid: currentUuid, markdown: lastSyncedBody })
      return
    }
    if (!currentEditor) return
    var parsed = msg.attrs || {}

    var target = sieveInsertPos
    sieveInsertPos = null

    var attrs = {
      kind:            msg.kind || 'code',
      id:              msg.id || parsed.id || '',
      serialisedForm:  msg.serialisedForm || '',
      status:          parsed.status || 'PENDING',
      createdAt:       parsed.createdAt || null,
    }
    Object.keys(parsed).forEach(function (k) {
      if (k !== 'id' && k !== 'status' && k !== 'createdAt') {
        attrs[k] = parsed[k]
      }
    })

    var newBlock = {
      type: 'sieve-' + (msg.kind || 'code'),
      attrs: attrs,
    }
    // Object target → in-place conversion: replace the native source node's range
    // with the Sieve block (one transaction → one Undo). Number/null → insert at
    // that point (additive extraction / paste / create).
    if (target && typeof target === 'object') {
      currentEditor.commands.insertContentAt(target, newBlock)
    } else {
      currentEditor.commands.insertContentAt(target !== null ? target : currentEditor.state.doc.content.size, newBlock)
    }

    if (!parsed.source && (msg.kind === 'code' || msg.kind === 'diagram')) {
      setTimeout(function () {
        var el = document.querySelector('[data-id="' + (msg.id || parsed.id) + '"] .sieve-block__edit')
        if (el) el.focus()
      }, 50)
    }
  })

  document.addEventListener('editor:block-attrs-updated', function (e) {
    if (!currentEditor) return
    var msg = e.detail
    var parsed = msg.attrs || {}

    currentEditor.commands.command(function (commandProps) {
      var tr = commandProps.tr
      commandProps.state.doc.descendants(function (node, pos) {
        // Match any sieve-* node by id (kind is not in the WS message)
        if (node.type.name.startsWith('sieve-') && node.attrs.id === msg.id) {
          var nextAttrs = Object.assign({}, node.attrs, {
            serialisedForm:  msg.serialisedForm || node.attrs.serialisedForm,
            status:          parsed.status   || node.attrs.status,
          })
          var schemaAttrs = node.type.spec.attrs || {}
          Object.keys(parsed).forEach(function (k) {
            // Safely apply keys that exist in the existing node.attrs schema mapping
            if (k !== 'id' && k !== 'status' && (k in node.attrs)) {
              nextAttrs[k] = parsed[k]
            }
          })
          try {
            tr.setNodeMarkup(pos, null, nextAttrs)
          } catch (err) {
            console.error('[editor] setNodeMarkup failed:', err, nextAttrs)
          }
          return false
        }
      })
      return true
    })
  })

  // ── Stats ─────────────────────────────────────────────────────────────────────

  function dispatchStats() {
    var text = getMarkdown()
    var chars = text.length
    var lines = text === '' ? 0 : text.split('\n').length
    
    var blockCount = currentEditor ? currentEditor.state.doc.childCount : lines
    var digits = Math.max(1, String(blockCount).length)
    document.documentElement.style.setProperty('--line-digits', digits)

    document.dispatchEvent(new CustomEvent('editor:stats', { detail: { chars: chars, lines: lines } }))
  }

  function getMarkdown() {
    if (currentMode === 'markdown') return lastSyncedBody
    if (!currentEditor) return ''
    return currentEditor.storage.markdown.getMarkdown() || ''
  }

  function ensureOverlays() {
    if (!askDialog) askDialog = wireAskPanel()
    if (!searchOverlay) searchOverlay = createSearchOverlay()
    if (!internalizeDialog) internalizeDialog = createInternalizeDialog()
    if (!richLinkDialog) richLinkDialog = createSmartCardDialog()
  }

  

  // ── Ask panel — wires the structural #ask-panel div in index.html ───────────

  var pendingAskCtx = null
  var isAskPanelPinned = window.initAskPanelPinned || false
  var askLabelTimeout = null
  var returnSelection = null   // editor selection captured on jump-in to the Ask box

  document.addEventListener('sieve:ask-panel-toggled', function(e) {
    isAskPanelPinned = e.detail
    var panel = document.getElementById('ask-panel')
    if (panel) {
      if (isAskPanelPinned) panel.classList.add('is-open')
      else if (document.activeElement !== panel.querySelector('.ask-popup__input')) panel.classList.remove('is-open')
    }
  })

  // Wire event handlers onto the structural #ask-panel from index.html. The panel
  // is not created here — it lives in the DOM; this just binds send/close/keys.
  function wireAskPanel() {
    var panel = document.getElementById('ask-panel')
    if (!panel) return null

    var textarea = panel.querySelector('.ask-popup__input')
    var sendBtn  = panel.querySelector('.ask-popup__send')
    var closeBtn = panel.querySelector('.ask-popup__close')

    // "View Ask panel on/off" and "pin" are one construct: a single persisted
    // boolean (ShowAskPanel) flipped by /api/session/askpanel/toggle — the same
    // endpoint the View menu uses. So when the panel is pinned ON, ✕ untoggles
    // it through that endpoint (persisting off). When it's a transient ambient
    // open (focus-jumped, not pinned), ✕ just hands focus back and hides it.
    function closePanel() {
      if (isAskPanelPinned && window.htmx) {
        window.htmx.ajax('POST', '/api/session/askpanel/toggle', { swap: 'none' })
      }
      returnToEditor()
    }

    sendBtn.addEventListener('click', function () { doAsk(textarea, panel) })
    if (closeBtn) closeBtn.addEventListener('click', closePanel)

    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doAsk(textarea, panel) }
      if (e.key === 'Escape') { e.preventDefault(); closePanel() }
    })

    return panel
  }

  function updateAskPanelLabelLive(editor) {
    if (!askDialog) return
    if (!askDialog.classList.contains('is-open')) return
    // A pinned explicit target (right-click / sieve block) overrides ambient.
    if (pendingAskCtx) return
    if (askLabelTimeout) clearTimeout(askLabelTimeout)
    askLabelTimeout = setTimeout(function () {
      if (pendingAskCtx) return
      var t = window.TipTap.resolveAiTarget(editor, currentMode === 'markdown')
      var label = askDialog.querySelector('.ask-popup__label')
      label.textContent = t.label === 'Follow-up' ? 'Ask Follow-up' : 'Ask About ' + t.label
      if (currentMode !== 'markdown') window.TipTap.setAiTargetGlow(editor.view, t.range)
    }, 100)
  }

  function openAskPopup(precomputedCtx) {
    if (!askDialog) return
    var textarea = askDialog.querySelector('.ask-popup__input')
    
    // Toggle: if the box already has focus, jump back to the editor (focus axis
    // only — pin/visibility is independent).
    if (askDialog.classList.contains('is-open') && document.activeElement === textarea) {
      returnToEditor()
      return
    }
    // Jump IN: remember where we were so we can restore the caret exactly.
    if (currentEditor) returnSelection = currentEditor.state.selection

    pendingAskCtx = precomputedCtx || null
    askDialog.classList.add('is-open')
    if (pendingAskCtx && pendingAskCtx.range && currentEditor) {
      window.TipTap.setAiTargetGlow(currentEditor.view, pendingAskCtx.range)
    } else if (currentEditor) {
      updateAskPanelLabelLive(currentEditor)
    }

    setTimeout(function() {
      textarea.focus()
    }, 50)
  }

  // ── Rich Link dialog ──────────────────────────────────────────────────────────

  function createSmartCardDialog() {
    var dialog = document.createElement('dialog')
    dialog.className = 'internalize-popup ask-popup'

    var header = document.createElement('div'); header.className = 'ask-popup__header'
    var label = document.createElement('span'); label.className = 'ask-popup__label'; label.textContent = 'Insert Link Card'
    var closeBtn = makeBtn('ask-popup__close', '✕', function () { dialog.close() })
    closeBtn.title = 'Close (Esc)'
    header.appendChild(label); header.appendChild(closeBtn)

    var urlInput = document.createElement('input')
    urlInput.type = 'url'
    urlInput.className = 'internalize-popup__input'
    urlInput.placeholder = 'https://…'

    var errorMsg = document.createElement('div')
    errorMsg.className = 'internalize-popup__error'
    errorMsg.textContent = 'Please enter a valid http:// or https:// URL'
    errorMsg.style.display = 'none'

    urlInput.addEventListener('input', function () { errorMsg.style.display = 'none' })

    function trySubmit() {
      var url = urlInput.value.trim()
      if (!isValidURL(url)) { errorMsg.style.display = ''; return }
      doCreateSmartCard(url)
      dialog.close()
    }

    var footer = document.createElement('div'); footer.className = 'ask-popup__footer'
    var insertBtn = makeBtn('internalize-popup__btn', 'Insert Card', trySubmit)
    footer.appendChild(insertBtn)

    urlInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); dialog.close() }
      if (e.key === 'Enter') { e.preventDefault(); trySubmit() }
    })

    dialog.appendChild(header)
    dialog.appendChild(urlInput)
    dialog.appendChild(errorMsg)
    dialog.appendChild(footer)
    document.body.appendChild(dialog)
    return dialog
  }

  function openSmartCardDialog(prefillUrl) {
    if (!richLinkDialog) return
    var urlInput = richLinkDialog.querySelector('input')
    if (urlInput) urlInput.value = prefillUrl || ''
    if (!richLinkDialog.open) richLinkDialog.showModal()
    if (urlInput) urlInput.focus()
  }

  function doCreateSmartCard(href) {
    if (!currentUuid) return
    if (!currentEditor && currentMode !== 'markdown') return
    sieveInsertPos = currentEditor ? currentEditor.state.selection.to : null
    wsSend({ type: 'create-block', kind: 'smart-card', attrs: { href: href }, uuid: currentUuid })
  }

  // ── Internalize dialog ────────────────────────────────────────────────────────

  function isValidURL(url) {
    try {
      var u = new URL(url)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch (e) {
      return false
    }
  }

  function createInternalizeDialog() {
    var dialog = document.createElement('dialog')
    dialog.className = 'internalize-popup ask-popup'

    var header = document.createElement('div'); header.className = 'ask-popup__header'
    var label = document.createElement('span'); label.className = 'ask-popup__label'; label.textContent = 'Insert Web Clip'
    var closeBtn = makeBtn('ask-popup__close', '✕', function () { dialog.close() })
    closeBtn.title = 'Close (Esc)'
    header.appendChild(label); header.appendChild(closeBtn)

    var urlInput = document.createElement('input')
    urlInput.type = 'url'
    urlInput.className = 'internalize-popup__input'
    urlInput.placeholder = 'https://…'

    var errorMsg = document.createElement('div')
    errorMsg.className = 'internalize-popup__error'
    errorMsg.textContent = 'Please enter a valid http:// or https:// URL'
    errorMsg.style.display = 'none'

    urlInput.addEventListener('input', function () { errorMsg.style.display = 'none' })

    function trySubmit(mode) {
      var url = urlInput.value.trim()
      if (!isValidURL(url)) { errorMsg.style.display = ''; return }
      if (mode === 'card') {
        doCreateSmartCard(url)
      } else {
        doInternalize(url, mode)
      }
      dialog.close()
    }

    var footer = document.createElement('div'); footer.className = 'ask-popup__footer'
    var fetchBtn = makeBtn('internalize-popup__btn', 'Fetch', function () { trySubmit('fetch') })
    var summariseBtn = makeBtn('internalize-popup__btn', 'Summarise', function () { trySubmit('summarise') })
    var cardBtn = makeBtn('internalize-popup__btn', 'Card', function () { trySubmit('card') })
    footer.appendChild(fetchBtn); footer.appendChild(summariseBtn); footer.appendChild(cardBtn)

    urlInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); dialog.close() }
      if (e.key === 'Enter') { e.preventDefault(); trySubmit('fetch') }
    })

    dialog.appendChild(header)
    dialog.appendChild(urlInput)
    dialog.appendChild(errorMsg)
    dialog.appendChild(footer)
    document.body.appendChild(dialog)
    return dialog
  }

  function openInternalizeDialog(prefillUrl) {
    if (!internalizeDialog) return
    var urlInput = internalizeDialog.querySelector('input')
    if (urlInput) urlInput.value = prefillUrl || ''
    if (!internalizeDialog.open) internalizeDialog.showModal()
    if (urlInput) urlInput.focus()
  }

  function doInternalize(source, mode) {
    if (!currentUuid) return
    if (!currentEditor && currentMode !== 'markdown') return
    sieveInsertPos = currentEditor ? currentEditor.state.selection.to : null
    wsSend({ type: 'create-block', kind: 'web-clip', attrs: { source: source, mode: mode }, uuid: currentUuid })
  }

  // ── Search overlay ────────────────────────────────────────────────────────────

  function createSearchOverlay() {
    var overlay = document.createElement('div')
    overlay.className = 'editor-search-overlay'

    var topRow = document.createElement('div')
    topRow.className = 'editor-search__top-row'

    var input = document.createElement('input')
    input.placeholder = 'Search...'
    input.className = 'editor-search__input'

    var stats = document.createElement('span')
    stats.className = 'editor-search__stats'
    stats.textContent = '0/0'

    topRow.appendChild(input); topRow.appendChild(stats)

    var bottomRow = document.createElement('div')
    bottomRow.className = 'editor-search__bottom-row'

    var btnPrev = makeBtn('editor-search__btn', '\u2191', function() {
        if (currentMode === 'markdown') { /* TODO */ }
        else if (currentEditor) currentEditor.commands.prevSearchResult()
        updateStats()
    })
    
    var btnNext = makeBtn('editor-search__btn', '\u2193', function() {
        if (currentMode === 'markdown') { /* TODO */ }
        else if (currentEditor) currentEditor.commands.nextSearchResult()
        updateStats()
    })

    var btnClose = makeBtn('editor-search__close', '\u2715', function() {
        overlay.style.display = 'none'
        if (currentEditor) {
            currentEditor.commands.clearSearch()
            currentEditor.commands.focus()
        }
    })

    bottomRow.appendChild(btnPrev); bottomRow.appendChild(btnNext); bottomRow.appendChild(btnClose)
    overlay.appendChild(topRow); overlay.appendChild(bottomRow)

    function updateStats() {
        if (currentMode === 'markdown') {
            stats.textContent = '0/0'
            return
        }
        if (!currentEditor) return
        var s = currentEditor.storage.search
        if (s && s.results) {
            stats.textContent = (s.results.length > 0 ? (s.currentIndex + 1) : 0) + '/' + s.results.length
        }
    }

    input.addEventListener('input', function() {
        var term = input.value
        if (currentMode === 'markdown') {
            // Placeholder
        } else if (currentEditor) {
            currentEditor.commands.setSearchTerm(term)
            updateStats()
        }
    })

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) {
                if (currentEditor) currentEditor.commands.prevSearchResult()
            } else {
                if (currentEditor) currentEditor.commands.nextSearchResult()
            }
            updateStats()
        }
        if (e.key === 'Escape') {
            e.preventDefault()
            overlay.style.display = 'none'
            if (currentEditor) {
                currentEditor.commands.clearSearch()
                currentEditor.commands.focus()
            }
        }
    })

    document.body.appendChild(overlay)
    return overlay
  }

  // Jump back to the editor, restoring the caret to where we were when we entered
  // the Ask box. Focus and panel visibility are independent: only hide if unpinned.
  function returnToEditor() {
    if (!isAskPanelPinned && askDialog) askDialog.classList.remove('is-open')
    if (currentEditor) {
      if (returnSelection) {
        try {
          currentEditor.view.focus()
          currentEditor.view.dispatch(currentEditor.state.tr.setSelection(returnSelection))
        } catch (e) { currentEditor.view.focus() }
      } else {
        currentEditor.view.focus()
      }
    }
  }

  function doAsk(textarea, panel) {
    var val = textarea.value.trim()
    if (!val) return

    var ctx
    var hadPinned = !!pendingAskCtx
    if (pendingAskCtx) {
      ctx = pendingAskCtx
    } else {
      // Resolve once at SEND. Mint an anchor ONLY for a live selection — the one
      // mutating case. applyTargetHighlight wraps in blockRef + applies ==.
      var t = window.TipTap.resolveAiTarget(currentEditor, currentMode === 'markdown')
      if (t.kind === 'selection' && currentMode !== 'markdown') {
        window.TipTap.applyTargetHighlight(currentEditor)
      }
      ctx = window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', lastSyncedBody, currentUuid)
    }

    runAiJob('ask', val, ctx)
    pendingAskCtx = null
    textarea.value = ''
    if (currentEditor) window.TipTap.clearAiTargetGlow(currentEditor.view)
    if (!isAskPanelPinned) panel.classList.remove('is-open')
    // Return focus to the editor. For the selection-mint case the caret already
    // sits in the freshly-minted anchor (applyTargetHighlight preserves it); for
    // non-mutating kinds, restore the captured selection.
    if (currentEditor) {
      currentEditor.view.focus()
      if (returnSelection && !hadPinned) {
        try { currentEditor.view.dispatch(currentEditor.state.tr.setSelection(returnSelection)) } catch (e) {}
      }
    }
    returnSelection = null
  }

  // ── AI jobs ───────────────────────────────────────────────────────────────────

  // softReloadContent fetches the latest body from disk and replaces editor content,
  // preserving the cursor position. Called when an ai:block-resolved SSE event arrives.
  function softReloadContent(uuid) {
    if (currentMode !== 'wysiwyg' && currentMode !== 'markdown') return
    if (currentMode === 'wysiwyg' && !currentEditor) return
    aiReloadInProgress = true
    var savedAnchor = currentMode === 'wysiwyg' ? currentEditor.state.selection.anchor : null
    fetch('/api/editor/load?uuid=' + encodeURIComponent(uuid))
      .then(function (r) { return r.json() })
      .then(function (data) {
        if (currentUuid !== uuid) { aiReloadInProgress = false; return }
        var body = data.body || ''
        if (currentMode === 'wysiwyg' && currentEditor) {
          currentEditor.commands.setContent(body)
          lastSyncedBody = body
          aiReloadInProgress = false
          var maxPos = currentEditor.state.doc.content.size
          currentEditor.commands.setTextSelection(Math.min(savedAnchor, maxPos - 1))
        } else if (currentMode === 'markdown' && currentMarkdownTextarea) {
          currentMarkdownTextarea.value = body
          lastSyncedBody = body
          aiReloadInProgress = false
        } else {
          aiReloadInProgress = false
        }
      })
      .catch(function (err) {
        aiReloadInProgress = false
        console.error('[editor] softReloadContent failed', err)
      })
  }


    function runAiJob(type, question, precomputedCtx) {
      if (!currentEditor && currentMode !== 'markdown') return

      var ctx = precomputedCtx || window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', lastSyncedBody, currentUuid)
      var refId = (ctx && ctx.blockRef) || 'doc'
      var blockType = type === 'explain' ? 'EXPLAIN' : 'ASK'

      // Insert the answer AFTER the target block (anchor/sieve), never nested
      // inside it. After a SEND-time mint the caret sits inside the fresh anchor,
      // so selection.to alone would place the block inside it. See ai-target.js.
      sieveInsertPos = currentEditor ? window.TipTap.aiInsertPos(currentEditor.state) : null

      flushSave().then(function () {
        wsSend({
          type: 'create-block',
          kind: 'ai-block',
          attrs: {
            type:     blockType,
            ref:      refId,
            question: question || '',
          },
          uuid: currentUuid,
        })
      }).catch(function(err) {
        console.error('runAiJob flush save error:', err)
      })
    }

    function toggleAiBlocks() {
    showAiBlocks = !showAiBlocks
    var panel = currentMountEl || document.querySelector('.editor-panel')
    if (panel) {
      panel.classList.toggle('hide-ai-blocks', !showAiBlocks)
    }
  }

  function handleSmartPaste(event) {
    if (!event.clipboardData || !currentEditor) return false

    if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA')) {
      return false
    }

    var text = event.clipboardData.getData('text/plain')
    var html = event.clipboardData.getData('text/html')
    var files = Array.from(event.clipboardData.files)

    // ── 1. ai-block re-import (JS-owned) ────────────────────────────────────────
    // Pasting a complete ```ai-block…``` fence reconstructs the existing block
    // node with its original ID — no Go round-trip needed.
    if (text && text.trim().startsWith('```ai-block')) {
      var cleanText = text.trim()
      var firstLineEnd = cleanText.indexOf('\n')
      var lastBackticks = cleanText.lastIndexOf('```')
      if (firstLineEnd !== -1 && lastBackticks !== -1 && lastBackticks > firstLineEnd) {
        var yamlText = cleanText.substring(firstLineEnd + 1, lastBackticks).trim()
        try {
          var data = window.jsyaml.load(yamlText)
          if (data && data.id) {
            event.preventDefault()
            currentEditor.commands.insertContent({
              type: 'sieve-ai-block',
              attrs: {
                rawYaml:     yamlText,
                id:          data.id || '',
                ref:         data.ref || 'doc',
                status:      data.status || 'PENDING',
                type:        data.type || null,
                model:       data.model || null,
                createdAt:   data.createdAt || null,
                completedAt: data.completedAt || null,
                question:    data.question || '',
                response:    data.response || null,
              }
            })
            return true
          }
        } catch (e) {
          console.error('[editor.js] Failed to parse pasted ai-block yaml', e)
        }
      }
    }

    // ── 1b. sieve/slice reconstruct ──────────────────────────────────────────────
    var sliceData = event.clipboardData.getData('sieve/slice')
    if (sliceData) {
      try {
        var blocks = JSON.parse(sliceData)
        if (Array.isArray(blocks) && blocks.length > 0) {
          event.preventDefault()
          // Build the whole ordered content array and insert it in ONE call.
          // Inserting block-by-block in a loop dropped trailing blocks because
          // each insert moved the selection the next insert relied on.
          var sliceContent = blocks.map(function (entry) {
            if (entry._type === 'prose') {
              // Prose node — PM JSON (preserves heading level, bold, links, etc.)
              return entry.json
            }
            // Sieve block — new format (_type:'sieve') or legacy format (no _type)
            var nodeAttrs = (entry._type === 'sieve') ? entry.attrs : entry
            var pasteAttrs = {}
            for (var attrKey in nodeAttrs) {
              if (Object.prototype.hasOwnProperty.call(nodeAttrs, attrKey) && attrKey !== 'type') {
                pasteAttrs[attrKey] = nodeAttrs[attrKey]
              }
            }
            return { type: 'sieve-' + entry.kind, attrs: pasteAttrs }
          })
          currentEditor.commands.insertContent(sliceContent)
          return true
        }
      } catch (e) {
        console.error('[editor.js] Failed to parse sieve/slice paste', e)
      }
    }

    // ── 2. Smart-paste pipeline (including images) ────────────────────────────────
    // Collect all clipboard entries. For files, we use FileReader to get base64.
    if (currentUuid && !currentUuid.startsWith('prompt:')) {
      var pasteEntries = []
      var hasFiles = false

      if (event.clipboardData && event.clipboardData.items) {
        var promises = []
        Array.from(event.clipboardData.items).forEach(function(item) {
          if (item.kind === 'file') {
            var file = item.getAsFile()
            if (file) {
              hasFiles = true
              promises.push(new Promise(function(resolve) {
                var reader = new FileReader()
                reader.onload = function(e) {
                  resolve({ mimeType: file.type, content: e.target.result })
                }
                reader.onerror = function() { resolve(null) }
                reader.readAsDataURL(file)
              }))
            }
          } else if (item.kind === 'string') {
            promises.push(new Promise(function(resolve) {
              item.getAsString(function(str) {
                resolve({ mimeType: item.type, content: str })
              })
            }))
          }
        })

        sieveInsertPos = currentEditor ? currentEditor.state.selection.to : null
        event.preventDefault()

        Promise.all(promises).then(function(results) {
          var validEntries = results.filter(function(r) { return r !== null })
          fetch('/api/editor/smart-paste', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uuid: currentUuid, entries: validEntries }),
          })
            .then(function (r) { return r.json() })
            .then(function (result) {
              if (!currentEditor) return
              if (result.matched) {
                // Handled entirely via WebSocket push. Nothing to insert here.
              } else {
                // No processor matched — clear the stashed insert position and replay original clipboard content.
                sieveInsertPos = null
                if (html) {
                  currentEditor.commands.insertContent(html)
                } else if (text) {
                  currentEditor.commands.insertContent(text)
                }
              }
            })
            .catch(function (err) {
              console.error('[editor.js] smart-paste fetch failed', err)
              sieveInsertPos = null
              if (currentEditor) currentEditor.commands.insertContent(text)
            })
        })
        return true
      }
    }

    return false
  }

  function handleSmartDrop(event) {
    if (!event.dataTransfer || !currentEditor) return false

    if (currentUuid && !currentUuid.startsWith('prompt:')) {
      var promises = []
      var hasFiles = false
      if (event.dataTransfer.items) {
        Array.from(event.dataTransfer.items).forEach(function(item) {
          if (item.kind === 'file') {
            var file = item.getAsFile()
            if (file && file.type.startsWith('image/')) {
              hasFiles = true
              promises.push(new Promise(function(resolve) {
                var reader = new FileReader()
                reader.onload = function(e) {
                  resolve({ mimeType: file.type, content: e.target.result })
                }
                reader.onerror = function() { resolve(null) }
                reader.readAsDataURL(file)
              }))
            }
          } else if (item.kind === 'string') {
            promises.push(new Promise(function(resolve) {
              item.getAsString(function(str) {
                resolve({ mimeType: item.type, content: str })
              })
            }))
          }
        })
      }

      if (!hasFiles) return false

      var pos = currentEditor.view.posAtCoords({ left: event.clientX, top: event.clientY })
      var insertPos = pos ? pos.pos : currentEditor.state.selection.to
      
      event.preventDefault()

      Promise.all(promises).then(function(results) {
        var validEntries = results.filter(function(r) { return r !== null })
        if (validEntries.length === 0) return
        sieveInsertPos = insertPos
        fetch('/api/editor/smart-paste', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid: currentUuid, entries: validEntries }),
        })
          .then(function (r) { return r.json() })
          .then(function (result) {
            if (!currentEditor) return
            if (result.matched) {
              // Handled entirely via WebSocket push. Nothing to insert here.
            }
          })
          .catch(function (err) {
            console.error('[editor.js] smart-drop fetch failed', err)
          })
      })
      return true
    }
    return false
  }

  // ── Module-level editor commands (dispatched via sieve:* custom events) ─────

  function setContent(content) {
    if (currentMode === 'markdown') {
      var ta = currentMountEl && currentMountEl.querySelector('.markdown-editor')
      if (ta) { ta.value = content; lastSyncedBody = content }
    } else if (currentEditor) {
      currentEditor.commands.setContent(content)
      lastSyncedBody = content
    }
  }

  function toggleSearch() {
    if (!searchOverlay) ensureOverlays()
    if (searchOverlay.style.display === 'none') {
      searchOverlay.style.display = 'flex'
      var input = searchOverlay.querySelector('input')
      if (input) { input.focus(); input.select() }
    } else {
      searchOverlay.style.display = 'none'
      if (currentEditor) currentEditor.commands.clearSearch()
    }
  }

  function toggleMode() {
    if (!currentUuid || !currentMountEl) return
    var newMode = (currentMode === 'markdown') ? 'wysiwyg' : 'markdown'
    var content = ''
    if (currentMode === 'markdown') {
      var ta = currentMountEl.querySelector('.markdown-editor')
      if (ta) content = ta.value
    } else if (currentEditor) {
      content = currentEditor.storage.markdown.getMarkdown() || ''
    } else {
      content = lastSyncedBody
    }
    lastSyncedBody = content
    currentMode = newMode
    tabModes[currentUuid] = currentMode
    
    if (currentEditor) { currentEditor.destroy(); currentEditor = null; window.__tiptap = null }
    currentMountEl.innerHTML = ''
    
    if (currentMode === 'wysiwyg') {
      wsSend({ type: 'enter-wysiwyg', uuid: currentUuid })
      mountWysiwyg(currentMountEl, currentUuid, content)
      dispatchStats()
      if (window.htmx) window.htmx.ajax('GET', '/api/tabs', { target: '#htmx-tabbar', swap: 'innerHTML' })
    } else {
      // Switching to markdown — request merged content from EditorService
      wsSend({ type: 'enter-markdown', uuid: currentUuid })
      document.addEventListener('editor:markdown-content', function onMdContent(e) {
        if (e.detail.uuid !== currentUuid) return
        if (currentMode !== 'markdown') return  // user toggled back before response arrived
        document.removeEventListener('editor:markdown-content', onMdContent)
        lastSyncedBody = e.detail.markdown
        mountMarkdown(currentMountEl, currentUuid, e.detail.markdown)
        dispatchStats()
        if (window.htmx) window.htmx.ajax('GET', '/api/tabs', { target: '#htmx-tabbar', swap: 'innerHTML' })
      }, { once: true })
    }
  }

  document.addEventListener('sieve:toggle-mode',      toggleMode)
  document.addEventListener('sieve:toggle-search',    toggleSearch)
  document.addEventListener('sieve:toggle-ai-blocks', toggleAiBlocks)

  // ── Ask AI / Explain: the single business-logic seam ──────────────────────────
  // Every entry point — toolbar button, context menu, keyboard shortcut, sieve
  // block — just fires sieve:ai-ask / sieve:ai-explain. These two handlers are the
  // ONE place that prepares the target and runs the job, so all surfaces behave
  // identically. No surface should call runAiJob/openAskPopup or applyTargetHighlight
  // itself. aiPrepareTarget returns false to abort (markdown mode has no inline target).
  function aiPrepareTarget(precomputedCtx) {
    if (currentMode === 'markdown') return false
    if (precomputedCtx || !currentEditor) return true   // caller supplied context as-is
    var sel = currentEditor.state.selection
    // Visible == target highlight only for a real text selection — skip collapsed
    // cursors, node selections (e.g. an AI block), and already-highlighted targets.
    if (sel && !sel.empty && !sel.node && !currentEditor.isActive('highlight')) {
      window.TipTap.applyTargetHighlight(currentEditor)
    }
    currentEditor.commands.focus()
    return true
  }

  document.addEventListener('sieve:ai-explain', function (e) {
    var ctx = e && e.detail && e.detail.precomputedCtx
    if (!aiPrepareTarget(ctx)) return
    runAiJob('explain', undefined, ctx)
  })
  document.addEventListener('sieve:ai-ask', function (e) {
    var ctx = e && e.detail && e.detail.precomputedCtx
    // No mint at open — the target is resolved live and only minted at SEND
    // (doAsk). Markdown mode is allowed: it asks about the whole doc / selection.
    ensureOverlays()
    openAskPopup(ctx)
  })
  document.addEventListener('sieve:block-retry', function (e) {
    if (!currentEditor || !e.detail || !e.detail.id) return
    var blkId = e.detail.id
    var now = new Date().toISOString()
    currentEditor.commands.command(function (props) {
      var tr = props.tr
      var found = false
      props.state.doc.descendants(function (node, pos) {
        if (node.type.name.startsWith('sieve-') && node.attrs.id === blkId) {
          var cleanAttrs = Object.assign({}, node.attrs, { status: 'PENDING', createdAt: now })
          if ('content' in cleanAttrs)     cleanAttrs.content = null
          if ('error' in cleanAttrs)       cleanAttrs.error = null
          if ('title' in cleanAttrs)       cleanAttrs.title = null
          if ('completedAt' in cleanAttrs) cleanAttrs.completedAt = null
          if ('response' in cleanAttrs)    cleanAttrs.response = null
          tr.setNodeMarkup(pos, null, cleanAttrs)
          found = true
          return false
        }
      })
      return found
    })
    wsSend({ type: 'retry-block-job', id: blkId, uuid: currentUuid })
  })

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function extractDomain(url) {
    try { return new URL(url).hostname } catch (_) { return url }
  }

  function makeBtn(cls, text, onClick) {
    var btn = document.createElement('button')
    btn.className = cls; btn.textContent = text
    btn.addEventListener('click', onClick)
    return btn
  }

  window._editorSave = flushSave
  window._sieveOpenInternalize = function (url) { ensureOverlays(); openInternalizeDialog(url) }
  window._sieveOpenSmartCard = function (url) { ensureOverlays(); openSmartCardDialog(url) }

  window._sieveCopyImageToClipboard = function(src) {
    if (!navigator.clipboard || !navigator.clipboard.write) return

    var blobPromise = fetch(src)
      .then(function(res) { return res.blob() })
      .then(function(blob) {
        return new Promise(function(resolve, reject) {
          // WebKit strictly requires image/png for clipboard writes.
          if (blob.type === 'image/png') {
            resolve(blob)
            return
          }
          
          var img = new Image()
          img.onload = function() {
            var canvas = document.createElement('canvas')
            canvas.width = img.width
            canvas.height = img.height
            var ctx = canvas.getContext('2d')
            ctx.drawImage(img, 0, 0)
            canvas.toBlob(function(pngBlob) { resolve(pngBlob) }, 'image/png')
          }
          img.onerror = reject
          img.src = URL.createObjectURL(blob)
        })
      })

    var item = {}
    item['image/png'] = blobPromise

    navigator.clipboard.write([new ClipboardItem(item)]).catch(function(err) {
      console.error('Failed to copy image with promise', err)
      blobPromise.then(function(blob) {
        var fallbackItem = {}
        fallbackItem['image/png'] = blob
        navigator.clipboard.write([new ClipboardItem(fallbackItem)]).catch(function(err2) {
          console.error('Fallback copy failed', err2)
        })
      })
    })
  }

  // Global capture for Ctrl+Click on any link in the app
  document.addEventListener('click', function(e) {
    if (window.isMod(e)) {
      var a = e.target.closest ? e.target.closest('a') : null
      if (a && a.href && a.href.match(/^https?:\/\//)) {
        e.preventDefault()
        e.stopPropagation()
        if (window.runtime && window.runtime.BrowserOpenURL) {
          window.runtime.BrowserOpenURL(a.href)
        } else {
          window.open(a.href, '_blank')
        }
      }
    }
  }, true)

  document.body.addEventListener('editor:restore', function (e) {
    var data = e.detail
    if (data && data.body) setContent(data.body)
  })

  document.addEventListener('contextmenu', function (e) {
    if (e.target.closest('#tiptap-mount')) {
      e.preventDefault()
    }
  }, true)

  document.addEventListener('contextmenu', function (e) {
    if (!e.target.closest('#tiptap-mount')) return
    if (e.target.closest('.ai-block, .image-block, .web-clip-block, .sieve-block')) return
    if (!currentEditor) return
    var linkEl = e.target.closest('a[href]')
    var linkUrl = linkEl ? linkEl.getAttribute('href') : null
    document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
      detail: { x: e.clientX, y: e.clientY, context: { type: 'editor', editor: currentEditor, linkUrl: linkUrl } }
    }))
  })

  document.addEventListener('keydown', function (e) {
    if (e.key === 'W' && window.isMod(e) && e.shiftKey && !e.altKey) {
      e.preventDefault()
      ensureOverlays()
      openInternalizeDialog()
    }
    if (e.key === 'L' && window.isMod(e) && e.shiftKey && !e.altKey) {
      e.preventDefault()
      ensureOverlays()
      openSmartCardDialog()
    }
    if (e.key === 'D' && window.isMod(e) && e.shiftKey && !e.altKey) {
      e.preventDefault()
      if (!currentUuid || !currentEditor) return
      wsSend({ type: 'create-block', kind: 'diagram', attrs: {}, uuid: currentUuid })
    }
  })


  // ── Upgrade to Web Clip (Rich Link → Web Clip) ────────────────────────────────
  // Fired by smart-card-renderer.js context menu "Upgrade to Web Clip".
  document.addEventListener('sieve:upgrade-to-web-clip', function (e) {
    if (!currentUuid || !currentEditor) return
    var href = e.detail.href
    var fromPos = e.detail.fromPos
    var fromSize = e.detail.fromSize
    var mode = e.detail.mode || 'fetch'
    if (!href || fromPos == null) return
    // Delete the smart-card block first, then insert web-clip at its position
    currentEditor.view.dispatch(currentEditor.state.tr.delete(fromPos, fromPos + fromSize))
    sieveInsertPos = fromPos
    wsSend({ type: 'create-block', kind: 'web-clip', attrs: { source: href, mode: mode }, uuid: currentUuid })
  })

  // ── Extract (sieve:extract) ──────────────────────────────────────────────────
  document.addEventListener('sieve:extract', function (e) {
    if (!currentUuid || !currentEditor) return
    var blockId = e.detail.blockId
    var targetKind = e.detail.targetKind
    var entries = e.detail.entries || []
    var sourceNode = e.detail.sourceNode
    var context = e.detail.context || {}

    if (entries.length > 0 && Object.keys(context).length > 0) {
      entries[0].context = context
    }

    var targetPos = e.detail.sourcePos !== undefined ? e.detail.sourcePos : null
    var targetNode = e.detail.sourceNode || null

    if (blockId) {
      currentEditor.state.doc.descendants(function (node, pos) {
        if (node.attrs.id === blockId) {
          targetPos = pos
          targetNode = node
          return false
        }
      })
    }

    // Additive extraction (Sieve-block sources): insert AFTER the source, leaving
    // it intact. In-place conversion (native code blocks, replaceSource): replace
    // the source node's range with the new Sieve block — a single transaction, so
    // one Undo restores the native block.
    if (targetPos !== null && targetNode !== null) {
      sieveInsertPos = e.detail.replaceSource
        ? { from: targetPos, to: targetPos + targetNode.nodeSize }
        : targetPos + targetNode.nodeSize
    }

    if (window.TipTap && window.TipTap.resolveEntriesForKind) {
      var res = window.TipTap.resolveEntriesForKind(targetKind, sourceNode, entries)
      if (res && typeof res.then === 'function') {
        res.then(function(resolved) {
          wsSend({
            type: 'extract',
            blockId: blockId,
            targetKind: targetKind,
            entries: resolved
          })
        }).catch(function(err) {
          console.error('[sieve:extract] extraction failed', err)
        })
        return
      }
      entries = res
    }

    wsSend({
      type: 'extract',
      blockId: blockId,
      targetKind: targetKind,
      entries: entries
    })
  })

  window.sieveInitEditor = initEditor

})()
