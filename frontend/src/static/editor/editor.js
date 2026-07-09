// editor.js — vanilla JS TipTap island. Loaded once; re-initialized per tab switch.
// Depends on window.TipTap (ui/static/vendor/tiptap.js).
// Depends on window.sieveWorkspace (shell/workspace.js) for the P1 shell skeleton.

(function () {
  'use strict'

  var currentUuid = ''
  var currentMountEl = null
  var tabModes = {}

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

  // makeSurface builds a concrete input surface (shell/surfaces/*.js). A
  // surface's dependency bag holds ONLY (a) DOMAIN-SHAPED content services —
  // applyBlockOps/updateText (the editor's own transport methods, threaded
  // through as `services`; the WS enveloping lives in AbstractEditor), requestSave,
  // requestReload, takeInsertPos, the paste+drop pipelines — and (b) the single
  // outbound `notify`. Zero app-level concepts (no chrome names, no AI, no
  // chords) and zero wire vocabulary. Everything app-flavoured lives in
  // legacyChromeFanout + the transitional chord listener below.
  function makeSurface(uuid, mode, services) {
    var deps = {
      notify: services.notify,
      // Read-and-clear the captured insert position: a numeric pos feeds the
      // AI-block insert fallback; any other shape just clears (fresh capture per
      // operation — a stale value can never leak into a later insert).
      takeInsertPos: function () {
        var p = (typeof sieveInsertPos === 'number') ? sieveInsertPos : null
        sieveInsertPos = null
        return p
      },
    }
    if (mode === 'markdown') {
      deps.updateText = services.updateText
      deps.requestReload = function () { softReloadContent(uuid) }
      return new window.SieveMarkdownSurface(deps)
    }
    deps.applyBlockOps = services.applyBlockOps
    // requestSave backs the PM-internal Mod+S (editorProps handleKeyDown must
    // run pre-core inside ProseMirror's key routing — the interaction contract).
    deps.requestSave = flushSave
    deps.onPaste = handleSmartPaste
    deps.onDrop = handleSmartDrop
    return new window.SieveWysiwygSurface(uuid, deps)
  }

  // legacyChromeFanout — TRANSITIONAL (quarantined with the X-C debt, epic #31).
  // The ONE place the surfaces' producer-named events (doc-changed /
  // selection-changed / transaction / focus-changed) fan out to the legacy
  // chrome functions. Consumer names appear ONLY here; dies in P2.C/P4 when
  // chrome becomes Workspace-owned children.
  function legacyChromeFanout(event) {
    switch (event.type) {
      case 'doc-changed':
        document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
        document.dispatchEvent(new CustomEvent('editor:changed'))
        dispatchStats()
        break
      case 'selection-changed':
        if (currentEditor) {
          syncToolbar(currentEditor)
          updateAskPanelLabelLive(currentEditor)
        }
        break
      case 'transaction':
        if (currentEditor) syncToolbar(currentEditor)
        break
      case 'focus-changed':
        if (currentEditor) updateAskPanelLabelLive(currentEditor)
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
      surfaceFactory: function (mode, services) { return makeSurface(uuid, mode, services) },
      isSaveSuppressed: function () { return aiReloadInProgress },
    })
    if (tab && tab.editor && !hadEditor) tab.editor.onEvent(legacyChromeFanout)
  }

  var aiReloadInProgress = false
  var showAiBlocks = true
  var blobInterceptorCleanup = null
  var searchOverlay = null
  // Where the next inserted Sieve block goes. A number = insert at that point
  // (additive). A {from,to} object = replace that range (in-place conversion of a
  // native code block). Every block-creating operation sets this fresh, so a stale
  // value can never leak into a later insert.
  var sieveInsertPos = null

  // kindIsInline reads from the schema whether a sieve-<kind> node is inline (e.g.
  // smart-link) — so blockInsertPos places it at the caret rather than after the
  // top-level block. Unknown kind → block (the safe default; lands after the
  // enclosing top-level node, never splitting it).
  function kindIsInline(kind) {
    if (!currentEditor || !kind) return false
    var nt = currentEditor.schema.nodes['sieve-' + kind]
    return !!(nt && nt.isInline)
  }

  // captureInsertPos resolves WHERE the next inserted block goes, the single way
  // every additive creation path stamps sieveInsertPos (D-r.7). Delegates to the
  // shared blockInsertPos helper so block answers land after the top-level block
  // and inline kinds land at the caret. (In-place conversion / explicit-position
  // pastes set sieveInsertPos directly with their own {from,to} / coord position.)
  function captureInsertPos(isInline) {
    return currentEditor ? window.TipTap.blockInsertPos(currentEditor.state, isInline) : null
  }

  // blockIndexForInsert maps a captured insert position (a PM doc position, or null
  // for "append") to the top-level BLOCK index Go's create-block op inserts at —
  // the number of top-level nodes that end at or before the position.
  // Delegates to the tested window.TipTap.blockIndexForInsert (block-position.js).
  function blockIndexForInsert(pos) {
    if (!currentEditor) return -1
    return window.TipTap.blockIndexForInsert(currentEditor.state.doc, pos)
  }

  // commitInsertIndex — maps a captured insert position to the index Go creates
  // at, applying the empty-paragraph placement rule AT COMMIT TIME (never at
  // capture: a cancelled dialog must not eat the blank line). If the anchor is
  // a bare empty paragraph, delete it as an ordinary tracked prose edit (the
  // block-sync emits the same delete-block op a backspace would), flush the
  // sync so Go's shadow applies the delete BEFORE the create arrives on the
  // same socket, and return the anchor's own index — the new block takes its
  // place. No replace op, no backend emptiness-sniffing: two existing
  // primitives in order (docs/editor-interaction-contract.md).
  function commitInsertIndex(pos) {
    if (!currentEditor) return -1
    var anchor = window.TipTap.emptyParagraphAnchor(currentEditor.state.doc, pos)
    if (!anchor) return blockIndexForInsert(pos)
    // Sole-block doc: keep the paragraph (deleting the doc's only child is
    // schema-invalid) — it simply becomes the paragraph after the new block.
    if (currentEditor.state.doc.childCount > 1) {
      currentEditor.view.dispatch(currentEditor.state.tr.delete(anchor.from, anchor.to))
      var ed = _activeEditor()
      if (ed && ed.surface) ed.surface.flushPending()
    }
    return anchor.index
  }

  // sendCreateBlock is the ONE UI-triggered create path: a create-block block-op
  // carrying kind, attrs, and the document index from the captured insert position
  // (sieveInsertPos). There is no separate create-block message — every kind creates
  // through block-op, exactly like update/delete. Go positions it via the index and
  // renders it back (insert-block) for structured kinds.
  function sendCreateBlock(kind, attrs) {
    var ed = _activeEditor()
    if (!currentUuid || !ed) return
    ed.applyBlockOps([
      { type: 'create-block', kind: kind, attrs: attrs || {}, index: commitInsertIndex(sieveInsertPos) },
    ])
  }


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
    var wantMode = mode || tabModes[uuid] || 'wysiwyg'

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
        tabModes[uuid] = ed.mode
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
    sieveInsertPos = captureInsertPos(kindIsInline(e.detail.kind))
    var attrs = e.detail.attrs || {}
    if (e.detail.kind === 'diagram' && !attrs.source) {
      attrs.mode = 'edit'
    }
    sendCreateBlock(e.detail.kind, attrs)
  })

  // Explicitly capture insertion position for async flows (like image upload).
  // These insert block kinds (smart-image / web-clip), so capture as a block.
  document.addEventListener('sieve:capture-insert-pos', function () {
    sieveInsertPos = captureInsertPos(false)
    // A file dialog (toolbar image) blurs the editor and loses the caret. Stash the
    // resolved BLOCK INDEX now (pre-dialog); the cross-file upload handler in index.html
    // can't see the editor-private sieveInsertPos, so it reads this and sends it to
    // smart-paste — without it the new image appends to the end of the document.
    window.__sieveCapturedInsertIndex = blockIndexForInsert(sieveInsertPos)
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
    if (!askDialog) askDialog = wireAskPanel()
    if (!searchOverlay) searchOverlay = createSearchOverlay()
    if (!internalizeDialog) internalizeDialog = createInternalizeDialog()
    if (!richLinkDialog) richLinkDialog = createSmartCardDialog()
  }

  

  // ── Ask panel — wires the structural #ask-panel div in index.html ───────────

  var pendingAskCtx = null
  var isAskPanelPinned = window.initAskPanelPinned || false
  var askLabelTimeout = null
  var focusReturn = null   // focus context (editor/block/markdown) captured on jump-in to the Ask box

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
      // Ctrl+Shift+A (jump back out) is handled by the single global handler below,
      // so it isn't duplicated here — only Enter/Escape are box-local.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doAsk(textarea, panel) }
      if (e.key === 'Escape') { e.preventDefault(); closePanel() }
    })

    // Glow lifetime == Ask-box focus. The glow shows what the question is linked to
    // *while you're composing it*, then clears the moment you return to the document
    // — so normal editing (even with the panel pinned open) never paints a block.
    textarea.addEventListener('focus', function () {
      if (!currentEditor || currentMode === 'markdown') return
      var range = (pendingAskCtx && pendingAskCtx.range)
        ? pendingAskCtx.range
        : window.TipTap.resolveAiTarget(currentEditor, false).range
      window.TipTap.setAiTargetGlow(currentEditor.view, range)
    })
    textarea.addEventListener('blur', function () {
      if (currentEditor) window.TipTap.clearAiTargetGlow(currentEditor.view)
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
      // NB: no glow here. The label tracks the caret ambiently, but the glow (which
      // paints the document) is applied ONLY while the Ask box is focused — see the
      // textarea focus/blur handlers in wireAskPanel — so normal editing never glows.
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
    // Jump IN: capture where focus was (main editor, a block's inner editor, or
    // the markdown textarea) so jump-out restores it exactly. Must run before the
    // textarea steals focus below — activeElement is still the source here.
    focusReturn = window.TipTap.captureFocusContext(currentEditor)

    pendingAskCtx = precomputedCtx || null
    askDialog.classList.add('is-open')
    // The label tracks ambiently; the glow is applied by the textarea focus handler
    // once focus lands in the box below (glow only while focused → never during edit).
    if (!pendingAskCtx && currentEditor) updateAskPanelLabelLive(currentEditor)

    setTimeout(function() {
      textarea.focus()
    }, 50)
  }

  // Single focus-agnostic Ctrl+Shift+A entry point. If the Ask box has focus, jump
  // back out (restoring focus); otherwise jump in. The ProseMirror Mod-Shift-a
  // keymap still covers the case where the MAIN editor is focused; this handles the
  // cases the keymap can't see (the Ask box, a sieve block's inner editor) and
  // bails when the editor has focus so the two never double-fire.
  function toggleAskFocus() {
    ensureOverlays()
    var textarea = askDialog && askDialog.querySelector('.ask-popup__input')
    if (askDialog && askDialog.classList.contains('is-open') && document.activeElement === textarea) {
      returnToEditor()
    } else {
      document.dispatchEvent(new CustomEvent('sieve:ai-ask'))
    }
  }

  document.addEventListener('keydown', function (e) {
    if ((e.key !== 'a' && e.key !== 'A') || !window.isMod(e) || !e.shiftKey || e.altKey) return
    if (!currentEditor && currentMode !== 'markdown') return
    // The PM keymap owns the main-editor-focused case — let it handle that.
    if (currentEditor && currentEditor.view.hasFocus()) return
    // Don't hijack the shortcut inside the sidebar or a modal dialog.
    var ae = document.activeElement
    if (ae && ae.closest && ae.closest('#htmx-sidebar, dialog')) return
    e.preventDefault()
    toggleAskFocus()
  })

  // TRANSITIONAL markdown-mode chord transport (quarantined legacy glue; P2.C
  // owns the proper chord migration). The markdown surface handles NO app-level
  // chords — Mod+S / Mod+J bubble from its textarea to here. Guarded on
  // mode==='markdown' so the wysiwyg PM keymap path (editorProps handleKeyDown,
  // pre-core per the interaction contract) never double-fires.
  document.addEventListener('keydown', function (e) {
    if (currentMode !== 'markdown') return
    if (e.key === 's' && window.isMod(e)) {
      e.preventDefault()
      flushSave()
    } else if (e.key === 'j' && window.isMod(e)) {
      e.preventDefault()
      toggleAiBlocks()
    }
  })

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
    sieveInsertPos = captureInsertPos(kindIsInline('smart-card'))
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
    sieveInsertPos = captureInsertPos(kindIsInline('web-clip'))
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

  // Jump back to the editor, restoring the caret to where we were when we entered
  // the Ask box. Focus and panel visibility are independent: only hide if unpinned.
  function returnToEditor() {
    if (!isAskPanelPinned && askDialog) askDialog.classList.remove('is-open')
    // Restore wherever we were on jump-in: main editor caret, a block's inner
    // editor caret, or the markdown textarea. restoreFocusContext re-resolves by
    // position against the current doc, so a doc edit while we were in the box
    // can't make the restore silently throw.
    window.TipTap.restoreFocusContext(currentEditor, focusReturn)
  }

  function doAsk(textarea, panel) {
    var val = textarea.value.trim()
    if (!val) return

    var ctx
    if (pendingAskCtx) {
      ctx = pendingAskCtx
    } else {
      // Resolve once at SEND. Apply the == highlight ONLY for a live selection —
      // the one mutating case (D-r.7: just the mark; the block already has an id).
      var t = window.TipTap.resolveAiTarget(currentEditor, currentMode === 'markdown')
      if (t.kind === 'selection' && currentMode !== 'markdown') {
        window.TipTap.applyTargetHighlight(currentEditor)
      }
      ctx = window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', getMarkdown(), currentUuid)
    }

    runAiJob('ask', val, ctx)
    pendingAskCtx = null
    textarea.value = ''
    if (currentEditor) window.TipTap.clearAiTargetGlow(currentEditor.view)
    if (!isAskPanelPinned) panel.classList.remove('is-open')
    // SEND is a doc-mutating action, so focus FOLLOWS the action rather than
    // restoring the pre-ask caret: a selection got wrapped in an anchor and the
    // answer block is about to be inserted, which makes the captured position
    // stale anyway. Hand focus back to the editor (never leave it in the box) and
    // collapse the caret to the END of the target — right where the answer lands.
    // (Ctrl+Shift+A jump-out, which is navigation not action, still restores
    // the exact context via returnToEditor.)
    if (currentEditor) {
      currentEditor.view.focus()
      try { currentEditor.commands.setTextSelection(currentEditor.state.selection.to) } catch (e) {}
    }
    focusReturn = null
  }

  // ── AI jobs ───────────────────────────────────────────────────────────────────

  // softReloadContent fetches the latest body from disk and replaces editor content,
  // preserving the cursor position. Called when an ai:block-resolved SSE event arrives,
  // and after extract/paste operations that re-render from the ShadowDoc.
  function softReloadContent(uuid) {
    if (currentMode !== 'wysiwyg' && currentMode !== 'markdown') return
    if (currentMode === 'wysiwyg' && !currentEditor) return
    aiReloadInProgress = true
    // Capture focus context before the async fetch so caret is preserved across
    // the re-render (covers TRANSFORM, paste, extract, and AI block resolve).
    var fctx = (currentMode === 'wysiwyg' && window.TipTap && window.TipTap.captureFocusContext)
      ? window.TipTap.captureFocusContext(currentEditor)
      : null
    fetch('/api/editor/load?uuid=' + encodeURIComponent(uuid))
      .then(function (r) { return r.json() })
      .then(function (data) {
        if (currentUuid !== uuid) { aiReloadInProgress = false; return }
        var body = data.body || ''
        var ed = _activeEditor()
        var surface = ed && ed.surface
        if (currentMode === 'wysiwyg' && currentEditor && surface) {
          // Wysiwyg renders the backend's AUTHORITATIVE block list — markdown is
          // NOT a wysiwyg render input. A flat setContent(body) re-parse ignores
          // block boundaries and invents ids, fragmenting a multi-node prose block
          // and losing its id (the embed bug). The doc structure + every id come
          // from data.blocks; reloadFromBlocks + proseBlockNodes wrap a multi-
          // node block into ONE container carrying its id. (Per-block prose content
          // is still markdown, but rendered WITHIN its own block by the block list —
          // it never crosses a boundary.) No setContent fallback: there is no
          // markdown render path for wysiwyg.
          surface.reloadFromBlocks(data.blocks || [], { allowEmpty: true })
          aiReloadInProgress = false
          if (window.TipTap && window.TipTap.restoreFocusContext) {
            window.TipTap.restoreFocusContext(currentEditor, fctx)
          }
        } else if (currentMode === 'markdown' && surface) {
          surface.replaceBody(body)
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

      var ctx = precomputedCtx || window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', getMarkdown(), currentUuid)
      var refId = (ctx && ctx.blockRef) || 'doc'
      var blockType = type === 'explain' ? 'EXPLAIN' : 'ASK'

      // Insert the answer AFTER the caret's top-level block — never at the caret,
      // which would split the paragraph into first-half / answer / second-half.
      // An AI block is always a block kind. See blockInsertPos in ai-target.js.
      sieveInsertPos = captureInsertPos(false)

      flushSave().then(function () {
        sendCreateBlock('ai-block', { type: blockType, ref: refId, question: question || '' })
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

    // Caret inside a raw-text fenced block (code / diagram / log — code:true
    // nodes): paste is a literal text paste into that block, not a smart-paste
    // that mints a new block. Step aside; PM's default handler inserts the text.
    if (window.TipTap && window.TipTap.caretInRawTextBlock &&
        window.TipTap.caretInRawTextBlock(currentEditor)) {
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

    // ── 1b. sieve/slice → server-side reconstruct ───────────────────────────────
    // A multi-block slice ([][]ContentEntry) is reconstructed by Go: FirstPasteMatch
    // per item → a block at cursorIndex+i with a fresh backend id (prose claims its
    // sieve/prose). Each created block render-backs via insert-block at its index.
    // A single-block slice falls through to the smart-paste pipeline, which resolves
    // it from its sieve/<kind> view the same way.
    var sliceData = event.clipboardData.getData('sieve/slice')
    if (sliceData && currentUuid && !currentUuid.startsWith('prompt:')) {
      try {
        var slice = JSON.parse(sliceData)
        if (Array.isArray(slice) && slice.length > 1) {
          event.preventDefault()
          var sliceIndex = commitInsertIndex(captureInsertPos(false))
          sieveInsertPos = null // slice render-backs position by op index, not this
          fetch('/api/editor/paste-slice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uuid: currentUuid, slice: slice, index: sliceIndex }),
          }).catch(function (err) { console.error('[editor.js] paste-slice failed', err) })
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

        // Smart-paste resolves a block kind server-side (web-clip / smart-image /
        // smart-card) → capture insert position as a block index for Go to position.
        var smartPasteIndex = commitInsertIndex(captureInsertPos(false))
        event.preventDefault()

        Promise.all(promises).then(function(results) {
          var validEntries = results.filter(function(r) { return r !== null })
          fetch('/api/editor/smart-paste', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uuid: currentUuid, entries: validEntries, index: smartPasteIndex }),
          })
            .then(function (r) { return r.json() })
            .then(function (result) {
              if (!currentEditor) return
              if (result.matched) {
                // Rendered via insert-block (tracked insert at its server index). Nothing to do.
              } else {
                // No processor matched — replay original clipboard content locally.
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
      var dropIndex = commitInsertIndex(insertPos)

      event.preventDefault()

      Promise.all(promises).then(function(results) {
        var validEntries = results.filter(function(r) { return r !== null })
        if (validEntries.length === 0) return
        fetch('/api/editor/smart-paste', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid: currentUuid, entries: validEntries, index: dropIndex }),
        })
          .then(function (r) { return r.json() })
          .then(function (result) {
            if (!currentEditor) return
            if (result.matched) {
              // Rendered via insert-block (tracked insert at its server index). Nothing to do.
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

  function toggleMode() {
    // P2.B: the mode flip is NoteEditor.setMode — an AWAITED in-place surface
    // swap (flush → enter-markdown/enter-wysiwyg → await markdown-content/
    // wysiwyg-content → swap). The old teardown-then-one-shot-listener dance is
    // gone: nothing is unmounted until the server replies, so a timeout leaves
    // the editor fully functional in its current mode (stay-on-failure), and
    // the WS channel + editor instance survive every flip. A reentrant toggle
    // coalesces onto the in-flight flip inside setMode.
    var ed = _activeEditor()
    if (!ed || !ed.surface) return
    var target = (ed.mode === 'markdown') ? 'wysiwyg' : 'markdown'
    ed.setMode(target)
      .then(function (changed) {
        if (!changed) return
        tabModes[currentUuid] = ed.mode
        updateModeUI()
        dispatchStats()
        if (window.htmx) window.htmx.ajax('GET', '/api/tabs', { target: '#htmx-tabbar', swap: 'innerHTML' })
      })
      .catch(function (err) {
        console.error('[editor] mode toggle failed; staying in ' + ed.mode, err)
        window.alert('Mode switch failed — staying in ' + ed.mode + ' mode.')
      })
  }

  function updateModeUI() {
    document.body.classList.toggle('markdown-mode', currentMode === 'markdown')
    var toggleBtn = document.getElementById('tb-toggle-mode-btn')
    if (toggleBtn && window.SieveIcons) {
      toggleBtn.innerHTML = window.SieveIcons[currentMode === 'markdown' ? 'eye' : 'markdown']
      toggleBtn.title = currentMode === 'markdown' ? 'Return to WYSIWYG' : 'View Markdown Source'
    }
  }

  document.addEventListener('sieve:toggle-mode',      toggleMode)
  document.addEventListener('sieve:toggle-search',    toggleSearch)
  document.addEventListener('sieve:toggle-ai-blocks', toggleAiBlocks)

  // ── Block-insertion menu chords (App-Level Chords) ────────────────────────────
  // The native menu owns Mod+Shift+W/L/D (docs/editor-interaction-contract.md);
  // each accelerator dispatches one of these events, which open the same insert
  // dialog / create the same block the toolbar buttons do.
  document.addEventListener('sieve:insert-webclip', function () {
    ensureOverlays()
    openInternalizeDialog()
  })
  document.addEventListener('sieve:insert-url-card', function () {
    ensureOverlays()
    openSmartCardDialog()
  })
  document.addEventListener('sieve:insert-diagram', function () {
    if (!currentUuid || !currentEditor) return
    sendCreateBlock('diagram', {})
  })

  // Copy as Markdown (File › Export › Clipboard (Markdown)). Fetch the server's
  // clean whole-doc export (ai-blocks filtered, cards/clips reduced to links) and
  // copy it to the clipboard. A native menu click carries no DOM user gesture and
  // steals document focus, so WebKit rejects navigator.clipboard here — the Wails
  // native pasteboard (runtime.ClipboardSetText) is the primary path; the browser
  // API is only the fallback for non-Wails (plain browser) dev.
  // No toast system exists, so feedback is left to the OS clipboard affordance.
  document.addEventListener('sieve:export-markdown', function () {
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
  })

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
    // ids, then persist that corruption on save-back. softReloadContent renders via
    // the block list and guards the save-back (aiReloadInProgress).
    if (data && data.uuid) softReloadContent(data.uuid)
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
    var href = e.detail.href
    var fromPos = e.detail.fromPos
    var fromSize = e.detail.fromSize
    var mode = e.detail.mode || 'fetch'
    if (!href || fromPos == null) return
    // Delete the smart-card block first, then insert web-clip at its position
    currentEditor.view.dispatch(currentEditor.state.tr.delete(fromPos, fromPos + fromSize))
    sieveInsertPos = fromPos
    sendCreateBlock('web-clip', { source: href, mode: mode })
  })

  // ── Extract / Transform (sieve:extract) ─────────────────────────────────────
  // Dumb playback: post {operation, targetKind, entries, blockId}. The backend mutates
  // (PASTE/EXTRACT -> new block via insert-block; TRANSFORM -> ReplaceBlock on its tree,
  // then a replace-block render-back the editor answers by re-rendering). The frontend
  // never swaps nodes itself.
  document.addEventListener('sieve:extract', function (e) {
    if (!currentUuid || !currentEditor) return
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
    sieveInsertPos = null
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
