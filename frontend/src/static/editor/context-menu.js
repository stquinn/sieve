// context-menu.js — single source of truth for all context menus.
// Components fire 'sieve:contextmenu' with { x, y, context } in the detail.
// context.type must be one of: 'editor' | 'image' | 'aiBlock' | 'note' | 'folder' | 'prompt'
import { getSieveIcon } from '../block/block-kinds.js'
import { applyTargetHighlight } from './extensions.js'
import { extractContentEntryFromEditor, detectAndAppendExtractions, serializeNode } from '../block/sieve-block-extension.js'
import { enclosingBlockId } from '../base/block-position.js'

  // ── Icons ───────────────────────────────────────────────────────────────────
  var IC = window.SieveIcons || {}

  // ── Renderer ────────────────────────────────────────────────────────────────
  function render(x, y, items) {
    var existing = document.getElementById('sieve-context-menu')
    if (existing) existing.remove()

    var menu = document.createElement('div')
    menu.id = 'sieve-context-menu'
    menu.className = 'sieve-context-menu'
    menu.style.left = x + 'px'
    menu.style.top = y + 'px'

    appendItemsToMenu(menu, items)

    document.body.appendChild(menu)

    requestAnimationFrame(function () {
      var r = menu.getBoundingClientRect()
      if (r.right > window.innerWidth - 8)
        menu.style.left = (window.innerWidth - r.width - 8) + 'px'
      if (r.bottom > window.innerHeight - 8)
        menu.style.top = (window.innerHeight - r.height - 8) + 'px'
    })
  }

  function appendItemsToMenu(menu, items) {
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
  }

  window.SieveContextMenu = {
    appendItems: function (items) {
      var menu = document.getElementById('sieve-context-menu')
      if (!menu) return
      appendItemsToMenu(menu, items)
      requestAnimationFrame(function () {
        var r = menu.getBoundingClientRect()
        if (r.right > window.innerWidth - 8)
          menu.style.left = (window.innerWidth - r.width - 8) + 'px'
        if (r.bottom > window.innerHeight - 8)
          menu.style.top = (window.innerHeight - r.height - 8) + 'px'
      })
    }
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
        window.sieveWorkspace.close(id)
      }},
      { icon: IC.close, label: 'Close Others', action: function () {
        window.sieveWorkspace.closeOthers(id)
      }},
      { icon: IC.closeAll, label: 'Close All Tabs', action: function () {
        window.sieveWorkspace.closeAll()
      }},
    ]
  }

  // ── Editor: text / code block / table ────────────────────────────────────────
  function buildEditorItems(ctx, x, y) {
    var editor = ctx.editor

    // Snap selection to right-click coordinates if click is outside current selection
    if (x != null && y != null) {
      var posAt = editor.view.posAtCoords({ left: x, top: y })
      if (posAt && posAt.pos != null) {
        var currentSel = editor.state.selection
        if (posAt.pos < currentSel.from || posAt.pos > currentSel.to) {
          editor.commands.setTextSelection(posAt.pos)
        }
      }
    }

    var state = editor.state
    var sel = state.selection
    var hasSelection = !sel.empty

    var targetNode = null
    var targetPos = null
    var doc = state.doc
    var from = sel.from, to = sel.to
    var scanFrom = (from === to) ? Math.max(0, from - 1) : from
    var scanTo   = (from === to) ? Math.min(doc.content.size, to + 1) : to
    doc.nodesBetween(scanFrom, scanTo, function (node, pos) {
      if (!targetNode && (node.type.name === 'sieve-smart-image' || node.type.name === 'codeBlock' || node.type.name === 'image' || node.type.name === 'table')) {
        targetNode = node
        targetPos = pos
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
    items.push({ icon: getSieveIcon('web-clip'), label: linkUrl ? 'Insert Web Clip from Link' : 'Insert Web Clip...', action: function () {
      window.sieveWorkspace && window.sieveWorkspace.openWebClipDialog(linkUrl || '')
    }})
    items.push({ icon: getSieveIcon('smart-card'), label: linkUrl ? 'Insert URL Card from Link' : 'Insert URL Card...', action: function () {
      window.sieveWorkspace && window.sieveWorkspace.openUrlCardDialog(linkUrl || '')
    }})
    items.push({ icon: getSieveIcon('code'), label: 'Insert Code Block', action: function () {
      var ed = window.sieveWorkspace && window.sieveWorkspace.activeTab && window.sieveWorkspace.activeTab.editor
      ed && ed.createBlock('code', {})
    }})
    items.push({ icon: getSieveIcon('diagram'), label: 'Insert Diagram', action: function () {
      var ed = window.sieveWorkspace && window.sieveWorkspace.activeTab && window.sieveWorkspace.activeTab.editor
      ed && ed.createBlock('diagram', {})
    }})

    var isHighlighted = editor.isActive('highlight')
    if (hasSelection || isHighlighted) {
      var label = isHighlighted ? 'Unhighlight Target' : 'Highlight Target'
      items.push({ icon: IC.highlight, label: label, action: function () {
        if (isHighlighted) {
          editor.chain().extendMarkRange('highlight').unsetMark('highlight').focus().run()
          return
        }
        // D-5: applyTargetHighlight takes an explicit range now. The right-click set
        // the selection (buildEditorItems), so the current selection extent IS the
        // target the user is marking — pass it explicitly (no in-function live read).
        applyTargetHighlight(editor, { from: editor.state.selection.from, to: editor.state.selection.to })
        editor.commands.focus()
      }})
    }

    items.push({ type: 'divider' })
    // Ask AI / Explain just fire the event — the editor.js handler owns ALL the
    // business logic (target highlight + focus + buildAiContext + run), so the
    // context menu, toolbar, and keyboard shortcut behave identically. The menu's
    // only job is to set the selection from the right-click (done in buildEditorItems).
    items.push({ icon: IC.sparkle, label: 'Ask AI...', action: function () {
      document.dispatchEvent(new CustomEvent('sieve:ai-ask'))
    }})
    items.push({ icon: IC.info, label: 'Explain', action: function () {
      document.dispatchEvent(new CustomEvent('sieve:ai-explain'))
    }})

    // Native node → Sieve block conversion (in-place UPGRADE). A native node IS its
    // own content, so converting is an in-place TRANSFORM — the backend decides additive-vs-replace.
    // We reuse the exact extraction path the Sieve-block NodeView uses: extractContentEntryFromEditor
    // reads whatever DOM element was clicked. The context menu has no DOM event, but it has the
    // click coords, so we reconstruct the same target with elementFromPoint and pass a
    // synthetic { target } — the function reads nothing else off the event. Detection
    // (all processors) decides the conversion targets; we only describe the source.
    var nativeConvertible = { codeBlock: true, image: true }
    if (targetNode && nativeConvertible[targetNode.type.name] && targetPos !== null &&
        x != null && y != null) {
      var domEl = document.elementFromPoint(x, y)
      if (domEl) {
        var res = extractContentEntryFromEditor({ target: domEl }, editor)
        if (res && res.entries) {
          detectAndAppendExtractions({
            sourceNode: targetNode,
            sourceKind: targetNode.type.name,
            entries: res.entries,
            blockId: (targetNode.attrs && targetNode.attrs.id)
              ? targetNode.attrs.id
              : enclosingBlockId(editor.state.doc, targetPos),
            sourcePos: targetPos,
            extractSourceLabel: res.extractSourceLabel,
            editor: editor.sieveHost || null
          })
        }
      }
    }

    // Delete — only for block-level native nodes (codeBlock, table).
    // Paragraph text uses normal keyboard deletion; this is for structured blocks
    // where there's no other obvious affordance (e.g. after extracting to Sieve).
    var blockNodeTypes = { codeBlock: true, table: true }
    if (targetNode && blockNodeTypes[targetNode.type.name] && targetPos !== null) {
      ;(function (node, pos) {
        items.push({ type: 'divider' })
        items.push({ icon: IC.trash, label: 'Delete Block', cls: 'ctx-item--danger', action: function () {
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
          editor.commands.focus()
        }})
      })(targetNode, targetPos)
    }

    return items
  }

  // ── AI Block node ────────────────────────────────────────────────────────────



  function buildAiBlockItems(ctx) {
    var editor = ctx.editor, getPos = ctx.getPos, n = ctx.node

    function yaml() {
      return serializeNode(editor, n)
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
        var md = yaml()
        if (!md) { console.warn('[sieve] ai-block serialize returned empty; copy aborted'); return }
        navigator.clipboard.writeText(md).catch(console.error)
      }},
      { icon: IC.cut, label: 'Cut', action: function () {
        var md = yaml()
        if (!md) { console.warn('[sieve] ai-block serialize returned empty; copy aborted'); return }
        navigator.clipboard.writeText(md).then(del).catch(console.error)
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
      { icon: IC.refresh, label: isError ? 'Retry' : 'Replay', action: function () {
        document.dispatchEvent(new CustomEvent('sieve:ai-retry', {
          detail: { id: n.attrs.id, question: n.attrs.question, ref: n.attrs.ref, type: n.attrs.type }
        }))
      }},
    ]
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
      window.sieveWorkspace.open(id)
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
      case 'editor':    items = buildEditorItems(ctx, d.x, d.y); break
      case 'image':     items = buildImageItems(ctx); break
      case 'aiBlock':   items = buildAiBlockItems(ctx); break
      case 'note':      items = buildNoteItems(ctx); break
      case 'folder':    items = buildFolderItems(ctx); break
      case 'prompt':    items = buildPromptItems(ctx); break
      case 'sieveBlock': items = ctx.items || []; break
      default: return
    }
    render(d.x, d.y, items)
  })

  // Icons are globally accessible via window.SieveIcons


  // ── Dismiss ──────────────────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var menu = document.getElementById('sieve-context-menu')
    if (menu && !menu.contains(e.target)) menu.remove()
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu()
  })
