// editor.js — vanilla JS TipTap island. Loaded once; re-initialized per tab switch.
// Depends on window.TipTap (ui/static/vendor/tiptap.js).

(function () {
  'use strict'

  window.__sieveAiService = {
    explain: function(job, ctx, listener) {
      fetch('/api/ai/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: ctx.content,
          history: ctx.history,
          noteUUID: currentUuid || '',
          imageStorePaths: ctx.imagePaths || []
        })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('Explain failed')
        return r.text()
      })
      .then(function(text) {
        listener.onComplete(job, text)
      })
      .catch(function(err) {
        listener.onError(job, err.message)
      })
    },
    ask: function(job, ctx, question, listener) {
      fetch('/api/ai/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: ctx.content,
          history: ctx.history,
          question: question,
          noteUUID: currentUuid || '',
          imageStorePaths: ctx.imagePaths || []
        })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('Ask failed')
        return r.text()
      })
      .then(function(text) {
        listener.onComplete(job, text)
      })
      .catch(function(err) {
        listener.onError(job, err.message)
      })
    }
  }

  var currentEditor = null
  var currentUuid = ''
  var currentPath = ''
  var currentMountEl = null
  var currentMode = 'wysiwyg'
  var tabModes = {}
  var saveTimer = null
  var lastSyncedBody = ''
  var showAiBlocks = true
  var blobInterceptorCleanup = null
  var searchOverlay = null

  // Persistent overlay elements — created once, reused across tab switches.
  var linkBubble = null
  var askDialog = null

  // ── Public entry point called from App.tsx htmx:afterSettle ─────────────────

  function initEditor(mountEl, uuid, mode) {
    console.log('[editor.js] initEditor called with uuid:', uuid, 'mode:', mode)
    if (currentEditor) {
      console.log('[editor.js] initEditor destroying old editor for uuid:', currentUuid)
      flushSave()
      currentEditor.destroy()
      currentEditor = null
    }

    if (!mountEl || !uuid) {
      console.log('[editor.js] initEditor early return due to empty mountEl or uuid')
      currentUuid = ''
      currentMode = 'wysiwyg'
      return
    }

    currentUuid = uuid
    currentMountEl = mountEl
    currentMode = mode || tabModes[uuid] || 'wysiwyg'

    console.log('[editor.js] initEditor fetching data for uuid:', uuid)

    fetch('/api/editor/load?uuid=' + encodeURIComponent(uuid))
      .then(function (r) { return r.json() })
      .then(function (data) {
        currentPath = data.path || ''
        window.__stashActiveTabPath = data.path || ''
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

  // ── WYSIWYG mode ─────────────────────────────────────────────────────────────

  function mountWysiwyg(el, uuid, body) {
    var T = window.TipTap
    var lowlight = T.createLowlight(T.common)

    var editor = new T.Editor({
      element: el,
      extensions: [
        T.StarterKit.configure({ codeBlock: false, history: { depth: 10000, newGroupDelay: 500 } }),
        T.CodeBlockWithAttrs.configure({ lowlight: lowlight }),
        T.Placeholder.configure({ placeholder: function (p) { return p.editor.isEmpty ? 'Start writing\u2026' : '' } }),
        T.BlockNode,
        T.Table.configure({ resizable: false }),
        T.TableRow,
        T.TableHeader,
        T.TableCell,
        T.ImageWithAttrs,
        T.Search,
        T.AiBlock,
        T.AiQuestion,
        T.TaskList,
        T.TaskItem.configure({ nested: true }),
        T.Markdown.configure({ html: true, transformPastedText: true, link: { openOnClick: false } }),
        T.AiShortcuts.configure({
          onExplain: function () { runAiJob('explain') },
          onAsk: function () { openAskPopup() },
          onSmartFile: function () { window.sieveSmartFile && window.sieveSmartFile(uuid) },
          onKeepAndSmartFile: function () { window.sieveKeepAndSmartFile && window.sieveKeepAndSmartFile(uuid) },
          onToggleAiBlocks: toggleAiBlocks,
        }),
      ],
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
          return false
        },
      },
      onUpdate: function (p) {
        var md = p.editor.storage.markdown.getMarkdown() || ''
        if (md === lastSyncedBody) return
        lastSyncedBody = md
        window.sieveSetMetaDirty && window.sieveSetMetaDirty(true)
        scheduleSave(uuid, md)
        document.dispatchEvent(new CustomEvent('editor:changed'))
        dispatchStats()
      },
      onSelectionUpdate: function () { updateLinkBubble() },
    })

    currentEditor = editor
    exposePublicApi()

    if (blobInterceptorCleanup) {
      blobInterceptorCleanup()
      blobInterceptorCleanup = null
    }
    blobInterceptorCleanup = initBlobInterceptor(editor, uuid)
  }

  // ── Markdown mode ─────────────────────────────────────────────────────────────

  function mountMarkdown(mountEl, uuid, body) {
    currentMode = 'markdown'

    var wrapper = document.createElement('div')
    wrapper.style.cssText = 'display:flex;flex-direction:row;height:100%;overflow:hidden;background:var(--theme-bg);position:relative'

    var gutter = document.createElement('div')
    gutter.className = 'markdown-gutter'
    gutter.style.cssText = 'width:2.75rem;padding:40px 0.6rem 0.85em;background-color:var(--theme-bgDark);border-right:1px solid var(--theme-border);color:var(--theme-muted);font-family:var(--theme-monoFont);font-size:14px;line-height:1.6;text-align:right;user-select:none;overflow:hidden'

    var textarea = document.createElement('textarea')
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
      window.sieveSetMetaDirty && window.sieveSetMetaDirty(true)
      scheduleSave(uuid, val)
      document.dispatchEvent(new CustomEvent('editor:changed'))
      updateGutter(gutter, val)
      dispatchStats()
    })
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 's' && window.isMod(e)) {
        e.preventDefault()
        flushSave()
      }
    })
    textarea.addEventListener('scroll', function () { gutter.scrollTop = textarea.scrollTop })

    wrapper.appendChild(gutter)
    wrapper.appendChild(textarea)
    mountEl.appendChild(wrapper)

    requestAnimationFrame(function () { textarea.focus() })

    exposePublicApi(textarea)
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

  function scheduleSave(uuid, body) {
    if (saveTimer) clearTimeout(saveTimer)
    var delay = (window.__sieveAutosaveMs && window.__sieveAutosaveMs()) || 30000
    saveTimer = setTimeout(function () { doSave(uuid, body) }, delay)
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    if (currentUuid) {
      var content = getMarkdown()
      return doSave(currentUuid, content)
    }
    return Promise.resolve()
  }

  function doSave(uuid, body) {
    return fetch('/api/editor/save?uuid=' + encodeURIComponent(uuid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: body }),
    }).then(function () {
      window.sieveSetMetaDirty && window.sieveSetMetaDirty(false)
      document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: uuid } }))
    }).catch(function (err) { console.error('[editor] save failed', err) })
  }

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

  // ── Link bubble ───────────────────────────────────────────────────────────────

  function ensureOverlays() {
    if (!linkBubble) linkBubble = createLinkBubble()
    if (!askDialog) askDialog = createAskDialog()
    if (!searchOverlay) searchOverlay = createSearchOverlay()
  }

  function createLinkBubble() {
    var bubble = document.createElement('div')
    bubble.className = 'link-bubble'
    bubble.style.cssText = 'position:fixed;display:none;z-index:1000;align-items:center;gap:4px'

    var input = document.createElement('input')
    input.className = 'link-bubble__input'
    input.placeholder = 'https://\u2026'

    var btnSet = makeBtn('link-bubble__btn', 'Set', function () {
      currentEditor && currentEditor.chain().focus().extendMarkRange('link').setLink({ href: input.value }).run()
    })
    var btnRemove = makeBtn('link-bubble__btn link-bubble__btn--remove', 'Remove', function () {
      currentEditor && currentEditor.chain().focus().extendMarkRange('link').unsetLink().run()
    })
    var btnOpen = makeBtn('link-bubble__btn', 'Open', function (e) {
      e.preventDefault(); e.stopPropagation()
      if (input.value) window.runtime && window.runtime.BrowserOpenURL(input.value)
    })

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); currentEditor && currentEditor.chain().focus().extendMarkRange('link').setLink({ href: input.value }).run() }
      if (e.key === 'Escape') { currentEditor && currentEditor.chain().focus().run(); bubble.style.display = 'none' }
    })
    document.addEventListener('mousedown', function (e) {
      if (bubble.style.display !== 'none' && !bubble.contains(e.target)) bubble.style.display = 'none'
    })

    bubble.appendChild(input); bubble.appendChild(btnSet); bubble.appendChild(btnRemove); bubble.appendChild(btnOpen)
    document.body.appendChild(bubble)
    return bubble
  }

  function updateLinkBubble() {
    if (!currentEditor || !linkBubble) return
    if (!currentEditor.isActive('link')) { linkBubble.style.display = 'none'; return }
    var href = currentEditor.getAttributes('link').href || ''
    linkBubble.querySelector('.link-bubble__input').value = href
    var from = currentEditor.state.selection.from
    var coords = currentEditor.view.coordsAtPos(from)
    linkBubble.style.display = 'flex'
    linkBubble.style.left = coords.left + 'px'
    linkBubble.style.top = (coords.bottom + 4) + 'px'
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

  function openAskPopup() {
    if (!askDialog) return
    // Build context NOW while editor still has focus and selection intact.
    // showModal() will steal DOM focus which can collapse the browser selection.
    pendingAskCtx = window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', lastSyncedBody, currentPath)
    var label = askDialog.querySelector('.ask-popup__label')
    var textarea = askDialog.querySelector('.ask-popup__input')
    var ctxLabel = (pendingAskCtx && pendingAskCtx.contextLabel) || ''
    var fileLabel = currentPath ? currentPath.split('/').pop() : 'Document'
    label.textContent = (ctxLabel && ctxLabel !== 'Document' ? ctxLabel + ' — ' + fileLabel : fileLabel) + ' Inquiry'
    textarea.value = ''
    askDialog.showModal()
    textarea.focus()
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

  function runAiJob(type, question, precomputedCtx) {
    var ai = window.__sieveAiService
    if (!ai) return

    var blkId = 'ai-' + Math.random().toString(16).substring(2, 6)
    var job = { docId: currentUuid, blkId: blkId }
    var ctx = precomputedCtx || window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', lastSyncedBody, currentPath)
    var lines = question ? question.split('\n') : []

    // Resolve insert position AFTER buildAiContext, which may have wrapped the selection
    // in a new blockRef node via tr.wrap(). If so, selection.to lands inside that node;
    // we must insert the aiBlock AFTER the blockRef, not inside it.
    var insertPos = currentEditor ? currentEditor.state.selection.to : 0
    if (currentEditor) {
      let resolved = currentEditor.state.doc.resolve(insertPos)
      for (let depth = resolved.depth; depth > 0; depth--) {
        let node = resolved.node(depth)
        if (node.type.name === 'aiBlock') {
          insertPos = resolved.after(depth)
          resolved = currentEditor.state.doc.resolve(insertPos)
          break
        }
      }
      if (resolved.depth >= 1) {
        insertPos = resolved.after(1)
      }
    }

    if (ctx && ctx.blockRef && ctx.blockRef !== 'doc' && !ctx.blockRef.includes(',') && currentEditor) {
      currentEditor.state.doc.descendants(function (node, pos) {
        if (node.type.name === 'blockRef' && node.attrs.id === ctx.blockRef) {
          insertPos = pos + node.nodeSize
          return false
        }
      })
    }

    var refId = (ctx && ctx.blockRef) || 'doc'

    if (currentMode === 'markdown') {
      insertAiPlaceholderMarkdown(blkId, refId, question, lines)
    } else {
      insertAiPlaceholderWysiwyg(blkId, refId, question, lines, insertPos)
    }

    var listener = {
      onComplete: function (_jobId, response) { resolveAiBlock(blkId, refId, response, lines) },
      onError: function (_jobId, err) { console.error('[editor] AI error', err) },
    }

    if (type === 'explain') ai.explain(job, ctx, listener)
    else ai.ask(job, ctx, question || '', listener)
  }

  function insertAiPlaceholderMarkdown(blkId, ref, question, lines) {
    var qLine = lines.length ? '***Ask:*** ' + lines[0] + '\n\n---\n\n' : ''
    var block = '\n\n[!ai] id="' + blkId + '" ref="' + ref + '" thinking="true"\n' + qLine + '_(thinking\u2026)_\n[!ai-end]\n\n'
    lastSyncedBody = lastSyncedBody + block
    window.sieveSetMetaDirty && window.sieveSetMetaDirty(true)
    scheduleSave(currentUuid, lastSyncedBody)
  }

  function insertAiPlaceholderWysiwyg(blkId, ref, question, lines, insertPos) {
    if (!currentEditor) return
    var qNodes = lines.map(function (l, i) {
      return {
        type: 'paragraph',
        content: l.trim() ? [
          i === 0 ? { type: 'text', text: 'Ask: ', marks: [{ type: 'bold' }, { type: 'italic' }] } : null,
          { type: 'text', text: i === 0 && l.startsWith('Ask: ') ? l.substring(5) : l },
        ].filter(Boolean) : []
      }
    })
    if (insertPos === undefined) insertPos = currentEditor.state.selection.to
    currentEditor.commands.insertContentAt(insertPos, {
      type: 'aiBlock',
      attrs: { id: blkId, ref: ref, thinking: true },
      content: [
        ...(qNodes.length ? [{ type: 'aiQuestion', content: qNodes }] : []),
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: '(thinking\u2026)', marks: [{ type: 'italic' }] }] },
      ],
    })
  }

  function resolveAiBlock(blkId, ref, response, lines) {
    if (currentMode === 'markdown') {
      var escaped = blkId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      var pattern = new RegExp('(\\[!ai\\] id="' + escaped + '"[^\\n]*)\\s*[\\s\\S]*?\\s*\\[!ai-end\\]')
      var replacement = '$1\n\n' + (lines.length ? '***Ask:*** ' + lines[0] + '\n\n---\n\n' : '') + response + '\n\n[!ai-end]'
      lastSyncedBody = lastSyncedBody.replace(pattern, replacement.replace(/\s*thinking="true"/, ''))
      scheduleSave(currentUuid, lastSyncedBody)
    } else if (currentEditor) {
      var foundPos = -1, foundSize = 0
      currentEditor.state.doc.descendants(function (node, pos) {
        if (node.type.name === 'aiBlock' && node.attrs.id === blkId) { foundPos = pos; foundSize = node.nodeSize; return false }
      })
      if (foundPos === -1) return
      var md = currentEditor.storage.markdown
      var html = md.parser.md.render(response.trim())
      var tmp = document.createElement('div'); tmp.innerHTML = html
      var parsed = window.TipTap.ProseMirrorDOMParser.fromSchema(currentEditor.schema).parse(tmp)
      currentEditor.commands.insertContentAt({ from: foundPos, to: foundPos + foundSize }, {
        type: 'aiBlock',
        attrs: { id: blkId, ref: ref, thinking: false },
        content: [
          ...(lines.length ? [{ type: 'aiQuestion', content: lines.map(function (l, i) { return { type: 'paragraph', content: l.trim() ? [i === 0 ? { type: 'text', text: 'Ask: ', marks: [{ type: 'bold' }, { type: 'italic' }] } : null, { type: 'text', text: l }].filter(Boolean) : [] } }) }] : []),
          { type: 'horizontalRule' },
          ...parsed.toJSON().content,
        ],
      })
    }
  }

  function toggleAiBlocks() {
    showAiBlocks = !showAiBlocks
    var panel = document.querySelector('.editor-panel')
    if (panel) panel.classList.toggle('hide-ai-blocks', !showAiBlocks)
  }

  function handleSmartPaste(event) {
    if (!event.clipboardData || !currentEditor) return false

    var html = event.clipboardData.getData('text/html')
    var files = Array.from(event.clipboardData.files)
    var imageFile = files.find(function (f) { return f.type.startsWith('image/') })

    var imgSrc = null
    if (!imageFile && html) {
      var div = document.createElement('div')
      div.innerHTML = html
      var imgs = div.querySelectorAll('img')
      if (imgs.length === 1 && imgs[0].src) {
        imgSrc = imgs[0].src
      }
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

        if (window.go && window.go.main && window.go.main.App && window.go.main.App.DescribeImage) {
          window.go.main.App.DescribeImage(mdPath).then(function(desc) {
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
                scheduleSave(currentUuid, md)
                window.sieveSetMetaDirty && window.sieveSetMetaDirty(true)
              }
              return found
            })
          }).catch(function(err) {
            console.error('[editor.js] DescribeImage failed', err)
          })
        }
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
            .then(function (asset) {
              processAsset(asset, id)
            })
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
            .then(function (asset) {
              processAsset(asset, id)
            })
            .catch(function() {
              currentEditor.commands.insertContent({ type: 'image', attrs: { src: imgSrc } })
            })
        } else if (window.go && window.go.main && window.go.main.App && window.go.main.App.DownloadAsset) {
          window.go.main.App.DownloadAsset(currentUuid, imgSrc, id).then(function(asset) {
            processAsset(asset, id)
          }).catch(function(err) {
            console.error('[editor.js] DownloadAsset failed', err)
            currentEditor.commands.insertContent({ type: 'image', attrs: { src: imgSrc } })
          })
        } else {
          currentEditor.commands.insertContent({ type: 'image', attrs: { src: imgSrc } })
        }
        return true
      }
    }

    // Text paste heuristic
    var text = event.clipboardData.getData('text/plain')
    if (text && !currentEditor.isActive('codeBlock')) {
      var result = detectLanguage(text)
      if (result.tier <= 3) {
        event.preventDefault()
        var id = 'blk-' + Math.random().toString(16).substring(2, 6)

        currentEditor.commands.insertContent({
          type: 'codeBlock',
          attrs: { language: result.language || '', id: id, detect: 'heuristic' },
          content: [{ type: 'text', text: text }]
        })

        if (window.go && window.go.main && window.go.main.App && window.go.main.App.RefineLanguage) {
          window.go.main.App.RefineLanguage(text).then(function(lang) {
            if (!lang) return
            currentEditor.commands.command(function(props) {
              var tr = props.tr
              var state = props.state
              var found = false
              state.doc.descendants(function(node, pos) {
                if (node.type.name === 'codeBlock' && node.attrs.id === id) {
                  found = true
                  tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, { language: lang, detect: 'ai' }))
                  return false
                }
              })
              if (found) {
                currentEditor.view.dispatch(tr)
                var md = currentEditor.storage.markdown.getMarkdown() || ''
                lastSyncedBody = md
                scheduleSave(currentUuid, md)
                window.sieveSetMetaDirty && window.sieveSetMetaDirty(true)
              }
              return found
            })
          }).catch(function(err) {
            console.error('[editor.js] RefineLanguage failed', err)
          })
        }
        return true
      }
    }

    return false
  }

  function detectLanguage(text) {
    var trimmed = text.trim()
    if (!trimmed) return { tier: 4 }

    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try { JSON.parse(trimmed); return { tier: 1, language: 'json' } } catch(e) {}
    }

    var YAML_K8S = /^apiVersion:\s*\S+[\s\S]+^kind:\s*[A-Za-z]+/m
    if (YAML_K8S.test(trimmed)) return { tier: 1, language: 'yaml' }
    
    function scoreYaml(txt) {
      var lines = txt.split('\n').filter(function(l) { return l.trim() && !l.trim().startsWith('#') })
      if (lines.length === 0) return 0
      var kvLines = lines.filter(function(l) { return /^\s*[\w.-]+:\s*/.test(l) }).length
      var listLines = lines.filter(function(l) { return /^\s*-\s+/.test(l) }).length
      return (kvLines + listLines) / lines.length
    }
    
    var yamlScore = scoreYaml(trimmed)
    if (yamlScore >= 0.75 && trimmed.split('\n').length >= 3) {
      return { tier: yamlScore >= 0.9 ? 1 : 2, language: 'yaml' }
    }

    var GO_T1 = [
      /^package\s+\w+/m,
      /^type\s+\w+\s+struct\s*\{/m,
      /^type\s+\w+\s+interface\s*\{/m,
      /`(?:json|yaml|xml|db|bson|form|mapstructure|validate):"[^"]*"`/,
      /^import\s+\(/m,
      /^import\s+"/m,
    ]
    if (GO_T1.some(function(re) { return re.test(trimmed) })) return { tier: 1, language: 'go' }

    var JAVA_T1 = [
      /^public\s+(?:class|interface|enum|abstract\s+class)\s+\w+/m,
      /^private\s+(?:class|interface|enum)\s+\w+/m,
      /^protected\s+(?:class|interface)\s+\w+/m,
      /\bpublic\s+static\s+void\s+main\s*\(\s*String/,
      /^import\s+java\./m,
      /^import\s+org\.\w+\.\w+/m,
      /^import\s+com\.\w+\.\w+/m,
    ]
    if (JAVA_T1.some(function(re) { return re.test(trimmed) })) return { tier: 1, language: 'java' }

    var DART_T1 = [
      /^import\s+'package:flutter\//m,
      /^import\s+'dart:/m,
      /\bextends\s+(?:StatefulWidget|StatelessWidget|State)\b/,
      /Widget\s+build\s*\(\s*BuildContext/,
      /\brunApp\s*\(/,
    ]
    if (DART_T1.some(function(re) { return re.test(trimmed) })) return { tier: 1, language: 'dart' }

    var GO_T2 = [
      /\bfunc\s+\(\s*\w+\s+\*?\w+\s*\)\s+\w+\s*\(/,
      /\bfunc\s+\w+\s*\(/,
      /:=\s/,
      /^var\s+\w+\s+\w+/m,
      /^const\s+\w+/m,
      /\bfmt\.\w+\(/,
      /\berr\s*!=\s*nil\b/,
    ]
    var goT2Hits = GO_T2.filter(function(re) { return re.test(trimmed) }).length
    if (goT2Hits >= 2) return { tier: 2, language: 'go' }

    var JAVA_T2 = [
      /@(?:Override|SpringBootApplication|Component|Service|Repository|Controller|Autowired|Bean|Test)\b/,
      /\bthrows\s+\w+(?:Exception|Error)\b/,
      /\bextends\s+\w+\b/,
      /\bimplements\s+\w+\b/,
      /\bSystem\.out\.print/,
      /new\s+\w+\(.*\);/,
      /\b(?:String|int|long|double|float|boolean|void|List|Map|Set)\s+\w+\s*=/,
    ]
    var javaT2Hits = JAVA_T2.filter(function(re) { return re.test(trimmed) }).length
    if (javaT2Hits >= 2) return { tier: 2, language: 'java' }

    var DART_T2 = [
      /^import\s+'package:/m,
      /\bScaffold\s*\(/,
      /\bContainer\s*\(/,
      /\bColumn\s*\(\s*children:/,
      /\bRow\s*\(\s*children:/,
      /@override\b/,
      /\bconst\s+\w+\s*\(/,
      /\bfinal\s+\w+\s+\w+\s*=/,
    ]
    var dartT2Hits = DART_T2.filter(function(re) { return re.test(trimmed) }).length
    if (dartT2Hits >= 2) return { tier: 2, language: 'dart' }

    if (/^(?:export\s+)?interface\s+\w+/m.test(trimmed) || /^(?:export\s+)?type\s+\w+\s*=/m.test(trimmed)) {
      return { tier: 2, language: 'typescript' }
    }
    if (trimmed.includes('import ') && trimmed.includes('from ') && trimmed.includes('const ')) {
      return { tier: 2, language: 'typescript' }
    }
    if ((trimmed.includes('function(') || trimmed.includes('=>')) && trimmed.includes('const ')) {
      return { tier: 2, language: 'javascript' }
    }

    if (/^#!/.test(trimmed) && /bash|sh|zsh/i.test(trimmed.split('\n')[0])) {
      return { tier: 1, language: 'bash' }
    }

    if (/^SELECT\s/i.test(trimmed) && /\bFROM\b/i.test(trimmed)) {
      return { tier: 1, language: 'sql' }
    }

    if (trimmed.includes('def ') && trimmed.includes('self')) return { tier: 1, language: 'python' }

    var lines = trimmed.split('\n')
    var braceCount = (trimmed.match(/[{}]/g) || []).length
    var semicolonCount = (trimmed.match(/;/g) || []).length
    var indentedLines = lines.filter(function(l) { return /^[ \t]{2,}/.test(l) }).length
    var anyWeakSignal = goT2Hits >= 1 || javaT2Hits >= 1 || dartT2Hits >= 1
    if (lines.length > 2 && (braceCount > 2 || semicolonCount > 2 || anyWeakSignal || indentedLines > lines.length * 0.4)) {
      return { tier: 3 }
    }

    return { tier: 4 }
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

                if (window.go && window.go.main && window.go.main.App && window.go.main.App.DescribeImage) {
                  window.go.main.App.DescribeImage(mdSrc).then(function(desc) {
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
                }
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

  // ── Public API ────────────────────────────────────────────────────────────────

  function exposePublicApi(textarea) {
    window.sieveEditor = {
      setSearchTerm: function (term) { currentEditor && currentEditor.commands.setSearchTerm(term) },
      clearSearch: function () { currentEditor && currentEditor.commands.clearSearch() },
      setContent: function (content) {
        if (currentMode === 'markdown' && textarea) {
          textarea.value = content
          lastSyncedBody = content
        } else if (currentEditor) {
          currentEditor.commands.setContent(content)
          lastSyncedBody = content
        }
      },
      save: flushSave,
      toggleSearch: function() {
        if (!searchOverlay) ensureOverlays()
        if (searchOverlay.style.display === 'none') {
            searchOverlay.style.display = 'flex'
            var input = searchOverlay.querySelector('input')
            if (input) {
                input.focus()
                input.select()
            }
        } else {
            searchOverlay.style.display = 'none'
            if (currentEditor) currentEditor.commands.clearSearch()
        }
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────


  function makeBtn(cls, text, onClick) {
    var btn = document.createElement('button')
    btn.className = cls; btn.textContent = text
    btn.addEventListener('click', onClick)
    return btn
  }

  window.sieveSave = flushSave

  window.sieveToggleMode = function() {
    console.log('[editor.js] sieveToggleMode called. currentMode:', currentMode)
    if (!currentUuid || !currentMountEl) return
    
    var content = ''
    if (currentMode === 'markdown') {
      var textarea = currentMountEl.querySelector('.markdown-editor')
      if (textarea) content = textarea.value
    } else if (currentEditor) {
      content = currentEditor.storage.markdown.getMarkdown() || ''
    } else {
      content = lastSyncedBody
    }
    
    lastSyncedBody = content
    flushSave()
    
    if (currentMode === 'wysiwyg' && currentEditor) {
      currentEditor.destroy()
      currentEditor = null
    }
    
    currentMountEl.innerHTML = ''
    
    if (currentMode === 'markdown') {
      currentMode = 'wysiwyg'
      mountWysiwyg(currentMountEl, currentUuid, content)
    } else {
      currentMode = 'markdown'
      mountMarkdown(currentMountEl, currentUuid, content)
    }
    
    tabModes[currentUuid] = currentMode
    dispatchStats()
  }

  // ── Export ────────────────────────────────────────────────────────────────────

  window.sieveInitEditor = initEditor

})()
