// context-menu.js — single source of truth for all context menus.
// Components fire 'sieve:contextmenu' with { x, y, context } in the detail.
// context.type must be one of: 'editor' | 'image' | 'aiBlock' | 'note' | 'folder' | 'prompt'
;(function () {
  'use strict'

  // ── Icons ───────────────────────────────────────────────────────────────────
  function svg(body) {
    return '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">' + body + '</svg>'
  }
  var IC = {
    copy:        svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    cut:         svg('<circle cx="6" cy="20" r="2"/><circle cx="6" cy="4" r="2"/><line x1="6" y1="6" x2="6" y2="18"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'),
    paste:       svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>'),
    trash:       svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>'),
    selectAll:   svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6"/><path d="M9 12h6"/><path d="M9 15h6"/>'),
    sparkle:     svg('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.937A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>'),
    promote:     svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
    info:        svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
    refresh:     svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><polyline points="3 3 3 8 8 8"/>'),
    smartFile:   svg('<path d="M4.5 16.5c-1.5 1.5-1.5 3 0 3s3-1.5 3-3L19.5 4.5"/><path d="m19.5 4.5-3 3"/>'),
    smartMeta:   svg('<path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 8v4l3 3"/><circle cx="18" cy="6" r="3"/>'),
    keep:        svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
    markTrash:   svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
    clearIntent: svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.78"/>'),
    edit:        svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
    folder:      svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    close:       svg('<path d="M18 6L6 18"/><path d="M6 6l12 12"/>'),
    closeAll:    svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>'),
    externalLink: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
    code:         svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  }

  // ── Renderer ────────────────────────────────────────────────────────────────
  function render(x, y, items) {
    var existing = document.getElementById('sieve-context-menu')
    if (existing) existing.remove()

    var menu = document.createElement('div')
    menu.id = 'sieve-context-menu'
    menu.className = 'sieve-context-menu'
    menu.style.left = x + 'px'
    menu.style.top = y + 'px'

    items.forEach(function (item) {
      if (item.type === 'header') {
        var hdr = document.createElement('div')
        hdr.className = 'ctx-header'
        hdr.textContent = item.label
        menu.appendChild(hdr)
      } else if (item.type === 'divider') {
        var sep = document.createElement('div')
        sep.className = 'ctx-separator'
        menu.appendChild(sep)
      } else {
        var btn = document.createElement('button')
        btn.className = 'ctx-item' + (item.cls ? ' ' + item.cls : '') + (item.disabled ? ' ctx-item--disabled' : '')
        if (item.disabled) btn.setAttribute('disabled', '')
        if (item.icon) {
          var wrap = document.createElement('span')
          wrap.innerHTML = item.icon
          btn.appendChild(wrap)
        }
        var lbl = document.createElement('span')
        lbl.textContent = item.label
        btn.appendChild(lbl)
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation()
          menu.remove()
          if (typeof item.action === 'function') item.action()
        })
        menu.appendChild(btn)
      }
    })

    document.body.appendChild(menu)

    requestAnimationFrame(function () {
      var r = menu.getBoundingClientRect()
      if (r.right > window.innerWidth - 8)
        menu.style.left = (window.innerWidth - r.width - 8) + 'px'
      if (r.bottom > window.innerHeight - 8)
        menu.style.top = (window.innerHeight - r.height - 8) + 'px'
    })
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function hx(method, url, opts) {
    return window.htmx.ajax(method, url, opts || {})
  }

  function closeMenu() {
    var menu = document.getElementById('sieve-context-menu')
    if (menu) menu.remove()
  }

  function tabItems(id) {
    return [
      { type: 'divider' },
      { icon: IC.close, label: 'Close Tab', action: function () {
        hx('POST', '/api/tabs/close/' + encodeURIComponent(id), { target: '#htmx-tabbar', swap: 'innerHTML' })
      }},
      { icon: IC.closeAll, label: 'Close All Tabs', action: function () {
        hx('POST', '/api/tabs/closeAll', { target: '#htmx-tabbar', swap: 'innerHTML' })
      }},
    ]
  }

  // ── Editor: text / code block / table ────────────────────────────────────────
  function buildEditorItems(ctx) {
    var editor = ctx.editor
    var state = editor.state
    var sel = state.selection
    var hasSelection = !sel.empty

    var targetNode = null
    var doc = state.doc
    var from = sel.from, to = sel.to
    var scanFrom = (from === to) ? Math.max(0, from - 1) : from
    var scanTo   = (from === to) ? Math.min(doc.content.size, to + 1) : to
    doc.nodesBetween(scanFrom, scanTo, function (node) {
      if (!targetNode && (node.type.name === 'image' || node.type.name === 'codeBlock' || node.type.name === 'table')) {
        targetNode = node
        return false
      }
    })

    var items = []

    if (hasSelection) {
      items.push({ icon: IC.copy, label: 'Copy', action: function () {
        var s = editor.state
        var text = s.doc.textBetween(s.selection.from, s.selection.to, '\n')
        if (text) navigator.clipboard.writeText(text).catch(console.error)
      }})
      items.push({ icon: IC.cut, label: 'Cut', action: function () {
        var s = editor.state
        var text = s.doc.textBetween(s.selection.from, s.selection.to, '\n')
        if (text) navigator.clipboard.writeText(text).then(function () {
          editor.commands.deleteSelection()
          editor.commands.focus()
        }).catch(console.error)
      }})
    }

    items.push({ icon: IC.paste, label: 'Paste', action: function () {
      editor.commands.focus()
      navigator.clipboard.readText().then(function (text) {
        if (!text) return
        if (text.trim().startsWith('```ai-block')) {
          var clean = text.trim()
          var nl = clean.indexOf('\n')
          var end = clean.lastIndexOf('```')
          if (nl !== -1 && end !== -1 && end > nl) {
            try {
              var data = window.jsyaml.load(clean.substring(nl + 1, end).trim())
              if (data && data.id) {
                editor.commands.insertContent({ type: 'aiBlock', attrs: {
                  id: data.id || '', ref: data.ref || 'doc', status: data.status || 'PENDING',
                  type: data.type || null, model: data.model || null,
                  createdAt: data.createdAt || null, completedAt: data.completedAt || null,
                  question: data.question || '', response: data.response || null
                }})
                return
              }
            } catch (err) { console.error('[context-menu] paste: failed to parse ai-block', err) }
          }
        }
        editor.commands.insertContent(text)
      }).catch(function (err) {
        console.error('[context-menu] clipboard read failed, falling back to execCommand', err)
        editor.commands.focus()
        document.execCommand('paste')
      })
    }})

    if (hasSelection) {
      items.push({ icon: IC.trash, label: 'Delete', action: function () {
        editor.commands.deleteSelection()
      }})
    }

    items.push({ icon: IC.selectAll, label: 'Select All', action: function () {
      editor.commands.focus()
      editor.commands.selectAll()
    }})

    items.push({ type: 'divider' })
    var linkUrl = ctx.linkUrl || null
    items.push({ icon: IC.externalLink, label: linkUrl ? 'Internalise Link' : 'Internalise URL…', action: function () {
      window._sieveOpenInternalize && window._sieveOpenInternalize(linkUrl || '')
    }})
    items.push({ icon: IC.code, label: 'Insert Code Block', action: function () {
      document.dispatchEvent(new CustomEvent('sieve:create-block', { detail: { kind: 'code' } }))
    }})

    items.push({ type: 'divider' })
    items.push({ icon: IC.sparkle, label: 'Ask AI...', action: function () {
      editor.commands.focus()
      document.dispatchEvent(new CustomEvent('sieve:ai-ask'))
    }})
    items.push({ icon: IC.info, label: 'Explain', action: function () {
      editor.commands.focus()
      document.dispatchEvent(new CustomEvent('sieve:ai-explain'))
    }})

    return items
  }

  // ── Image node ───────────────────────────────────────────────────────────────
  function buildImageItems(ctx) {
    var editor = ctx.editor, getPos = ctx.getPos, n = ctx.node

    function md() {
      var a = n.attrs
      var text = '![' + (a.alt || '') + '](' + (a.src || '') + ')'
      var extra = []
      if (a.id) extra.push('id="' + a.id + '"')
      if (a.width) extra.push('width="' + a.width + '"')
      if (a.height) extra.push('height="' + a.height + '"')
      if (a.summary) extra.push('summary="' + a.summary + '"')
      if (a.detect) extra.push('detect="' + a.detect + '"')
      if (extra.length) text += '{' + extra.join(' ') + '}'
      return text
    }

    function del() {
      if (typeof getPos === 'function') {
        var pos = getPos()
        editor.view.dispatch(editor.state.tr.delete(pos, pos + n.nodeSize))
      }
    }

    return [
      { icon: IC.copy, label: 'Copy', action: function () {
        navigator.clipboard.writeText(md()).catch(console.error)
      }},
      { icon: IC.cut, label: 'Cut', action: function () {
        navigator.clipboard.writeText(md()).then(del).catch(console.error)
      }},
      { icon: IC.trash, label: 'Delete', action: del },
      { type: 'divider' },
      { icon: IC.sparkle, label: 'Ask AI...', action: function () {
        editor.commands.focus()
        document.dispatchEvent(new CustomEvent('sieve:ai-ask'))
      }},
      { icon: IC.info, label: 'Explain', action: function () {
        editor.commands.focus()
        document.dispatchEvent(new CustomEvent('sieve:ai-explain'))
      }},
    ]
  }

  // ── AI Block node ────────────────────────────────────────────────────────────

  function promoteAiBlock(editor, getPos, n) {
    var question = (n.attrs.question || '').replace(/\n/g, ' ').trim()
    var response = n.attrs.response || ''
    // If response contains ```ai-block fences (e.g. a question about the format),
    // insertContentAt will parse them as live aiBlock nodes via the extension's updateDOM hook.
    var md = question ? ('### ' + question + '\n\n' + response) : response
    var html = editor.storage.markdown.parser.md.render(md)
    var pos = getPos()
    // Trailing empty paragraph prevents the next block from merging with the last
    // paragraph of the promoted content.
    editor.commands.insertContentAt({ from: pos, to: pos + n.nodeSize }, html + '<p></p>')
  }

  function buildAiBlockItems(ctx) {
    var editor = ctx.editor, getPos = ctx.getPos, n = ctx.node

    function yaml() {
      return '```ai-block\n' + window.TipTap.serializeAiBlockYaml(n.attrs) + '\n```'
    }

    function del() {
      if (typeof getPos === 'function') {
        var pos = getPos()
        editor.view.dispatch(editor.state.tr.delete(pos, pos + n.nodeSize))
      }
    }

    var isError = n.attrs.status === 'TIMEOUT' || n.attrs.status === 'PENDING'

    return [
      { icon: IC.copy, label: 'Copy', action: function () {
        navigator.clipboard.writeText(yaml()).catch(console.error)
      }},
      { icon: IC.cut, label: 'Cut', action: function () {
        navigator.clipboard.writeText(yaml()).then(del).catch(console.error)
      }},
      { icon: IC.trash, label: 'Delete', action: del },
      { type: 'divider' },
      { icon: IC.sparkle, label: 'Ask AI...', action: function () {
        // Re-assert node selection so buildAiContext sees this AI block as context.
        if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
        else editor.commands.focus()
        document.dispatchEvent(new CustomEvent('sieve:ai-ask'))
      }},
      { icon: IC.info, label: 'Explain', action: function () {
        if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
        else editor.commands.focus()
        document.dispatchEvent(new CustomEvent('sieve:ai-explain'))
      }},
      { type: 'divider' },
      { icon: IC.promote, label: 'Promote to Document',
        disabled: n.attrs.status !== 'COMPLETE' || !n.attrs.response,
        action: function () { promoteAiBlock(editor, getPos, n) }
      },
      { type: 'divider' },
      { icon: IC.refresh, label: isError ? 'Retry' : 'Replay', action: function () {
        document.dispatchEvent(new CustomEvent('sieve:ai-retry', {
          detail: { id: n.attrs.id, question: n.attrs.question, ref: n.attrs.ref, type: n.attrs.type }
        }))
      }},
    ]
  }

  // ── Web Clip node ─────────────────────────────────────────────────────────────

  function promoteWebClip(editor, getPos, n) {
    var content = (n.attrs.content || '').trim()
    if (!content) return
    var html = editor.storage.markdown.parser.md.render(content)
    var pos = getPos()
    editor.commands.insertContentAt({ from: pos, to: pos + n.nodeSize }, html + '<p></p>')
  }

  function buildWebClipItems(ctx) {
    var editor = ctx.editor, getPos = ctx.getPos, n = ctx.node

    function yaml() {
      return '```web-clip\n' + (n.attrs.rawYaml || '') + '\n```'
    }

    function del() {
      if (typeof getPos === 'function') {
        var pos = getPos()
        editor.view.dispatch(editor.state.tr.delete(pos, pos + n.nodeSize))
      }
    }

    var status = n.attrs.status || 'PENDING'
    var isComplete = status === 'COMPLETE'
    var isRetryable = status === 'ERROR' || status === 'TIMEOUT' ||
      ((status === 'PENDING' || status === 'DISPATCHED') && n.attrs.createdAt &&
        Date.now() - new Date(n.attrs.createdAt).getTime() > ((window.__sieveCliTimeoutLong || 60) * 1000 + 30000))

    var domain = ''
    try { domain = new URL(n.attrs.source || '').hostname } catch (_) { domain = n.attrs.source || '' }
    var modeLabel = n.attrs.mode === 'summarise' ? 'Summarised' : 'Fetched'
    var headerLabel = isComplete ? (modeLabel + ' from ' + domain) : domain

    var items = [
      { type: 'header', label: headerLabel },
      { icon: IC.copy, label: 'Copy', action: function () { navigator.clipboard.writeText(yaml()).catch(console.error) } },
      { icon: IC.cut, label: 'Cut', action: function () { navigator.clipboard.writeText(yaml()).then(del).catch(console.error) } },
      { icon: IC.trash, label: 'Delete', action: del },
      { type: 'divider' },
      { icon: IC.promote, label: 'Promote to Document',
        disabled: !isComplete || !n.attrs.content,
        action: function () { promoteWebClip(editor, getPos, n) }
      },
    ]

    if (isComplete && n.attrs.content) {
      items.push({ type: 'divider' })
      items.push({ icon: IC.sparkle, label: 'Ask AI...', action: function () {
        editor.commands.focus()
        document.dispatchEvent(new CustomEvent('sieve:ai-ask'))
      }})
      items.push({ icon: IC.info, label: 'Explain', action: function () {
        editor.commands.focus()
        document.dispatchEvent(new CustomEvent('sieve:ai-explain'))
      }})
    }

    if (isRetryable) {
      items.push({ type: 'divider' })
      items.push({ icon: IC.refresh, label: 'Retry', action: function () {
        document.dispatchEvent(new CustomEvent('sieve:webclip-retry', {
          detail: { id: n.attrs.id, source: n.attrs.source, mode: n.attrs.mode }
        }))
      }})
    }

    return items
  }

  // ── Sidebar: note ────────────────────────────────────────────────────────────
  function buildNoteItems(ctx) {
    var id = ctx.id, name = ctx.name, intent = ctx.intent, isTab = ctx.isTab
    var items = []

    if (name) items.push({ type: 'header', label: name })

    items.push({ icon: IC.smartFile, label: 'Smart File', action: function () {
      window.SieveAI && window.SieveAI.smartFile(id)
    }})
    items.push({ icon: IC.smartMeta, label: 'Smart Metadata', action: function () {
      window.SieveAI && window.SieveAI.smartMetadata(id)
    }})

    items.push({ type: 'divider' })

    items.push({ icon: IC.keep, label: 'Mark as Keep',
      cls: 'ctx-item--keep' + (intent === 'keep' ? ' ctx-item--active' : ''),
      action: function () {
        hx('POST', '/api/sidebar/intent?id=' + encodeURIComponent(id) + '&value=keep', { target: '#htmx-sidebar', swap: 'innerHTML' })
      }
    })
    items.push({ icon: IC.markTrash, label: 'Mark as Trash',
      cls: 'ctx-item--trash' + (intent === 'trash' ? ' ctx-item--active' : ''),
      action: function () {
        hx('POST', '/api/sidebar/intent?id=' + encodeURIComponent(id) + '&value=trash', { target: '#htmx-sidebar', swap: 'innerHTML' })
      }
    })
    if (intent) {
      items.push({ icon: IC.clearIntent, label: 'Clear Intent', action: function () {
        hx('POST', '/api/sidebar/intent?id=' + encodeURIComponent(id) + '&value=', { target: '#htmx-sidebar', swap: 'innerHTML' })
      }})
    }

    items.push({ type: 'divider' })

    items.push({ icon: IC.edit, label: 'Rename...', action: function () {
      hx('GET', '/api/sidebar/rename-prompt?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name) + '&type=note',
        { target: '#rename-dialog-content', swap: 'innerHTML' }
      ).then(function () { document.getElementById('rename-dialog').showModal() })
    }})
    items.push({ icon: IC.folder, label: 'Show in Files', action: function () {
      window.sieveShowInFiles && window.sieveShowInFiles(id)
    }})
    items.push({ icon: IC.trash, label: 'Delete Note...', cls: 'ctx-item--danger', action: function () {
      hx('GET', '/api/sidebar/delete-prompt?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name) + '&type=note',
        { target: '#delete-dialog-content', swap: 'innerHTML' }
      ).then(function () { document.getElementById('delete-dialog').showModal() })
    }})

    if (isTab) items = items.concat(tabItems(id))
    return items
  }

  // ── Sidebar: folder ──────────────────────────────────────────────────────────
  function buildFolderItems(ctx) {
    var id = ctx.id, name = ctx.name
    var items = []

    if (name) items.push({ type: 'header', label: name })

    items.push({ icon: IC.edit, label: 'Rename...', action: function () {
      hx('GET', '/api/sidebar/rename-prompt?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name) + '&type=folder',
        { target: '#rename-dialog-content', swap: 'innerHTML' }
      ).then(function () { document.getElementById('rename-dialog').showModal() })
    }})
    items.push({ icon: IC.folder, label: 'Show in Files', action: function () {
      window.sieveShowInFiles && window.sieveShowInFiles(id)
    }})

    items.push({ type: 'divider' })

    items.push({ icon: IC.trash, label: 'Delete Folder...', cls: 'ctx-item--danger', action: function () {
      hx('GET', '/api/sidebar/delete-prompt?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name) + '&type=folder',
        { target: '#delete-dialog-content', swap: 'innerHTML' }
      ).then(function () { document.getElementById('delete-dialog').showModal() })
    }})

    return items
  }

  // ── Sidebar: prompt ──────────────────────────────────────────────────────────
  function buildPromptItems(ctx) {
    var id = ctx.id, name = ctx.name, isVirtual = ctx.isVirtual, isTab = ctx.isTab
    var items = []

    if (name) items.push({ type: 'header', label: name })

    items.push({ icon: IC.edit, label: 'Edit Prompt', action: function () {
      hx('POST', '/api/note/open/' + encodeURIComponent(id), { target: '#htmx-tabbar', swap: 'innerHTML' })
    }})

    if (!isVirtual) {
      items.push({ icon: IC.refresh, label: 'Reset to Default', cls: 'ctx-item--danger', action: function () {
        hx('POST', '/api/sidebar/revert-prompt?id=' + encodeURIComponent(id), { swap: 'none' })
      }})
    }

    if (isTab) items = items.concat(tabItems(id))
    return items
  }

  // ── Central dispatcher ───────────────────────────────────────────────────────
  document.addEventListener('sieve:contextmenu', function (e) {
    var d = e.detail, ctx = d.context, items
    switch (ctx.type) {
      case 'editor':    items = buildEditorItems(ctx); break
      case 'image':     items = buildImageItems(ctx); break
      case 'aiBlock':   items = buildAiBlockItems(ctx); break
      case 'webClip':   items = buildWebClipItems(ctx); break
      case 'note':      items = buildNoteItems(ctx); break
      case 'folder':    items = buildFolderItems(ctx); break
      case 'prompt':    items = buildPromptItems(ctx); break
      case 'sieveBlock': items = ctx.items || []; break
      default: return
    }
    render(d.x, d.y, items)
  })

  // Expose icon set so sieve block renderers can build menu items with matching icons.
  window.SieveIcons = IC

  // ── Dismiss ──────────────────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var menu = document.getElementById('sieve-context-menu')
    if (menu && !menu.contains(e.target)) menu.remove()
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu()
  })
})()
