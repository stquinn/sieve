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
  // Stage D.3: the WYSIWYG observer flushes the pending block-sync immediately on
  // demand (tab switch / save). Set by mountWysiwyg, called by flushSave.
  var docSyncFlush = null
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
          mountWysiwyg(mountEl, uuid, data.body || '', data.blocks)
        }
        tabModes[uuid] = currentMode
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

  // ── WYSIWYG mode ─────────────────────────────────────────────────────────────

  // renderBlocksIntoEditor replaces the whole document with content built from
  // the block list. It uses the editor's live markdownit (carrying the fence
  // parse rules) to render each block to HTML, then parses that HTML through
  // ProseMirror's DOMParser and swaps it in via a single non-undoable
  // transaction. This is the proven syncMd pattern scaled to the whole doc: it
  // reuses each node's parseHTML, so no ProseMirror JSON is ever hand-built.
  function renderBlocksIntoEditor(editor, blocks) {
    var mdRender = function (t) { return editor.storage.markdown.parser.md.render(t) }
    var PMDP = window.TipTap.ProseMirrorDOMParser || window.TipTap.DOMParser
    var parser = PMDP.fromSchema(editor.state.schema)

    // Parse each block in ISOLATION so one block with content the schema rejects
    // (e.g. a sieve node or raw HTML that slipped into prose) is logged + skipped
    // instead of aborting the whole document render (which dropped EVERY block).
    var nodes = []
    ;(blocks || []).forEach(function (b, i) {
      var bhtml = window.TipTap.buildBlocksHTML([b], mdRender)
      try {
        var tmp = document.createElement('div')
        tmp.innerHTML = bhtml.trim()
        if (b.kind === 'prose') {
          // Node-granular: a prose block renders to its NATIVE top-level node(s).
          // Stamp the block id onto the FIRST top-level element so
          // addGlobalAttributes(id) carries it onto that node; a legacy
          // multi-paragraph run parses to N nodes — only the first keeps the
          // loaded id, the rest are id-less (minted on first sync, D-r.4). Push
          // every parsed top-level node (they are all valid blocks now).
          if (b.id && tmp.firstElementChild) tmp.firstElementChild.setAttribute('data-id', b.id)
          var emitted = 0
          parser.parse(tmp).content.forEach(function (n) { nodes.push(n); emitted++ })
          if (!emitted) {
            console.error('[editor] prose block ' + i + ' (' + (b.id || '') + ') produced no node from:\n' + bhtml.trim().slice(0, 200))
          }
        } else {
          // Structured: take ONLY the sieve-<kind> node we expect, ignoring any
          // stray nodes the parse invents. The shadow is authoritative.
          var want = 'sieve-' + b.kind
          var pushed = 0
          parser.parse(tmp).content.forEach(function (n) {
            if (n.type.name === want) { nodes.push(n); pushed++ }
          })
          if (!pushed) {
            console.error('[editor] block ' + i + ' (' + b.kind + ' ' + (b.id || '') + ') produced no ' + want + ' node from:\n' + bhtml.trim().slice(0, 200))
          }
        }
      } catch (e) {
        console.error('[editor] block ' + i + ' (' + b.kind + ' ' + (b.id || '') + ') failed to render:', e, '\n--- HTML ---\n' + bhtml)
      }
    })
    if (!nodes.length) return // nothing valid parsed — keep the existing content
    var tr = editor.state.tr
    tr.replaceWith(0, editor.state.doc.content.size, nodes)
    tr.setMeta('addToHistory', false)
    editor.view.dispatch(tr)
  }

  function mountWysiwyg(el, uuid, body, blocks) {
    var T = window.TipTap
    var initialized = false
    var suppressUpdate = false
    // Per-editor block-sync cache: { [blockId]: serializedContent } as of the
    // last successful sync. The thin observer (Stage D.3) diffs against it.
    var blockContentCache = null

    // Serialize one top-level block to the (id, kind, content) the sync diff
    // needs (node-granular, 2026-06-19). A structured sieve block → its
    // serialisedForm fence, keyed by its `id`. EVERY OTHER top-level node is a
    // prose block: a NATIVE TipTap node (paragraph/heading/list/table/…) whose
    // identity is its `id` attr and whose content is its CLEAN markdown
    // (native nodes never embed markers — Go re-wraps on save). No node returns
    // null now, so the observer never falls back merely on node type.
    function topBlockTriple(ed, node) {
      var name = node.type.name
      if (name.indexOf('sieve-') === 0) {
        return { id: node.attrs.id || '', kind: node.attrs.kind || name, content: node.attrs.serialisedForm || '' }
      }
      var content = (window.TipTap.serializeNode(ed, node) || '').trim()
      return { id: node.attrs.id || '', kind: 'prose', content: content }
    }

    function collectTopBlocks(ed) {
      var out = []
      var doc = ed.state.doc
      for (var i = 0; i < doc.childCount; i++) {
        var t = topBlockTriple(ed, doc.child(i))
        if (!t) return null
        out.push(t)
      }
      return out
    }

    // Seed the sync baseline from GO's view (the server block list), NOT the
    // editor — so a block PM created client-side (e.g. the prose block an empty
    // doc createAndFills, or a split) is absent from the baseline and the first
    // sync emits a create-block for it. Seeding from the editor would hide such a
    // block from Go forever (its update-block would fail "block not found"). For a
    // loaded doc the server blocks ARE the editor blocks, so nothing spurious.
    function seedBlockCache(serverBlocks) {
      var triples = (serverBlocks || []).map(function (b) {
        return {
          id: b.id,
          kind: b.kind,
          // Uniform wire shape: prose body rides in attrs.content (proseContent),
          // structured signs on its stable serialisedForm.
          content: b.kind === 'prose' ? window.TipTap.proseContent(b) : (b.serialisedForm || ''),
        }
      })
      // seedBaseline includes EVERY id'd server block (even an empty one) so the
      // first edit to a loaded block is an update-block, never a duplicate create.
      blockContentCache = window.TipTap.seedBaseline
        ? window.TipTap.seedBaseline(triples)
        : {}
    }

    function sendDocUpdate(ed, id) {
      var md = wysiwygMarkdown(ed)
      lastSyncedBody = md
      wsSend({ type: 'doc-update', uuid: id, markdown: md })
    }

    // syncDocument is the debounced wire send: prefer granular block-ops, fall
    // back to a whole-document doc-update only when computeBlockSync says so. As
    // of D-r.5 that fallback fires ONLY for a structured-block edit (Go's
    // structured update-block takes parsed Attrs the client can't rebuild from a
    // fence) — prose is fully granular (an id-less prose node is pending, not a
    // fallback). Markdown mode keeps its own raw doc-update path, outside here.
    // It NEVER mutates the document — pure read + send.
    function syncDocument(ed, id) {
      var curr = collectTopBlocks(ed)
      if (!curr || !window.TipTap.computeBlockSync) { sendDocUpdate(ed, id); return }
      var r = window.TipTap.computeBlockSync(curr, blockContentCache)
      blockContentCache = r.next
      if (r.mode === 'fallback') { sendDocUpdate(ed, id); return }
      r.ops.forEach(function (op) { wsSend({ type: 'block-op', uuid: id, op: op }) })
    }

    // Node-granular (2026-06-19): the doc top level holds NATIVE block nodes
    // (paragraph/heading/list/table/blockquote/…, group "block") AND structured
    // sieve blocks (group "sieveBlock") as siblings — a prose block IS one native
    // top-level node, not a custom container. The retired `sieveBlock+` schema
    // (+ its per-keystroke wrapper / minter / trailing-surface plugin) is gone;
    // PM owns node creation/splitting/merging natively. Identity rides on each
    // native node's `id` attr (T.BlockId, addGlobalAttributes); minting is
    // a passive observe-time concern (D-r.4), never a doc mutation here.
    var SieveDocument = T.Node.create({ name: 'doc', topNode: true, content: '(block | sieveBlock)+' })

    var editor = new T.Editor({
      element: el,
      extensions: [
        SieveDocument,
        T.BlockId,
        // trailingNode:false — we let PM's native Gapcursor place a caret after a
        // trailing atom (structured) block; typing there creates a real native
        // paragraph (a new prose block). No fabricated trailing surface.
        T.StarterKit.configure({ document: false, link: false, codeBlock: false, trailingNode: false, history: { depth: 10000, newGroupDelay: 500 } }),
        T.Placeholder.configure({ placeholder: function (p) { return p.editor.isEmpty ? 'Start writing\u2026' : '' } }),
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
      // Seed one empty native paragraph — the default editing surface of a new
      // doc. renderBlocksIntoEditor replaces it for a non-empty doc; an empty doc
      // keeps this typeable paragraph (a prose block; its id is minted on
      // first sync, D-r.4). A native <p> is a valid top-level node under the new
      // (block | sieveBlock)+ schema, so no custom container is needed.
      content: '<p></p>',
      editorProps: {
        attributes: { spellcheck: 'true' },
        handleDOMEvents: {
          copy: function(view, event) {
            // Copy is delegated to ProseMirror now that sieve blocks are real PM nodes.
            // text/plain + text/html are whatever PM produces. This handler only steps
            // in for the two things PM can't express:
            //   (1) smart-image → copy the actual bitmap, and
            //   (2) a WHOLE-block copy (single sieve NodeSelection or a gutter
            //       block-range) → ADD sieve/slice + sieve/<kind> so smart paste can
            //       rebuild the proper kind. We mirror PM's text/plain (the block's
            //       serialisedForm) and provide a richer text/html from the rendered DOM.
            // Sub-text highlights, bare cursors, and prose all fall through to native.
            var sel = view.state.selection

            // (1) Smart-image bitmap.
            if (sel && sel.node && sel.node.type.name === 'sieve-smart-image') {
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

            // Whole-block? Either a gutter block-range, or a NodeSelection on a sieve node.
            var er = (window.TipTap && window.TipTap.getBlockSelectionRange)
              ? window.TipTap.getBlockSelectionRange(view)
              : { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false }
            var isSieveNodeSel = !!(sel.node && sel.node.type && String(sel.node.type.name).indexOf('sieve-') === 0)
            if (!er.isBlockRange && !isSieveNodeSel) return false   // ← native ProseMirror

            var blockHTML = function (dom) {
              if (!dom) return ''
              var clone = dom.cloneNode(true)
              var ch = clone.querySelector('.block-chrome-host')
              if (ch) ch.remove()
              return clone.outerHTML
            }

            var sliceItems = []
            var plainParts = []
            var htmlParts = []
            var hasSieve = false
            var singleSieveKind = null
            var singleSieveForm = ''

            view.state.doc.forEach(function (node, offset) {
              var nodeEnd = offset + node.nodeSize
              if (nodeEnd <= er.from || offset >= er.to) return
              var dom = view.nodeDOM(offset)
              if (String(node.type.name).indexOf('sieve-') === 0) {
                hasSieve = true
                singleSieveKind = node.attrs.kind
                singleSieveForm = node.attrs.serialisedForm || ''
                var attrs = {}
                for (var k in node.attrs) {
                  if (Object.prototype.hasOwnProperty.call(node.attrs, k)) attrs[k] = node.attrs[k]
                }
                sliceItems.push({ _type: 'sieve', kind: node.attrs.kind, attrs: attrs })
                plainParts.push(node.attrs.serialisedForm || '')
                htmlParts.push(blockHTML(dom))
              } else {
                sliceItems.push({ _type: 'prose', json: node.toJSON() })
                plainParts.push(dom ? dom.innerText : '')
                htmlParts.push(blockHTML(dom))
              }
            })

            if (!hasSieve) return false   // no sieve block in range — let PM handle it natively

            event.preventDefault()
            event.clipboardData.setData('text/plain', plainParts.filter(Boolean).join('\n\n'))
            event.clipboardData.setData('text/html', htmlParts.filter(Boolean).join('\n'))
            event.clipboardData.setData('sieve/slice', JSON.stringify(sliceItems))
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
        if (!initialized || suppressUpdate) return
        // Stage D.3: the thin observer. We no longer serialize the whole document
        // on every keystroke — onUpdate only marks dirty and (re)arms a debounce.
        // The actual diff + wire send happens once typing settles, in
        // syncDocument, which prefers granular block-ops and falls back to a
        // whole-document doc-update only when a block can't be addressed yet.
        document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
        document.dispatchEvent(new CustomEvent('editor:changed'))
        dispatchStats()
        if (docUpdateTimer) clearTimeout(docUpdateTimer)
        docUpdateTimer = setTimeout(function () {
          docUpdateTimer = null
          syncDocument(editor, uuid)
        }, 500)
      },
    })

    currentEditor = editor
    window.__tiptap = editor

    // Stage D.2: the block list IS the document model. When the load supplied it,
    // render the document from the blocks (prose → native node(s); structured →
    // its fence rule), bypassing the markdown `content:` seed above. We build the
    // HTML with the editor's OWN markdownit (so the fence parse rules are live)
    // and parse it through ProseMirror's DOMParser — reusing every node's
    // parseHTML, never hand-building ProseMirror JSON. suppressUpdate guards the
    // initial replace so it isn't mistaken for a user edit / doc-update.
    if (blocks && blocks.length && window.TipTap.buildBlocksHTML) {
      suppressUpdate = true
      try {
        renderBlocksIntoEditor(editor, blocks)
        lastSyncedBody = wysiwygMarkdown(editor) || lastSyncedBody
      } catch (err) {
        console.error('[editor] block render failed; keeping markdown seed', err)
      } finally {
        suppressUpdate = false
      }
    }

    // Seed the block-sync baseline from GO's block list (what the server has),
    // so a PM-created block (empty-doc fill / split) is seen as new and synced.
    seedBlockCache(blocks)

    // Expose an immediate flush of the pending debounced sync (used by flushSave
    // / tab switch / mode toggle). Cleared by mountMarkdown so a stale wysiwyg
    // flush can't fire against a destroyed editor.
    docSyncFlush = function () {
      if (!docUpdateTimer) return
      clearTimeout(docUpdateTimer)
      docUpdateTimer = null
      syncDocument(editor, uuid)
    }

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
    // No WYSIWYG editor here — drop any block-sync flush from a prior mount so
    // flushSave can't run syncDocument against a destroyed editor.
    docSyncFlush = null

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
    // Flush any pending debounced sync immediately so Go has the latest content.
    // WYSIWYG goes through the block-sync flush (granular ops or doc-update
    // fallback); markdown mode sends its raw textarea body directly.
    if (currentMode === 'markdown') {
      if (docUpdateTimer) {
        clearTimeout(docUpdateTimer)
        docUpdateTimer = null
        wsSend({ type: 'doc-update', uuid: currentUuid, markdown: lastSyncedBody })
      }
    } else if (docSyncFlush) {
      docSyncFlush()
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
      if (msg.type === 'wysiwyg-content') {
        document.dispatchEvent(new CustomEvent('editor:wysiwyg-content', { detail: msg }))
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
    sieveInsertPos = captureInsertPos(kindIsInline(e.detail.kind))
    var attrs = e.detail.attrs || {}
    if (e.detail.kind === 'diagram' && !attrs.source) {
      attrs.mode = 'edit'
    }
    wsSend({ type: 'create-block', kind: e.detail.kind, attrs: attrs, uuid: currentUuid })
  })

  // Explicitly capture insertion position for async flows (like image upload).
  // These insert block kinds (smart-image / web-clip), so capture as a block.
  document.addEventListener('sieve:capture-insert-pos', function () {
    sieveInsertPos = captureInsertPos(false)
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

    var nodeType = currentEditor.schema.nodes[newBlock.type]
    if (nodeType && nodeType.spec.content) {
      if (nodeType.spec.content.indexOf('block') !== -1) {
        newBlock.content = [{ type: 'paragraph' }]
      } else if (nodeType.spec.content.indexOf('text') !== -1 && attrs.source) {
        newBlock.content = [{ type: 'text', text: attrs.source }]
      }
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

    // Bring the new block into view. Async answer blocks (ask/explain) carry no
    // focus, so they can land below the fold and get lost; deferred so the
    // NodeView has rendered, 'nearest' so it doesn't jump when already visible.
    var blkId = msg.id || parsed.id
    if (blkId) {
      setTimeout(function () {
        var node = document.querySelector('[data-id="' + blkId + '"]')
        if (node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }, 60)
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
            tr.setMeta('addToHistory', false)
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

  // wysiwygMarkdown serializes the live editor document to disk markdown,
  // node-granular (2026-06-19): each TOP-LEVEL node is one block. Structured
  // sieve blocks self-delimit (their fence carries id: in YAML); every native
  // node (a prose block) is wrapped in its paired <!--s:ID-->…<!--/s:ID-->
  // markers via wrapProseBlock, so a whole-document round-trip (doc-update
  // fallback / save / markdown-mode toggle) preserves block identity byte-for-
  // byte and matches Go's SerializeBlockDocWithHandles. serializeNode renders
  // each node through the editor's own markdown serializer (never hand-built).
  function wysiwygMarkdown(ed) {
    if (!ed) return ''
    var T = window.TipTap
    var prose = T.getBlockKind ? T.getBlockKind('prose') : null
    var parts = []
    ed.state.doc.forEach(function (node) {
      var md = (T.serializeNode(ed, node) || '').trim()
      if (!T.isNativeProseNodeName(node.type.name)) {
        // Structured sieve block: self-delimiting fence (id: in YAML).
        if (md) parts.push(md)
        return
      }
      // Native node = prose block. The prose kind's toMarkdown wraps it in paired
      // delimiters (and emits bare content when the node has no id yet — Go mints).
      var wrapped = prose ? prose.toMarkdown(node.attrs.id || '', md) : md
      if (wrapped) parts.push(wrapped)
    })
    return parts.join('\n\n')
  }

  function getMarkdown() {
    if (currentMode === 'markdown') return lastSyncedBody
    if (!currentEditor) return ''
    return wysiwygMarkdown(currentEditor)
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
    sieveInsertPos = captureInsertPos(kindIsInline('web-clip'))
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
      ctx = window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', lastSyncedBody, currentUuid)
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

      // Insert the answer AFTER the caret's top-level block — never at the caret,
      // which would split the paragraph into first-half / answer / second-half.
      // An AI block is always a block kind. See blockInsertPos in ai-target.js.
      sieveInsertPos = captureInsertPos(false)

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
            var result = { type: 'sieve-' + entry.kind, attrs: pasteAttrs }
            if (currentEditor) {
              var nodeType = currentEditor.schema.nodes[result.type]
              if (nodeType && nodeType.spec.content) {
                if (nodeType.spec.content.indexOf('block') !== -1) {
                  result.content = [{ type: 'paragraph' }]
                } else if (nodeType.spec.content.indexOf('text') !== -1 && pasteAttrs.source) {
                  result.content = [{ type: 'text', text: pasteAttrs.source }]
                }
              }
            }
            return result
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

        // Smart-paste resolves a block kind server-side (web-clip / smart-image /
        // smart-card) → capture as a block (after the top-level node).
        sieveInsertPos = captureInsertPos(false)
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
      // Drop any pending markdown doc-update — we hand the latest content to the
      // server via enter-wysiwyg below, and a late timer must not fire post-switch.
      if (docUpdateTimer) { clearTimeout(docUpdateTimer); docUpdateTimer = null }
    } else if (currentEditor) {
      // Flush any pending block-sync so Go's shadow is current before it merges
      // the markdown view (enter-markdown serializes the shadow, not local md).
      if (docSyncFlush) docSyncFlush()
      content = wysiwygMarkdown(currentEditor)
    } else {
      content = lastSyncedBody
    }
    lastSyncedBody = content
    currentMode = newMode
    tabModes[currentUuid] = currentMode
    updateModeUI()
    
    if (currentEditor) { currentEditor.destroy(); currentEditor = null; window.__tiptap = null }
    currentMountEl.innerHTML = ''
    
    if (currentMode === 'wysiwyg') {
      // Symmetric to the markdown branch: hand the current markdown to the server,
      // which reparses the authoritative Doc and returns the blocks. We mount the
      // WYSIWYG editor from THOSE blocks (so ids from the markers survive) — not
      // from a blockless mountWysiwyg, which would render only the empty seed and
      // stay blank until a tab switch reloaded it.
      document.addEventListener('editor:wysiwyg-content', function onWyContent(e) {
        if (e.detail.uuid !== currentUuid) return
        if (currentMode !== 'wysiwyg') return  // user toggled back before response arrived
        document.removeEventListener('editor:wysiwyg-content', onWyContent)
        mountWysiwyg(currentMountEl, currentUuid, content, e.detail.blocks)
        dispatchStats()
        if (window.htmx) window.htmx.ajax('GET', '/api/tabs', { target: '#htmx-tabbar', swap: 'innerHTML' })
      }, { once: true })
      wsSend({ type: 'enter-wysiwyg', uuid: currentUuid, markdown: content })
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
