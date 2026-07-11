// editor.js — vanilla JS TipTap island. Loaded once; re-initialized per tab switch.
// Depends on window.TipTap (ui/static/vendor/tiptap.js).
// Depends on window.sieveWorkspace (shell/workspace.js) for the P1 shell skeleton.

(function () {
  'use strict'

  var currentUuid = ''
  var currentMountEl = null

  // ── Shell integration (P1 skeleton → P2.B surfaces) ───────────────────────────
  // The Workspace/Tab/Editor/Surface component model (shell/*.js) is the working
  // storage now. `currentEditor` and `currentMode` are DERIVED delegating
  // globals: their storage is the active editor's mounted surface — there is no
  // second copy of the state, and the ~100 unqualified reads below resolve
  // through the window accessors. They are read-only by construction: any
  // leftover assignment throws loudly instead of silently diverging (the write
  // sites all moved into the surfaces / setMode).
  Object.defineProperty(window, 'currentEditor', {
    configurable: true,
    get: function () {
      var ed = _activeEditor()
      return (ed && ed.tiptap) || null
    },
    set: function () {
      throw new Error('currentEditor is derived from the active surface — mount/unmount the surface instead')
    },
  })
  Object.defineProperty(window, 'currentMode', {
    configurable: true,
    get: function () {
      var ed = _activeEditor()
      return ed ? ed.mode : 'wysiwyg'
    },
    set: function () {
      throw new Error('currentMode is derived from the active surface — use editor.setMode()')
    },
  })

  // _activeEditor returns the live editor instance for the active tab (a
  // NoteEditor or PromptEditor), or null. Call sites speak the editor's DOMAIN
  // methods (applyBlockOps/updateText/retryBlockJob/extract/flushSave) — the
  // transport underneath is AbstractEditor's private business; a disconnected
  // editor (PromptEditor) no-ops them safely, so nothing here probes for it.
  function _activeEditor() {
    var ws = window.sieveWorkspace
    return (ws && ws.activeTab && ws.activeTab.editor) || null
  }

  // routeServerMessage handles the WS messages that are neither protocol
  // (pong/awaiters — NoteEditor) nor surface ops (insert-block / replace-block /
  // block-attrs-updated → editor.applyServerOp → active surface) nor awaited
  // mode replies (markdown-content / wysiwyg-content — consumed by setMode's
  // awaiter; a late one falls through here and is deliberately dropped).
  function routeServerMessage(msg) {
    if (msg.type === 'error') {
      window.alert(msg.message || 'An error occurred.')
    }
    // block-extracted: the new block renders via insert-block (tracked). Nothing to do.
  }

  // legacyChromeFanout — TRANSITIONAL (quarantined with the X-C debt, epic #31).
  // The ONE place the editor's producer-named events — the surfaces' doc-changed /
  // selection-changed / transaction / focus-changed AND the editor's own
  // mode-changed / mode-change-failed (P2.C) — fan out to the legacy chrome
  // functions. Consumer names appear ONLY here; dies in P4 when chrome becomes
  // Workspace-owned children.
  function legacyChromeFanout(event) {
    switch (event.type) {
      case 'doc-changed':
        document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
        document.dispatchEvent(new CustomEvent('editor:changed'))
        dispatchStats()
        break
      case 'selection-changed':
        if (currentEditor) syncToolbar(currentEditor)
        break
      case 'transaction':
        if (currentEditor) syncToolbar(currentEditor)
        break
      case 'mode-changed':
        // The editor flipped its surface (AbstractEditor.setMode producer
        // emission — exactly once per actual flip). The Tab self-records the mode
        // (it subscribed to this stream in attachEditor); chrome only here:
        // refresh the mode button + body class, stats, and the tabbar strip.
        updateModeUI()
        dispatchStats()
        if (window.sieveWorkspace) window.sieveWorkspace.loadTabs()
        break
      case 'mode-change-failed':
        console.error('[editor] mode toggle failed; staying in ' + event.mode, event.error)
        window.alert('Mode switch failed — staying in ' + event.mode + ' mode.')
        break
    }
  }

  // _syncShell keeps window.sieveWorkspace in sync at each tab-lifecycle
  // transition. It is a thin adapter over SieveWorkspace.activateDocument — the
  // ONE authoritative editor-lifecycle path: destroy the previous editor on a
  // genuine tab switch or teardown (old WS closes BEFORE the new one opens, as
  // the Go takeover guard needs), keep the instance on a same-uuid re-activation
  // (toggleMode / prompt re-init reuse the SAME editor and its live socket).
  // initEditor never destroys editors directly — all teardown goes through here.
  // A NEWLY created editor gets the transitional legacy-chrome fan-out as its
  // first (and only production) surface-event registrant.
  function _syncShell(uuid) {
    var ws = window.sieveWorkspace
    if (!ws) return
    var existing = ws.getTab(uuid)
    var hadEditor = !!(existing && existing.editor)
    var tab = ws.activateDocument(uuid, {
      onServerMessage: routeServerMessage,
      createBlockAtCaret: function (kind, attrs) {
        // TRANSITIONAL P2.C seam for AbstractEditor.createBlock (retires in P4.B
        // by folding into createBlock). Parity with the retired insert-diagram
        // menu-event listener: menu inserts are wysiwyg-only — the editor's
        // commitInsertIndex needs the live PM doc, so a null currentEditor
        // (markdown mode) no-ops.
        if (!currentUuid || !currentEditor) return
        sendCreateBlock(kind, attrs)
      },
    })
    if (tab && tab.editor && !hadEditor) tab.editor.onEvent(legacyChromeFanout)
  }

  var blobInterceptorCleanup = null
  var searchOverlay = null

  // sendCreateBlock is the ONE UI-triggered create path: a create-block block-op
  // carrying kind, attrs, and the document index from the editor's captured insert
  // position. There is no separate create-block message — every kind creates
  // through block-op, exactly like update/delete. Go positions it via the index and
  // renders it back (insert-block) for structured kinds. The insert-position math
  // now lives on the editor (P4.A: setInsertPos/captureInsertPos/commitInsertIndex).
  function sendCreateBlock(kind, attrs) {
    var ed = _activeEditor()
    if (!currentUuid || !ed) return
    ed.applyBlockOps([
      { type: 'create-block', kind: kind, attrs: attrs || {}, index: ed.commitInsertIndex(ed.takeInsertPos()) },
    ])
  }


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
    // Flush the previous editor's pending edits while it is still attached, so
    // they go out on ITS socket before any teardown (surface flush + WS flush).
    var prev = _activeEditor()
    if (prev && prev.surface) flushSave()
    // NOTE: initEditor never destroys editors or surfaces directly. The shell
    // EDITOR instance (NoteEditor/PromptEditor — the WS owner) is destroyed in
    // exactly one place: SieveWorkspace.activateDocument (via _syncShell); the
    // previous SURFACE is unmounted by presentSurface below (same-uuid re-init)
    // or by editor.destroy() (tab switch/teardown).

    if (!mountEl || !uuid) {
      // Teardown — _syncShell destroys the active editor (unmounts its surface,
      // closes its WS) and closes its shell tab. currentMode reads fall back to
      // 'wysiwyg' with no active editor, exactly as the old reset.
      _syncShell('')
      currentUuid = ''
      return
    }

    currentUuid = uuid
    // Open/activate the shell Tab and create its editor (the Tab factory picks
    // NoteEditor vs PromptEditor; NoteEditor opens the WS in its constructor). On
    // a tab SWITCH the previous editor is destroyed first (old WS closes before
    // the new one opens); on a same-uuid re-init the editor + socket are kept.
    _syncShell(uuid)
    currentMountEl = mountEl
    var ws = window.sieveWorkspace
    var wantMode = mode || (ws && ws.activeTab && ws.activeTab.mode) || 'wysiwyg'

    fetch('/api/editor/load?uuid=' + encodeURIComponent(uuid))
      .then(function (r) { return r.json() })
      .then(function (data) {
        if (currentUuid !== uuid) return // a later init superseded this load
        window.SieveAI && window.SieveAI.loadActiveJobs()
        window.__stashActiveTabUuid = uuid

        var isMarkdown = wantMode === 'markdown' || data.mode === 'markdown' || uuid.startsWith('prompt:')
        ensureOverlays()

        var ed = _activeEditor()
        if (!ed) return
        // The editor owns its root (#tiptap-mount); the surface owns the DOM
        // under it. presentSurface unmounts any previous surface first.
        ed.presentSurface(
          isMarkdown ? 'markdown' : 'wysiwyg',
          mountEl,
          isMarkdown ? (data.body || '') : { body: data.body || '', blocks: data.blocks }
        )
        // Seed the Tab's mode record after the initial present (mode-changed
        // does not fire on initial mount — only on an actual flip).
        if (ws && ws.activeTab) ws.activeTab.recordMode(ed.mode)
        updateModeUI()
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

  // ── Input surfaces ───────────────────────────────────────────────────────────
  // The WYSIWYG TipTap island and the markdown textarea moved into the surface
  // classes (shell/surfaces/wysiwyg-surface.js + markdown-surface.js) in P2.B:
  // mount/unmount, the block-sync cache + debounces, blockToNodes /
  // renderBlocksIntoEditor, and the server-op placement logic are surface-owned.
  // editor.js reaches them only through the editor object (presentSurface /
  // setMode / applyServerOp / flushPending).

  // ── Save (thin wrapper over the live editor instance) ────────────────────────
  // The transport lives entirely inside AbstractEditor (#private, P2.B.2); this
  // module speaks only the editor's domain methods. STATE lives only in the
  // class; nothing here owns a socket or a timer.

  // flushSave delegates to the active editor's flushSave (NoteEditor: channel
  // flush; PromptEditor: HTTP save override). Returns a Promise so callers can
  // await the save.
  function flushSave() {
    var ed = _activeEditor()
    if (!ed) return Promise.resolve()
    return ed.flushSave()
  }

  // Primary creation path. JS fires sieve:create-block when the user uses a
  // keyboard shortcut, toolbar button, or slash command to insert a block.
  // detail: { kind: 'code', attrs: {} }
  document.addEventListener('sieve:create-block', function (e) {
    if (!currentUuid || currentUuid.startsWith('prompt:') || !e.detail.kind) return
    var ed = _activeEditor()
    if (!ed) return
    ed.setInsertPos(ed.captureInsertPos(ed.kindIsInline(e.detail.kind)))
    var attrs = e.detail.attrs || {}
    if (e.detail.kind === 'diagram' && !attrs.source) {
      attrs.mode = 'edit'
    }
    sendCreateBlock(e.detail.kind, attrs)
  })

  // Explicitly capture insertion position for async flows (like image upload).
  // These insert block kinds (smart-image / web-clip), so capture as a block.
  document.addEventListener('sieve:capture-insert-pos', function () {
    var ed = _activeEditor()
    if (!ed) return
    var pos = ed.captureInsertPos(false)
    ed.setInsertPos(pos)
    // A file dialog (toolbar image) blurs the editor and loses the caret. Stash the
    // resolved BLOCK INDEX now (pre-dialog); the cross-file upload handler in index.html
    // can't see the editor-private insert position, so it reads this and sends it to
    // smart-paste — without it the new image appends to the end of the document.
    window.__sieveCapturedInsertIndex = ed.blockIndexForInsert(pos)
  })

  // NodeViews fire sieve:block-update when the user edits block content. It rides
  // the SAME granular block-op as prose (built by block-sync.updateBlockOp) — the
  // bespoke block-update message is retired; block-op is the one mutation path.
  document.addEventListener('sieve:block-update', function (e) {
    var ed = _activeEditor()
    if (!currentUuid || !e.detail.id || !ed) return
    ed.applyBlockOps([window.TipTap.updateBlockOp(e.detail)])
  })

  // Server render-back ops (insert-block / replace-block / block-attrs-updated)
  // no longer route through document CustomEvents: NoteEditor hands them to the
  // active surface (editor.applyServerOp), where the P2.B-moved placement logic
  // lives — tracked insertContentAt at docPosForBlockIndex(msg.index),
  // replace-by-block-id, token reconcile + attrs updates as addToHistory:false
  // (shell/surfaces/wysiwyg-surface.js; markdown behavior in markdown-surface.js).

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
    // Markdown mode is the verbatim buffer (surface-owned since P2.B). In
    // WYSIWYG the frontend does NOT serialise the document (Go owns markdown,
    // derived from the tree); callers here (stats, prompt save) only need a
    // plain-text view, so use the editor's own text — never a frontend-built
    // markdown document.
    var ed = _activeEditor()
    if (ed && ed.mode === 'markdown') return (ed.surface && ed.surface.body) || ''
    if (!currentEditor) return ''
    return currentEditor.state.doc.textContent
  }

  function ensureOverlays() {
    if (!searchOverlay) searchOverlay = createSearchOverlay()
    if (!internalizeDialog) internalizeDialog = createInternalizeDialog()
    if (!richLinkDialog) richLinkDialog = createSmartCardDialog()
  }

  // ── Ask panel (P4.B) ──────────────────────────────────────────────────────────
  // The Ask panel + the AI ask/explain seam moved OUT of this IIFE: the Ask panel
  // is now a permanent Workspace child (shell/ask-panel.js), and the ai-block doc
  // mutation is a single editor method (AbstractEditor.askAi). editor.js no longer
  // wires the panel, owns the pinned flag, or consumes sieve:ai-ask/sieve:ai-explain.

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
    var ed = _activeEditor()
    if (ed) ed.setInsertPos(ed.captureInsertPos(ed.kindIsInline('smart-card')))
    sendCreateBlock('smart-card', { href: href })
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
    var ed = _activeEditor()
    if (ed) ed.setInsertPos(ed.captureInsertPos(ed.kindIsInline('web-clip')))
    sendCreateBlock('web-clip', { source: source, mode: mode })
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

  // ── AI jobs (P4.B) ─────────────────────────────────────────────────────────────
  //
  // The whole-doc soft reload moved to AbstractEditor.softReload (P4.A): it
  // fetches the latest body from disk and re-renders the surface, preserving the
  // caret (AI block resolve / restore / extract re-render). Call it via
  // _activeEditor().softReload().
  //
  // The AI ask/explain seam (runAiJob) + the target-prep (aiPrepareTarget) moved
  // to AbstractEditor (askAi / prepareAiTarget), and the Ask box that drove them is
  // now the Workspace's AskPanel child — see shell/ask-panel.js.

  // ── Module-level editor commands ──────────────────────────────────────────────

  // (Retired) The setContent(markdown) doc-load helper is GONE: a flat markdown
  // re-parse is a second, lossy document parser (it can't read <!--s:ID--> markers
  // → re-mints ids → corrupts on save-back). All wysiwyg loads now render the
  // backend BLOCK LIST via renderBlocksIntoEditor; markdown is set only into the
  // markdown-mode textarea, and only Go parses document structure from markdown.

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

  // The mode flip itself is AbstractEditor.toggleMode/setMode (P2.B/P2.C): an
  // AWAITED in-place surface swap with stay-on-failure semantics. The menu and
  // the toolbar button call the component API directly
  // (window.sieveWorkspace?.activeTab?.editor?.toggleMode()); the chrome
  // reaction to a flip lives in legacyChromeFanout's mode-changed /
  // mode-change-failed cases (the editor is the producer, emitted once per
  // actual flip inside setMode).

  function updateModeUI() {
    document.body.classList.toggle('markdown-mode', currentMode === 'markdown')
    var toggleBtn = document.getElementById('tb-toggle-mode-btn')
    if (toggleBtn && window.SieveIcons) {
      toggleBtn.innerHTML = window.SieveIcons[currentMode === 'markdown' ? 'eye' : 'markdown']
      toggleBtn.title = currentMode === 'markdown' ? 'Return to WYSIWYG' : 'View Markdown Source'
    }
  }

  // Copy as Markdown (File › Export › Clipboard (Markdown) — the menu calls
  // window.sieveWorkspace.copyDocumentAsMarkdown()). Fetch the server's clean
  // whole-doc export (ai-blocks filtered, cards/clips reduced to links) and
  // copy it to the clipboard. A native menu click carries no DOM user gesture
  // and steals document focus, so WebKit rejects navigator.clipboard here — the
  // Wails native pasteboard (runtime.ClipboardSetText) is the primary path; the
  // browser API is only the fallback for non-Wails (plain browser) dev.
  // No toast system exists, so feedback is left to the OS clipboard affordance.
  function copyDocumentAsMarkdown() {
    if (!currentUuid) return
    fetch('/api/editor/export?uuid=' + encodeURIComponent(currentUuid) + '&format=markdown')
      .then(function (resp) { return resp.ok ? resp.text() : null })
      .then(function (md) {
        if (md == null) return
        if (window.runtime && window.runtime.ClipboardSetText) {
          return window.runtime.ClipboardSetText(md)
        }
        return navigator.clipboard.writeText(md)
      })
      .catch(function (err) { console.warn('export-markdown copy failed', err) })
  }

  // ── TRANSITIONAL workspace-chrome registration (P2.C; dies P4) ────────────────
  // The native menu (main.go buildMenu) now calls the component API directly —
  // window.sieveWorkspace.toggleSearch() / openWebClipDialog() /
  // openUrlCardDialog() / copyDocumentAsMarkdown(); the four chrome CustomEvent
  // hops (toggle-search / insert-webclip / insert-url-card / export-markdown)
  // are GONE. The implementations still live in this IIFE; this single boot-time
  // registration fronts them on the workspace until chrome becomes
  // Workspace-owned children (P4). DOMContentLoaded ordering is safe: the shell
  // modules are deferred scripts, so window.sieveWorkspace exists by then; this
  // IIFE must never touch it at parse time (index.html script order).
  document.addEventListener('DOMContentLoaded', function () {
    var ws = window.sieveWorkspace
    if (!ws || typeof ws.provideChrome !== 'function') return
    ws.provideChrome({
      toggleSearch: toggleSearch,
      openWebClipDialog: function () { ensureOverlays(); openInternalizeDialog() },
      openUrlCardDialog: function () { ensureOverlays(); openSmartCardDialog() },
      copyDocumentAsMarkdown: copyDocumentAsMarkdown,
    })
    // The Ask panel's selection-stream subscription (label re-render) moved into
    // the Workspace's AskPanel child (P4.B — shell/ask-panel.js); it owns its own
    // ws.onSelectionUpdate registration now.
  })

  // ── Ask AI / Explain (P4.B) ────────────────────────────────────────────────────
  // The two sieve:ai-ask / sieve:ai-explain consumers moved into the AskPanel child
  // (shell/ask-panel.js): it opens on ai-ask and prepares-target + asks on ai-explain
  // via the editor seam (AbstractEditor.askAi / prepareAiTarget). The transitional
  // events still ride from the producers that lack a direct handle (surface keymap,
  // context-menu items, sieve-block affordance); the toolbar + Ctrl+Shift+A hotkey
  // are de-evented (they call window.sieveWorkspace.askPanel directly).
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
    var edRetry = _activeEditor()
    if (edRetry) edRetry.retryBlockJob(blkId)
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
    // Restore renders the backend's RELOADED block list (ids intact), never a flat
    // setContent re-parse — which can't read <!--s:ID--> markers and would re-mint
    // ids, then persist that corruption on save-back. editor.softReload renders via
    // the block list and guards the save-back (isSaveSuppressed).
    if (!data || !data.uuid) return
    var ed = _activeEditor()
    if (ed) ed.softReload()
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

  // Block-ID hover readout (dev/debug). Hovering any block — prose or Sieve —
  // surfaces `kind · id` in the status bar. Both kinds carry data-id in the DOM
  // (prose via the blockId global attr; Sieve via its NodeView host); Sieve
  // blocks also carry data-kind, prose don't (→ implicitly 'prose'). Pure DOM
  // read, no PM doc access. Producer half of the same pattern as dispatchStats →
  // editor:stats; the consumer lives beside that handler in index.html. The
  // gutter line number already gives the block's index, so it's not duplicated.
  var lastHoverKey = null
  document.addEventListener('mouseover', function (e) {
    var inMount = e.target.closest && e.target.closest('#tiptap-mount')
    var el = inMount ? e.target.closest('[data-id]') : null
    var key = el ? (el.getAttribute('data-kind') || 'prose') + '·' + el.getAttribute('data-id') : null
    if (key === lastHoverKey) return   // only fire when the hovered block changes
    lastHoverKey = key
    document.dispatchEvent(new CustomEvent('editor:blockhover', {
      detail: el ? { id: el.getAttribute('data-id'), kind: el.getAttribute('data-kind') || 'prose' } : null
    }))
  })

  // ── Upgrade to Web Clip (Rich Link → Web Clip) ────────────────────────────────
  // Fired by smart-card-renderer.js context menu "Upgrade to Web Clip".
  document.addEventListener('sieve:upgrade-to-web-clip', function (e) {
    if (!currentUuid || !currentEditor) return
    var ed = _activeEditor()
    if (!ed) return
    var href = e.detail.href
    var fromPos = e.detail.fromPos
    var fromSize = e.detail.fromSize
    var mode = e.detail.mode || 'fetch'
    if (!href || fromPos == null) return
    // Delete the smart-card block first, then insert web-clip at its position
    currentEditor.view.dispatch(currentEditor.state.tr.delete(fromPos, fromPos + fromSize))
    ed.setInsertPos(fromPos)
    sendCreateBlock('web-clip', { source: href, mode: mode })
  })

  // ── Extract / Transform (sieve:extract) ─────────────────────────────────────
  // Dumb playback: post {operation, targetKind, entries, blockId}. The backend mutates
  // (PASTE/EXTRACT -> new block via insert-block; TRANSFORM -> ReplaceBlock on its tree,
  // then a replace-block render-back the editor answers by re-rendering). The frontend
  // never swaps nodes itself.
  document.addEventListener('sieve:extract', function (e) {
    if (!currentUuid || !currentEditor) return
    var edExtract = _activeEditor()
    if (!edExtract) return
    var blockId = e.detail.blockId
    var targetKind = e.detail.targetKind
    var operation = e.detail.operation || 'extract'
    var entries = e.detail.entries || []
    var sourceNode = e.detail.sourceNode
    var context = e.detail.context || {}

    if (entries.length > 0 && Object.keys(context).length > 0) {
      entries[0].context = context
    }

    // Additive ops (extract/paste) land via insert-block at a document index; clear any
    // stale insert position so insert-block uses the op's own index, not a leftover range.
    edExtract.clearInsertPos()
    var index = -1
    if (operation !== 'transform' && operation !== 'undo-smart-paste' && blockId) {
      // Use top-level-only scan (blockIndexAfter) — descendants() was buggy because
      // it visited nested nodes, potentially matching an inner node's id and computing
      // an index relative to that nested position rather than the top-level tree.
      index = window.TipTap.blockIndexAfter(currentEditor.state.doc, blockId)
    }

    function send(resolved) {
      var ed = _activeEditor()
      if (ed) ed.extract({ blockId: blockId, targetKind: targetKind, operation: operation, entries: resolved, index: index })
    }

    if (window.TipTap && window.TipTap.resolveEntriesForKind) {
      var res = window.TipTap.resolveEntriesForKind(targetKind, sourceNode, entries)
      if (res && typeof res.then === 'function') {
        res.then(send).catch(function (err) { console.error('[sieve:extract] failed', err) })
        return
      }
      entries = res
    }
    send(entries)
  })

  window.sieveInitEditor = initEditor

})()
