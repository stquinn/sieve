// editor.js — vanilla JS TipTap island. Loaded once; re-initialized per tab switch.
// Depends on window.TipTap (ui/static/vendor/tiptap.js).

(function () {
  'use strict'

  var currentEditor = null
  var currentUuid = ''
  var currentMountEl = null
  var currentMode = 'wysiwyg'
  var tabModes = {}
  var saveTimer = null
  var lastSyncedBody = ''
  var aiReloadInProgress = false
  var currentMarkdownTextarea = null
  var showAiBlocks = true
  var blobInterceptorCleanup = null
  var searchOverlay = null

  var askDialog = null
  var internalizeDialog = null

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
      console.log('[editor.js] prompts:changed - reloading current prompt editor:', currentUuid);
      initEditor(currentMountEl, currentUuid, currentMode);
    }
  });

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
    var lowlight = T.createLowlight(T.common)

    var editor = new T.Editor({
      element: el,
      extensions: [
        T.StarterKit.configure({ link: false, codeBlock: false, history: { depth: 10000, newGroupDelay: 500 } }),
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
        T.AiBlockLegacy,
        T.WebClip,
        T.SmartLink,
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
          if (event.key === 'W' && window.isMod(event) && event.shiftKey) {
            event.preventDefault()
            ensureOverlays()
            openInternalizeDialog()
            return true
          }
          return false
        },
      },
      onUpdate: function (p) {
        var md = p.editor.storage.markdown.getMarkdown() || ''
        if (md === lastSyncedBody) return
        lastSyncedBody = md
        document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
        scheduleSave(uuid, md)
        document.dispatchEvent(new CustomEvent('editor:changed'))
        dispatchStats()
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

  function openAskPopup() {
    if (!askDialog) return
    // Build context NOW while editor still has focus and selection intact.
    // showModal() will steal DOM focus which can collapse the browser selection.
    pendingAskCtx = window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', lastSyncedBody, currentUuid)
    var label = askDialog.querySelector('.ask-popup__label')
    var textarea = askDialog.querySelector('.ask-popup__input')
    var ctxLabel = (pendingAskCtx && pendingAskCtx.contextLabel) || ''
    var fileLabel = 'Document' // UUID based label could be added if needed, but for now 'Document' is safer without path
    label.textContent = (ctxLabel && ctxLabel !== 'Document' ? ctxLabel + ' — ' + fileLabel : fileLabel) + ' Inquiry'
    textarea.value = ''
    askDialog.showModal()
    textarea.focus()
  }

  // ── Internalize dialog ────────────────────────────────────────────────────────

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

    var footer = document.createElement('div'); footer.className = 'ask-popup__footer'
    var fetchBtn = makeBtn('internalize-popup__btn', 'Fetch', function () {
      var url = urlInput.value.trim()
      if (url) { doInternalize(url, 'fetch'); dialog.close() }
    })
    var summariseBtn = makeBtn('internalize-popup__btn', 'Summarise', function () {
      var url = urlInput.value.trim()
      if (url) { doInternalize(url, 'summarise'); dialog.close() }
    })
    footer.appendChild(fetchBtn); footer.appendChild(summariseBtn)

    urlInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); dialog.close() }
      if (e.key === 'Enter') { e.preventDefault(); var url = urlInput.value.trim(); if (url) { doInternalize(url, 'fetch'); dialog.close() } }
    })

    dialog.appendChild(header)
    dialog.appendChild(urlInput)
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

    fetch('/api/internalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: currentUuid, source: source, mode: mode })
    }).then(function (r) {
      if (!r.ok) { console.error('[editor] internalize request failed: ' + r.status); return }
      return r.json()
    }).then(function (resp) {
      if (!resp || !resp.id) return
      // Go has already appended the PENDING block to the document on disk.
      // Insert it into the live editor from Go's canonical fence text.
      if (currentMode === 'markdown' && currentMarkdownTextarea) {
        lastSyncedBody = lastSyncedBody + '\n\n' + resp.fence + '\n'
        currentMarkdownTextarea.value = lastSyncedBody
      } else if (currentEditor) {
        // Parse Go's YAML to extract attrs — reading only, never generating.
        var data = {}
        try { data = window.jsyaml.load(resp.fence.replace(/^```web-clip\n/, '').replace(/\n```$/, '')) || {} } catch (_) {}
        currentEditor.commands.insertContent({
          type: 'webClip',
          attrs: {
            rawYaml: resp.fence.replace(/^```web-clip\n/, '').replace(/\n```$/, ''),
            id: data.id || resp.id, source: data.source || source,
            mode: data.mode || mode, status: 'PENDING', createdAt: data.createdAt || ''
          }
        })
        var afterPos = currentEditor.state.selection.to
        var docSize = currentEditor.state.doc.content.size
        currentEditor.chain().setTextSelection(Math.min(afterPos + 1, docSize - 1)).focus().scrollIntoView().run()
      }
    }).catch(function (err) {
      console.error('[editor] internalize error', err)
    })
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
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
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

  // HTMX SSE extension dispatches sse:ai:block-resolved; e.detail is the SSE MessageEvent.
  // The payload includes full block attrs so we can patch TipTap in-place, avoiding a
  // server round-trip and the race where an in-flight auto-save (PENDING body) overwrites
  // the COMPLETE body between ResolveAiBlock saving and softReloadContent fetching.
  document.addEventListener('sse:ai:block-resolved', function (e) {
    var raw = e.detail && e.detail.data != null ? e.detail.data : (typeof e.detail === 'string' ? e.detail : null)
    if (!raw) return
    var data; try { data = JSON.parse(raw) } catch (_) { return }
    if (!data || data.uuid !== currentUuid) return

    // Patch the TipTap node in-place when the SSE carries full block attrs.
    if (data.blkId && data.status && currentEditor) {
      var patched = false
      currentEditor.commands.command(function (props) {
        var tr = props.tr
        props.state.doc.descendants(function (node, pos) {
          if (node.type.name === 'aiBlock' && node.attrs.id === data.blkId) {
            tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {
              status:      data.status,
              response:    data.response   || node.attrs.response,
              model:       data.model      || node.attrs.model,
              completedAt: data.completedAt || node.attrs.completedAt,
            }))
            patched = true
            return false
          }
        })
        return patched
      })

      if (patched) {
        // Capture the COMPLETE markdown body and immediately persist it.
        // This ensures any in-flight auto-save (with stale PENDING body) is
        // followed by a COMPLETE save, and lastSyncedBody is up-to-date so
        // the 30s auto-save timer no longer holds a stale PENDING body.
        var completeMd = currentEditor.storage.markdown.getMarkdown() || ''
        lastSyncedBody = completeMd
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
        doSave(currentUuid, completeMd)
        return
      }
    }

    // Fallback: full reload from server (legacy path, or if TipTap patch failed).
    softReloadContent(currentUuid)
  })

  document.addEventListener('sse:ai:web-clip-resolved', function (e) {
    var raw = e.detail && e.detail.data != null ? e.detail.data : (typeof e.detail === 'string' ? e.detail : null)
    if (!raw) return
    var data; try { data = JSON.parse(raw) } catch (_) { return }
    if (!data || data.uuid !== currentUuid) return
    // web-clip uses rawYaml passthrough — in-place patch can't update rawYaml correctly.
    // Go has already written the canonical YAML to disk; reload from there.
    softReloadContent(currentUuid)
  })

  function runAiJob(type, question, precomputedCtx) {
    if (!currentEditor && currentMode !== 'markdown') return

    var blkId = 'ai-' + Math.random().toString(16).substring(2, 6)
    var ctx = null
    var refId = 'doc'
    var now = new Date().toISOString()

    var selectedAiNode = null
    var selectedAiPos = null

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

    // 3. Perform insert or follow-up insertion
    if (currentMode === 'markdown') {
      var lines = ['```ai-block', 'id: ' + blkId, 'ref: ' + refId, 'status: PENDING', 'type: ' + blockType, 'createdAt: ' + now]
      if (question) lines.push('question: ' + question)
      lines.push('```')
      var newFence = lines.join('\n')

      if (selectedAiNode && currentMarkdownTextarea) {
        var ta = currentMarkdownTextarea
        var val = ta.value
        var selStart = ta.selectionStart
        var beforeSel = val.substring(0, selStart)
        var lastFenceStart = beforeSel.lastIndexOf('```ai-block')
        var closeFenceIdx = val.indexOf('```', lastFenceStart + 11)
        
        // Insert directly after this block's fence
        var insertPos = closeFenceIdx + 3
        lastSyncedBody = val.substring(0, insertPos) + '\n\n' + newFence + val.substring(insertPos)
        ta.value = lastSyncedBody
      } else {
        lastSyncedBody = lastSyncedBody + '\n\n' + lines.join('\n') + '\n\n'
      }
      document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
      scheduleSave(currentUuid, lastSyncedBody)
    } else {
      var insertPos = currentEditor.state.selection.to

      if (selectedAiNode && selectedAiPos !== null) {
        // Follow-up: Insert directly after the selected AI block
        insertPos = selectedAiPos + selectedAiNode.nodeSize
      } else {
        // Standard placement: lift out of active aiBlocks and find block boundary
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
              if ((node.type.name === 'aiBlock' || node.type.name === 'blockRef') && node.attrs.id === anchorId) {
                insertPos = pos + node.nodeSize
                return false
              }
            })
          }
        }
      }

      currentEditor.commands.insertContentAt(insertPos, {
        type: 'aiBlock',
        attrs: { id: blkId, ref: refId, status: 'PENDING', type: blockType, question: question || '', createdAt: now },
      })

      // Move focus inside/after the new block so the editor is instantly interactive
      var afterInsert = insertPos + 2
      var docSize = currentEditor.state.doc.content.size
      currentEditor.chain()
        .setTextSelection(Math.min(afterInsert, docSize - 1))
        .focus()
        .scrollIntoView()
        .run()
    }

    // Capture the body now (includes the PENDING block) to send to Go
    var body = currentMode === 'markdown' ? lastSyncedBody : (currentEditor.storage.markdown.getMarkdown() || '')

    var endpoint = type === 'explain' ? '/api/ai/explain' : '/api/ai/ask'
    var payload = {
      content:       ctx ? ctx.content : '',
      history:       ctx ? ctx.history : '',
      question:      question || '',
      noteUUID:      currentUuid || '',
      imageBlockIds: (ctx && ctx.imageIds) || [],
      blkId:         blkId,
      body:          body,
    }

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      if (!r.ok) throw new Error('AI request failed: ' + r.status)
      // Fallback: reload from disk in case the SSE event was dropped.
      if (!aiReloadInProgress) softReloadContent(currentUuid)
    }).catch(function (err) {
      console.error('[editor] AI error', err)
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

    // AI Block paste handler
    var text = event.clipboardData.getData('text/plain')
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
                id: data.id || '',
                ref: data.ref || 'doc',
                status: data.status || 'PENDING',
                type: data.type || null,
                model: data.model || null,
                createdAt: data.createdAt || null,
                completedAt: data.completedAt || null,
                question: data.question || '',
                response: data.response || null
              }
            })
            return true
          }
        } catch (e) {
          console.error('[editor.js] Failed to parse pasted ai-block yaml', e)
        }
      }
    }

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
                scheduleSave(currentUuid, md)
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

    // Text paste heuristic
    var text = event.clipboardData.getData('text/plain')
    if (text && !currentEditor.isActive('codeBlock')) {
      var result = detectLanguage(text)
      if (result.tier <= 3) {
        event.preventDefault()
        var id = generateId()

        currentEditor.commands.insertContent({
          type: 'codeBlock',
          attrs: { language: result.language || '', id: id, detect: 'heuristic' },
          content: [{ type: 'text', text: text }]
        })

        fetch('/api/ai/refine-language', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text })
        }).then(function(r) { return r.ok ? r.text() : null })
          .then(function(lang) {
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
                document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
              }
              return found
            })
          }).catch(function(err) {
            console.error('[editor.js] RefineLanguage failed', err)
          })
        return true
      }
      if(text.startsWith("http://") || text.startsWith("https://")) {
        event.preventDefault()
        var id  = generateId("lnk")
        currentEditor.commands.insertContent({
          type: 'smartLink',
          attrs: { 
            id: id, 
            detect: 'pending',
            href: text,
            label: text // Your node uses this 'label' attribute to render its text
          }
        })
        fetch('/api/link-preview?url=' + encodeURIComponent(text))
          .then(function(r) { return r.ok ? r.text() : null })
          .then(function(title) {
            if (!title || title.trim() === '') return
            currentEditor.commands.command(function(props) {
              var tr = props.tr
              var state = props.state
              var found = false
              state.doc.descendants(function(node, pos) {
                if (node.type.name === 'smartLink' && node.attrs.id === id) {
                  found = true
                  tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, { label: title, detect: 'peek' }))
                  return false
                }
              })
              if (found) {
                currentEditor.view.dispatch(tr)
                var md = currentEditor.storage.markdown.getMarkdown() || ''
                lastSyncedBody = md
                scheduleSave(currentUuid, md)
                document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
              }
              return found
            })
          }).catch(function(err) {
            console.error('[editor.js] GetLinkTitle failed', err)
          })
        return true
      }
    }

    return false
  }

  function generateId(prefix = "blk") {
    var id = prefix + '-' + Math.random().toString(16).substring(2, 6)
    return id;
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
    doSave(currentUuid, content)
    if (currentEditor) { currentEditor.destroy(); currentEditor = null }
    currentMountEl.innerHTML = ''
    if (currentMode === 'wysiwyg') mountWysiwyg(currentMountEl, currentUuid, content)
    else mountMarkdown(currentMountEl, currentUuid, content)
    dispatchStats()
    if (window.htmx) window.htmx.ajax('GET', '/api/tabs', { target: '#htmx-tabbar', swap: 'innerHTML' })
  }

  document.addEventListener('sieve:toggle-mode',      toggleMode)
  document.addEventListener('sieve:toggle-search',    toggleSearch)
  document.addEventListener('sieve:toggle-ai-blocks', toggleAiBlocks)

  document.addEventListener('sieve:ai-explain', function () {
    if (currentMode === 'markdown') return
    runAiJob('explain')
  })
  document.addEventListener('sieve:ai-ask', function () {
    if (currentMode === 'markdown') return
    ensureOverlays()
    openAskPopup()
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

    // 1. Set status to PENDING and clear response
    currentEditor.commands.command(function (props) {
      var tr = props.tr
      var found = false
      props.state.doc.descendants(function (node, pos) {
        if (node.type.name === 'aiBlock' && node.attrs.id === blkId) {
          tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, { status: 'PENDING', response: null }))
          found = true
          return false
        }
      })
      return found
    })

    // 2. Select the node to ensure buildAiContext builds follow-up history context up to this block
    var pos = null
    currentEditor.state.doc.descendants(function (node, p) {
      if (node.type.name === 'aiBlock' && node.attrs.id === blkId) {
        pos = p
        return false
      }
    })
    if (pos !== null) {
      currentEditor.commands.setNodeSelection(pos)
    }

    // 3. Build context
    var ctx = window.TipTap.buildAiContext(currentEditor, false, lastSyncedBody, currentUuid)

    // 4. Capture the updated markdown body
    var body = currentEditor.storage.markdown.getMarkdown() || ''

    var endpoint = type === 'explain' ? '/api/ai/explain' : '/api/ai/ask'
    var payload = {
      content:       ctx ? ctx.content : '',
      history:       ctx ? ctx.history : '',
      question:      details.question || '',
      noteUUID:      currentUuid || '',
      imageBlockIds: (ctx && ctx.imageIds) || [],
      blkId:         blkId,
      body:          body,
    }

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      if (!r.ok) throw new Error('AI retry request failed: ' + r.status)
      // Fallback: reload from disk in case the SSE event was dropped.
      if (!aiReloadInProgress) softReloadContent(currentUuid)
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

  document.addEventListener('sieve:webclip-retry', function (e) {
    if (!currentEditor) return
    var detail = e.detail
    if (!detail || !detail.id) return

    var blkId = detail.id
    var now = new Date().toISOString()

    currentEditor.commands.command(function (props) {
      var tr = props.tr
      var found = false
      props.state.doc.descendants(function (node, pos) {
        if (node.type.name === 'webClip' && node.attrs.id === blkId) {
          tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {
            status: 'PENDING', content: null, error: null,
            title: null, model: null, completedAt: null, createdAt: now
          }))
          found = true
          return false
        }
      })
      return found
    })

    var body = currentEditor.storage.markdown.getMarkdown() || ''

    fetch('/api/internalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid: currentUuid,
        source: detail.source,
        mode: detail.mode,
        id: blkId,
        body: body
      })
    }).then(function (r) {
      if (!r.ok) console.error('[editor] webclip retry failed: ' + r.status)
    }).catch(function (err) {
      console.error('[editor] webclip retry error', err)
    })
  })

  // ── Helpers ───────────────────────────────────────────────────────────────────


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
    if (e.target.closest('.ai-block, .image-block, .web-clip-block')) return
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
