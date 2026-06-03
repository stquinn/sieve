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
  var sieveInsertPos = null


  var askDialog = null
  var internalizeDialog = null

  // ── Public entry point called from App.tsx htmx:afterSettle ─────────────────

  function initEditor(mountEl, uuid, mode) {
    if (currentEditor) {
      flushSave()
      currentEditor.destroy()
      currentEditor = null
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
        T.Table.configure({ resizable: false }),
        T.TableRow,
        T.TableHeader,
        T.TableCell,
        T.ImageWithAttrs,
        T.Search,
        T.AiBlock,
        T.AiBlockLegacy,
      ].concat(T.getSieveNodes()).concat([
        T.TaskList,
        T.TaskItem.configure({ nested: true }),
        T.Markdown.configure({ html: true, transformPastedText: true, link: { openOnClick: false } }),
        T.AiShortcuts.configure({
          onExplain: function () { runAiJob('explain') },
          onAsk: function () { openAskPopup() },
          onSmartFile: function () { window.SieveAI && window.SieveAI.smartFile(uuid) },
          onKeepAndSmartFile: function () { window.SieveAI && window.SieveAI.keepAndSmartFile(uuid) },
          onToggleAiBlocks: toggleAiBlocks,
        }),
      ]),
      content: body,
      editorProps: {
        attributes: { spellcheck: 'true' },
        handleDOMEvents: {
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
          return false
        },
      },
      onCreate: function () {
        initialized = true
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

    if (blobInterceptorCleanup) {
      blobInterceptorCleanup()
      blobInterceptorCleanup = null
    }
    blobInterceptorCleanup = initBlobInterceptor(editor, uuid)
  }

  // ── Markdown mode ─────────────────────────────────────────────────────────────

  function mountMarkdown(mountEl, uuid, body) {
    currentMode = 'markdown'
    currentMarkdownTextarea = null

    var wrapper = document.createElement('div')
    wrapper.style.cssText = 'display:flex;flex-direction:row;height:100%;overflow:hidden;background:var(--theme-bg);position:relative'

    var gutter = document.createElement('div')
    gutter.className = 'markdown-gutter'
    gutter.style.cssText = 'width:2.75rem;padding:40px 0.6rem 0.85em;background-color:var(--theme-bgDark);border-right:1px solid var(--theme-border);color:var(--theme-muted);font-family:var(--theme-monoFont);font-size:14px;line-height:1.6;text-align:right;user-select:none;overflow:hidden'

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
    gutter.innerHTML = ''
    for (var i = 0; i < lines.length; i++) {
      var d = document.createElement('div')
      d.textContent = String(i + 1)
      gutter.appendChild(d)
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
    if (editorWs) { editorWs.close(); editorWs = null }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    var host = location.host
    if (window.__sieveDevServerPort) {
      host = '127.0.0.1:' + window.__sieveDevServerPort
    }
    editorWs = new WebSocket(proto + '//' + host + '/api/ws?uuid=' + encodeURIComponent(uuid))

    editorWs.onopen = function () {
      editorWsPending.forEach(function (m) { editorWs.send(m) })
      editorWsPending = []
    }

    editorWs.onmessage = function (event) {
      var msg = JSON.parse(event.data || '{}')
      var awaiter = editorWsAwaiters[msg.type]
      if (awaiter) {
        delete editorWsAwaiters[msg.type]
        awaiter.resolve(msg)
      }
      if (msg.type === 'flush-ack') {
        document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false } }))
        document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: msg.uuid } }))
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

    }

    editorWs.onerror = function (err) { console.error('[editor] ws error', err) }
  }

  function closeEditorWs() {
    if (editorWs) { editorWs.close(); editorWs = null }
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
    wsSend({ type: 'create-block', kind: e.detail.kind, attrs: e.detail.attrs || {}, uuid: currentUuid })
  })

  // NodeViews fire sieve:block-update when the user edits block content.
  document.addEventListener('sieve:block-update', function (e) {
    if (!currentUuid || !e.detail.id) return
    wsSend({ type: 'block-update', uuid: currentUuid, id: e.detail.id, kind: e.detail.kind, attrs: e.detail.attrs })
  })

  document.addEventListener('editor:insert-block', function (e) {
    var msg = e.detail
    if (currentMode === 'markdown' && currentMarkdownTextarea) {
      lastSyncedBody = lastSyncedBody.trim() + '\n\n' + (msg.serialisedForm || '') + '\n'
      currentMarkdownTextarea.value = lastSyncedBody
      wsSend({ type: 'doc-update', uuid: currentUuid, markdown: lastSyncedBody })
      return
    }
    if (!currentEditor) return
    var parsed = msg.attrs || {}

    var pos = sieveInsertPos !== null ? sieveInsertPos : currentEditor.state.doc.content.size
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

    currentEditor.commands.insertContentAt(pos, {
      type: 'sieve-' + (msg.kind || 'code'),
      attrs: attrs,
    })

    if (!parsed.source && msg.kind === 'code') {
      setTimeout(function () {
        var el = document.querySelector('[data-block-id="' + (msg.id || parsed.id) + '"] .sieve-block__edit')
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
          Object.keys(parsed).forEach(function (k) {
            if (k !== 'id' && k !== 'status') {
              nextAttrs[k] = parsed[k]
            }
          })
          tr.setNodeMarkup(pos, null, nextAttrs)
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
    document.dispatchEvent(new CustomEvent('editor:stats', { detail: { chars: chars, lines: lines } }))
  }

  function getMarkdown() {
    if (currentMode === 'markdown') return lastSyncedBody
    if (!currentEditor) return ''
    return currentEditor.storage.markdown.getMarkdown() || ''
  }

  function ensureOverlays() {
    if (!askDialog) askDialog = createAskDialog()
    if (!searchOverlay) searchOverlay = createSearchOverlay()
    if (!internalizeDialog) internalizeDialog = createInternalizeDialog()
  }

  

  // ── Ask dialog ────────────────────────────────────────────────────────────────

  function createAskDialog() {
    var dialog = document.createElement('dialog')
    dialog.className = 'ask-popup'
    dialog.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);top:auto;margin:0;width:80vh;max-width:90vw;'

    var header = document.createElement('div'); header.className = 'ask-popup__header'
    var label = document.createElement('span'); label.className = 'ask-popup__label'
    var closeBtn = makeBtn('ask-popup__close', '\u2715', function () { dialog.close() })
    closeBtn.title = 'Close (Esc)'
    header.appendChild(label); header.appendChild(closeBtn)

    var textarea = document.createElement('textarea')
    textarea.className = 'ask-popup__input'
    textarea.placeholder = 'Ask a question\u2026 (Enter to send, Shift+Enter for new line)'
    textarea.rows = 3; textarea.spellcheck = false

    var footer = document.createElement('div'); footer.className = 'ask-popup__footer'
    var hint = document.createElement('span'); hint.className = 'ask-popup__hint'; hint.textContent = 'Enter to send \u00b7 Shift+Enter for new line'
    var sendBtn = makeBtn('ask-popup__send', 'Send', function () { doAsk(textarea, dialog) })
    footer.appendChild(hint); footer.appendChild(sendBtn)

    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doAsk(textarea, dialog) }
      if (e.key === 'Escape') { e.preventDefault(); dialog.close() }
    })

    dialog.appendChild(header); dialog.appendChild(textarea); dialog.appendChild(footer)
    document.body.appendChild(dialog)
    return dialog
  }

  var pendingAskCtx = null

  function openAskPopup(precomputedCtx) {
    if (!askDialog) return
    // Build context NOW while editor still has focus and selection intact.
    // showModal() will steal DOM focus which can collapse the browser selection.
    // precomputedCtx lets callers (e.g. block renderer context menus) supply
    // context directly rather than relying on editor selection state.
    pendingAskCtx = precomputedCtx || window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', lastSyncedBody, currentUuid)
    var label = askDialog.querySelector('.ask-popup__label')
    var textarea = askDialog.querySelector('.ask-popup__input')
    var ctxLabel = (pendingAskCtx && pendingAskCtx.contextLabel) || 'Document'
    
    var headerText = ''
    if (ctxLabel === 'Follow-up') {
      headerText = 'Ask Follow-up'
    } else {
      headerText = 'Ask About ' + ctxLabel
    }
    label.textContent = headerText
    
    textarea.value = ''
    askDialog.showModal()
    textarea.focus()
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
    dialog.style.cssText = 'top:30%;bottom:auto;left:50%;width:460px;max-width:92vw;'

    var header = document.createElement('div'); header.className = 'ask-popup__header'
    var label = document.createElement('span'); label.className = 'ask-popup__label'; label.textContent = 'Internalise URL'
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
      doInternalize(url, mode)
      dialog.close()
    }

    var footer = document.createElement('div'); footer.className = 'ask-popup__footer'
    var fetchBtn = makeBtn('internalize-popup__btn', 'Fetch', function () { trySubmit('fetch') })
    var summariseBtn = makeBtn('internalize-popup__btn', 'Summarise', function () { trySubmit('summarise') })
    footer.appendChild(fetchBtn); footer.appendChild(summariseBtn)

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

  function doAsk(textarea, dialog) {
    var val = textarea.value.trim()
    if (val) { runAiJob('ask', val, pendingAskCtx); pendingAskCtx = null; dialog.close() }
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

  // HTMX SSE extension dispatches sse:ai:block-resolved when Go finishes an ai-block job.
  // Go has already written the COMPLETE YAML to disk; reload from there (rawYaml passthrough
  // means in-place patch can't update rawYaml correctly, matching the web-clip pattern).
  document.addEventListener('sse:ai:block-resolved', function (e) {
    var raw = e.detail && e.detail.data != null ? e.detail.data : (typeof e.detail === 'string' ? e.detail : null)
    if (!raw) return
    var data; try { data = JSON.parse(raw) } catch (_) { return }
    if (!data) return
    if (data.uuid !== currentUuid) return
    softReloadContent(currentUuid)
  })

  function runAiJob(type, question, precomputedCtx) {
    if (!currentEditor && currentMode !== 'markdown') return

    var ctx = null
    var refId = 'doc'

    var selectedAiNode = null
    var selectedAiPos = null
    var insertPos = null  // wysiwyg only; computed before fetch, used after response

    // 1. Detect if an AI block is selected or focused
    if (currentMode === 'markdown' && currentMarkdownTextarea) {
      var ta = currentMarkdownTextarea
      var val = ta.value
      var selStart = ta.selectionStart
      var beforeSel = val.substring(0, selStart)
      var lastFenceStart = beforeSel.lastIndexOf('```ai-block')
      if (lastFenceStart !== -1) {
        var closeFenceIdx = val.indexOf('```', lastFenceStart + 11)
        if (closeFenceIdx !== -1 && closeFenceIdx >= selStart) {
          var fenceContent = val.substring(lastFenceStart, closeFenceIdx)
          var idMatch = fenceContent.match(/\bid:\s*(\S+)/)
          var refMatch = fenceContent.match(/\bref:\s*(\S+)/)
          if (idMatch) {
            var selectedId = idMatch[1]
            var selectedRef = refMatch ? refMatch[1] : 'doc'
            selectedAiNode = { attrs: { id: selectedId, ref: selectedRef } }
          }
        }
      }
    } else if (currentEditor) {
      var selection = currentEditor.state.selection
      if (selection.node && selection.node.type.name === 'aiBlock') {
        selectedAiNode = selection.node
        selectedAiPos = selection.from
      } else {
        // Resolve nested depth
        var resolved = currentEditor.state.doc.resolve(selection.to)
        for (var depth = resolved.depth; depth > 0; depth--) {
          var n = resolved.node(depth)
          if (n.type.name === 'aiBlock') {
            selectedAiNode = n
            selectedAiPos = resolved.before(depth)
            break
          }
        }
      }

      // Fallback: Check if active element is inside an AI block element
      if (!selectedAiNode) {
        var activeEl = document.activeElement
        if (activeEl) {
          var aiBlockEl = activeEl.closest('.ai-block')
          if (aiBlockEl) {
            var aiId = aiBlockEl.getAttribute('data-ai-id')
            if (aiId) {
              currentEditor.state.doc.descendants(function (node, pos) {
                if (node.type.name === 'aiBlock' && node.attrs.id === aiId) {
                  selectedAiNode = node
                  selectedAiPos = pos
                  return false
                }
              })
            }
          }
        }
      }

      // If we found a selected/focused AI block, select it programmatically
      // so buildAiContext builds the perfect follow-up history context
      if (selectedAiNode && selectedAiPos !== null) {
        currentEditor.commands.setNodeSelection(selectedAiPos)
      }
    }

    // 2. Build context
    ctx = precomputedCtx || window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', lastSyncedBody, currentUuid)
    refId = (ctx && ctx.blockRef) || 'doc'

    var blockType = type === 'explain' ? 'EXPLAIN' : 'ASK'

    // 3. Compute wysiwyg insertion position (Go inserts server-side; client mirrors after response)
    if (currentMode !== 'markdown' && currentEditor) {
      insertPos = currentEditor.state.selection.to

      if (selectedAiNode && selectedAiPos !== null) {
        insertPos = selectedAiPos + selectedAiNode.nodeSize
      } else {
        var resolved = currentEditor.state.doc.resolve(insertPos)
        for (var depth = resolved.depth; depth > 0; depth--) {
          var n = resolved.node(depth)
          if (n.type.name === 'aiBlock') {
            insertPos = resolved.after(depth)
            resolved = currentEditor.state.doc.resolve(insertPos)
            break
          }
        }
        if (resolved.depth >= 1) insertPos = resolved.after(1)

        // Context anchor override
        if (ctx && ctx.blockRef && ctx.blockRef !== 'doc') {
          var chainParts = ctx.blockRef.split(',')
          var anchorId = chainParts[chainParts.length - 1]
          if (anchorId && anchorId !== 'doc') {
            currentEditor.state.doc.descendants(function (node, pos) {
              if (node.attrs.id === anchorId) {
                insertPos = pos + node.nodeSize
                return false
              }
            })
          }
        }
      }
    }

    var endpoint = type === 'explain' ? '/api/ai/explain' : '/api/ai/ask'

    flushSave().then(function () {
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content:       ctx ? ctx.content : '',
          history:       ctx ? ctx.history : '',
          question:      question || '',
          noteUUID:      currentUuid || '',
          imageBlockIds: (ctx && ctx.imageIds) || [],
          ref:           refId,
        }),
      }).then(function (r) {
        if (!r.ok) throw new Error('AI request failed: ' + r.status)
        return r.json()
      }).then(function (resp) {
        if (!resp || !resp.id) return
        var blkId = resp.id

        if (resp.fence && currentEditor && insertPos !== null) {
          // Insert from Go's canonical fence into TipTap at the pre-computed position.
          var rawYaml = resp.fence.replace(/^```ai-block\n/, '').replace(/\n```$/, '')
          var data = {}
          try { data = window.jsyaml.load(rawYaml) || {} } catch (_) {}
          currentEditor.commands.insertContentAt(insertPos, {
            type: 'aiBlock',
            attrs: {
              rawYaml:   rawYaml,
              id:        data.id || blkId,
              ref:       data.ref || refId,
              status:    'PENDING',
              type:      blockType,
              question:  question || '',
              createdAt: data.createdAt || '',
            }
          })
          var afterInsert = insertPos + 2
          var docSize = currentEditor.state.doc.content.size
          currentEditor.chain()
            .setTextSelection(Math.min(afterInsert, docSize - 1))
            .focus()
            .scrollIntoView()
            .run()
        } else if (resp.fence && currentMode === 'markdown') {
          // Markdown mode: Go saved at the canonical position — reload to reflect it.
          softReloadContent(currentUuid)
        }
        // Retry path (resp.fence === ''): block already in doc; tracking sets updated above.
      }).catch(function (err) {
        console.error('[editor] AI error', err)
      })
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
              type: 'aiBlock',
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

    // ── 2. Image paste (JS-owned) ────────────────────────────────────────────────
    // Requires browser FileReader + blob → asset upload. Cannot go through Go WS.
    var imageFile = files.find(function (f) { return f.type.startsWith('image/') })
    var imgSrc = null
    if (!imageFile && html) {
      var div = document.createElement('div')
      div.innerHTML = html
      var imgs = div.querySelectorAll('img')
      if (imgs.length === 1 && imgs[0].src) imgSrc = imgs[0].src
    }

    if (imageFile || imgSrc) {
      event.preventDefault()

      function processAsset(asset, blkId) {
        if (!asset || !asset.externalRef) return
        var mdPath = asset.externalRef
        currentEditor.commands.insertContent({
          type: 'image',
          attrs: { src: mdPath, id: blkId, detect: 'pending' }
        })
        fetch('/api/ai/describe-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid: window.__stashActiveTabUuid, path: mdPath, id: blkId })
        }).then(function(r) { return r.ok ? r.json() : null })
          .then(function(desc) {
            if (!desc) return
            currentEditor.commands.command(function(commandProps) {
              var tr = commandProps.tr
              var state = commandProps.state
              var found = false
              state.doc.descendants(function(node, pos) {
                if (node.type.name === 'image' && node.attrs.id === blkId) {
                  found = true
                  tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {
                    alt: desc.alt || '',
                    summary: desc.summary || '',
                    detect: desc.detect || 'ai'
                  }))
                  return false
                }
              })
              if (found) {
                currentEditor.view.dispatch(tr)
                var md = currentEditor.storage.markdown.getMarkdown() || ''
                lastSyncedBody = md
                wsSend({ type: 'doc-update', uuid: currentUuid, markdown: md })
                document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
              }
              return found
            })
          }).catch(function(err) {
            console.error('[editor.js] DescribeImage failed', err)
          })
      }

      if (imageFile) {
        var reader = new FileReader()
        reader.onload = function (e) {
          var dataUrl = e.target.result
          var id = 'blk-' + Math.random().toString(16).substring(2, 6)
          fetch('/api/asset/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uuid: currentUuid, id: id, dataUrl: dataUrl }),
          }).then(function (r) { return r.json() })
            .then(function (asset) { processAsset(asset, id) })
            .catch(function () {
              currentEditor.commands.insertContent({ type: 'image', attrs: { src: dataUrl } })
            })
        }
        reader.readAsDataURL(imageFile)
        return true
      }

      if (imgSrc) {
        var id = 'blk-' + Math.random().toString(16).substring(2, 6)
        if (imgSrc.startsWith('data:')) {
          fetch('/api/asset/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uuid: currentUuid, id: id, dataUrl: imgSrc }),
          }).then(function (r) { return r.json() })
            .then(function (asset) { processAsset(asset, id) })
            .catch(function() {
              currentEditor.commands.insertContent({ type: 'image', attrs: { src: imgSrc } })
            })
        } else {
          fetch('/api/asset/save-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uuid: currentUuid, url: imgSrc, id: id }),
          }).then(function(r) { return r.ok ? r.json() : null })
            .then(function(asset) {
              if (asset) { processAsset(asset, id) }
              else { currentEditor.commands.insertContent({ type: 'image', attrs: { src: imgSrc } }) }
            }).catch(function(err) {
              console.error('[editor.js] DownloadAsset failed', err)
              currentEditor.commands.insertContent({ type: 'image', attrs: { src: imgSrc } })
            })
        }
        return true
      }
    }

    // ── 3. Smart-paste pipeline ──────────────────────────────────────────────────
    // Collect all clipboard entries synchronously before any async gap.
    // event.preventDefault() is called immediately; on no-match the original
    // clipboard content is replayed to TipTap via insertContent.
    if (text && currentUuid && !currentUuid.startsWith('prompt:')) {
      var pasteEntries = []
      var pasteHtml = ''
      if (event.clipboardData) {
        pasteHtml = event.clipboardData.getData('text/html')
        Array.from(event.clipboardData.types || []).forEach(function (mimeType) {
          pasteEntries.push({ mimeType: mimeType, content: event.clipboardData.getData(mimeType) })
        })
      }
      sieveInsertPos = currentEditor ? currentEditor.state.selection.to : null
      event.preventDefault()

      fetch('/api/editor/smart-paste', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: currentUuid, entries: pasteEntries }),
      })
        .then(function (r) { return r.json() })
        .then(function (result) {
          if (!currentEditor) return
          if (result.matched) {
            // Handled entirely via WebSocket push. Nothing to insert here.
          } else {
            // No processor matched — clear the stashed insert position and replay original clipboard content.
            sieveInsertPos = null
            if (pasteHtml) {
              currentEditor.commands.insertContent(pasteHtml)
            } else {
              currentEditor.commands.insertContent(text)
            }
          }
        })
        .catch(function (err) {
          console.error('[editor.js] smart-paste fetch failed', err)
          sieveInsertPos = null
          if (currentEditor) currentEditor.commands.insertContent(text)
        })

      return true
    }

    return false
  }

  function initBlobInterceptor(editor, uuid) {
    var editorEl = editor.view.dom
    if (!editorEl) return function() {}

    function processImg(img) {
      var blobSrc = img.getAttribute('src') || ''
      if (!blobSrc.startsWith('blob:') && !blobSrc.startsWith('data:')) return
      if (img.__stashProcessing) return
      img.__stashProcessing = true

      var canvas = document.createElement('canvas')
      var image = new Image()
      image.onload = function() {
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        var ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(image, 0, 0)
        canvas.toBlob(function(blob) {
          if (!blob) return
          var reader = new FileReader()
          reader.onload = function(e) {
            var dataUrl = e.target.result
            var id = 'blk-' + Math.random().toString(16).substring(2, 6)
            
            fetch('/api/asset/save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ uuid: currentUuid, id: id, dataUrl: dataUrl }),
            }).then(function (r) { return r.json() })
              .then(function (asset) {
                var mdSrc = asset.externalRef
                editor.chain()
                  .command(function(props) {
                    var tr = props.tr
                    var state = props.state
                    state.doc.descendants(function(node, pos) {
                      if (node.type.name === 'image' && (node.attrs.src === blobSrc || node.attrs.src === img.src)) {
                        tr.setNodeMarkup(pos, undefined, Object.assign({}, node.attrs, { src: mdSrc, id: id, detect: 'pending' }))
                      }
                    })
                    return true
                  })
                  .run()

                fetch('/api/ai/describe-image', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ uuid: window.__stashActiveTabUuid, path: mdSrc, id: id })
                }).then(function(r) { return r.ok ? r.json() : null })
                  .then(function(desc) {
                    if (!desc || !editor) return
                    editor.commands.command(function(props) {
                      var tr = props.tr
                      var state = props.state
                      var found = false
                      state.doc.descendants(function(node, pos) {
                        if (node.type.name === 'image' && node.attrs.id === id) {
                          found = true
                          if (node.attrs.detect !== 'user') {
                            tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, { alt: desc.alt, summary: desc.summary, detect: 'ai' }))
                          }
                          return false
                        }
                      })
                      return found
                    })
                  }).catch(function(err) { console.error('[editor.js] DescribeImage failed', err) })
              }).catch(function(err) { console.error('[editor.js] blob paste save failed', err) })
          }
          reader.readAsDataURL(blob)
        }, 'image/png')
      }
      image.src = blobSrc
    }

    var observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i]
        for (var j = 0; j < mutation.addedNodes.length; j++) {
          var node = mutation.addedNodes[j]
          if (node.nodeName === 'IMG') processImg(node)
          else if (node.querySelectorAll) {
            var imgs = node.querySelectorAll('img')
            for (var k = 0; k < imgs.length; k++) processImg(imgs[k])
          }
        }
      }
    })

    observer.observe(editorEl, { childList: true, subtree: true })
    return function() { observer.disconnect() }
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
    
    if (currentEditor) { currentEditor.destroy(); currentEditor = null }
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

  document.addEventListener('sieve:ai-explain', function (e) {
    if (currentMode === 'markdown') return
    runAiJob('explain', undefined, e && e.detail && e.detail.precomputedCtx)
  })
  document.addEventListener('sieve:ai-ask', function (e) {
    if (currentMode === 'markdown') return
    ensureOverlays()
    openAskPopup(e && e.detail && e.detail.precomputedCtx)
  })
  document.addEventListener('sieve:ai-retry', function (e) {
    if (currentMode === 'markdown' || !currentEditor) return
    var details = e.detail
    if (!details || !details.id) return

    var blkId = details.id
    var type = (details.type || '').toLowerCase()
    if (type !== 'ask' && type !== 'explain') {
      type = details.question ? 'ask' : 'explain'
    }

    // 1. Immediate visual feedback: reset to PENDING with fresh timestamp
    //    (updating createdAt prevents isStale from firing before the server responds)
    var now = new Date().toISOString()
    currentEditor.commands.command(function (props) {
      var tr = props.tr
      var found = false
      props.state.doc.descendants(function (node, pos) {
        if (node.type.name === 'aiBlock' && node.attrs.id === blkId) {
          tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {
            status: 'PENDING', response: null, createdAt: now
          }))
          found = true
          return false
        }
      })
      return found
    })

    // 2. Select node so buildAiContext builds follow-up history context up to this block
    var nodePos = null
    currentEditor.state.doc.descendants(function (node, p) {
      if (node.type.name === 'aiBlock' && node.attrs.id === blkId) {
        nodePos = p
        return false
      }
    })
    if (nodePos !== null) currentEditor.commands.setNodeSelection(nodePos)

    // 3. Build context
    var ctx = window.TipTap.buildAiContext(currentEditor, false, lastSyncedBody, currentUuid)

    var endpoint = type === 'explain' ? '/api/ai/explain' : '/api/ai/ask'
    flushSave().then(function () {
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id:            blkId,
          content:       ctx ? ctx.content : '',
          history:       ctx ? ctx.history : '',
          question:      details.question || '',
          noteUUID:      currentUuid || '',
          imageBlockIds: (ctx && ctx.imageIds) || [],
        }),
      }).then(function (r) {
        if (!r.ok) throw new Error('AI retry request failed: ' + r.status)
        // SSE will fire sse:ai:block-resolved → softReloadContent
      }).catch(function (err) {
        console.error('[editor] AI retry error', err)
        if (currentEditor) {
          currentEditor.commands.command(function (props) {
            var tr = props.tr
            var found = false
            props.state.doc.descendants(function (node, pos) {
              if (node.type.name === 'aiBlock' && node.attrs.id === blkId) {
                tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, { status: 'TIMEOUT' }))
                found = true
                return false
              }
            })
            return found
          })
        }
      })
    })
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
  })

  window.sieveInitEditor = initEditor

})()
