// editor.js — vanilla JS TipTap island. Loaded once; re-initialized per tab switch.
// Depends on window.TipTap (ui/static/vendor/tiptap.js).

(function () {
  'use strict'

  var currentEditor = null
  var currentUuid = ''
  var currentPath = ''
  var currentMode = 'wysiwyg'
  var saveTimer = null
  var lastSyncedBody = ''
  var showAiBlocks = true

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
    currentMode = mode || 'wysiwyg'

    console.log('[editor.js] initEditor fetching data for uuid:', uuid)

    fetch('/api/editor/load?uuid=' + encodeURIComponent(uuid))
      .then(function (r) { return r.json() })
      .then(function (data) {
        currentPath = data.path || ''
        window.__stashActiveTabPath = data.path || ''
        lastSyncedBody = data.body || ''

        var isMarkdown = mode === 'markdown' || data.mode === 'markdown' || uuid.startsWith('prompt:')
        ensureOverlays()

        if (isMarkdown) {
          mountMarkdown(mountEl, uuid, data.body || '')
        } else {
          mountWysiwyg(mountEl, uuid, data.body || '')
        }
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
        T.Link.configure({ openOnClick: false }),
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
        T.Markdown.configure({ html: true, transformPastedText: false }),
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
            if (!isModKey(event)) return false
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
          paste: function (_view, event) { return handleImagePaste(event) },
        },
        handleKeyDown: function (view, event) {
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
    if (currentUuid && lastSyncedBody !== null) doSave(currentUuid, lastSyncedBody)
  }

  function doSave(uuid, body) {
    fetch('/api/editor/save?uuid=' + encodeURIComponent(uuid), {
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

  function openAskPopup() {
    if (!askDialog) return
    var label = askDialog.querySelector('.ask-popup__label')
    var textarea = askDialog.querySelector('.ask-popup__input')
    label.textContent = (currentPath ? currentPath.split('/').pop() : 'Document') + ' Inquiry'
    textarea.value = ''
    askDialog.showModal()
    textarea.focus()
  }

  function doAsk(textarea, dialog) {
    var val = textarea.value.trim()
    if (val) { runAiJob('ask', val); dialog.close() }
  }

  // ── AI jobs ───────────────────────────────────────────────────────────────────

  function runAiJob(type, question) {
    var ai = window.__sieveAiService
    if (!ai) return

    var blkId = 'ai-' + Math.random().toString(16).substring(2, 6)
    var job = { docId: currentUuid, blkId: blkId }
    var ctx = window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', lastSyncedBody, currentPath)
    var lines = question ? question.split('\n') : []

    if (currentMode === 'markdown') {
      insertAiPlaceholderMarkdown(blkId, question, lines)
    } else {
      insertAiPlaceholderWysiwyg(blkId, question, lines)
    }

    var listener = {
      onComplete: function (_jobId, response) { resolveAiBlock(blkId, response, lines) },
      onError: function (_jobId, err) { console.error('[editor] AI error', err) },
    }

    if (type === 'explain') ai.explain(job, ctx, listener)
    else ai.ask(job, ctx, question || '', listener)
  }

  function insertAiPlaceholderMarkdown(blkId, question, lines) {
    var qLine = lines.length ? '***Ask:*** ' + lines[0] + '\n\n---\n\n' : ''
    var block = '\n\n[!ai] id="' + blkId + '" thinking="true"\n' + qLine + '_(thinking\u2026)_\n[!ai-end]\n\n'
    lastSyncedBody = lastSyncedBody + block
    window.sieveSetMetaDirty && window.sieveSetMetaDirty(true)
    scheduleSave(currentUuid, lastSyncedBody)
  }

  function insertAiPlaceholderWysiwyg(blkId, question, lines) {
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
    var insertPos = currentEditor.state.selection.to
    currentEditor.commands.insertContentAt(insertPos, {
      type: 'aiBlock',
      attrs: { id: blkId, thinking: true },
      content: [
        ...(qNodes.length ? [{ type: 'aiQuestion', content: qNodes }] : []),
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: '(thinking\u2026)', marks: [{ type: 'italic' }] }] },
      ],
    })
  }

  function resolveAiBlock(blkId, response, lines) {
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
        attrs: { id: blkId, thinking: false },
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

  // ── Image paste ───────────────────────────────────────────────────────────────

  function handleImagePaste(event) {
    if (!event.clipboardData || !currentEditor) return false
    var files = Array.from(event.clipboardData.files)
    var imageFile = files.find(function (f) { return f.type.startsWith('image/') })
    if (!imageFile) return false
    event.preventDefault()
    var reader = new FileReader()
    reader.onload = function (e) {
      var dataUrl = e.target.result
      var id = 'blk-' + Math.random().toString(16).substring(2, 6)
      fetch('/api/asset/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentPath, id: id, dataUrl: dataUrl }),
      }).then(function (r) { return r.json() })
        .then(function (asset) {
          currentEditor.commands.insertContent({ type: 'image', attrs: { src: asset.externalRef, id: id, detect: 'pending' } })
        })
        .catch(function () {
          currentEditor.commands.insertContent({ type: 'image', attrs: { src: dataUrl } })
        })
    }
    reader.readAsDataURL(imageFile)
    return true
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
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function isModKey(e) {
    return navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey
  }

  function makeBtn(cls, text, onClick) {
    var btn = document.createElement('button')
    btn.className = cls; btn.textContent = text
    btn.addEventListener('click', onClick)
    return btn
  }

  // ── Export ────────────────────────────────────────────────────────────────────

  window.sieveInitEditor = initEditor

})()
