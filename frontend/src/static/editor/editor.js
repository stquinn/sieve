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

  // blockIndexForInsert maps a captured insert position (a PM doc position, or null
  // for "append") to the top-level BLOCK index Go's create-block op inserts at —
  // the number of top-level nodes that end at or before the position.
  // Delegates to the tested window.TipTap.blockIndexForInsert (block-position.js).
  function blockIndexForInsert(pos) {
    if (!currentEditor) return -1
    return window.TipTap.blockIndexForInsert(currentEditor.state.doc, pos)
  }

  // docPosForBlockIndex maps a top-level BLOCK index (Go's tree position, echoed on
  // insert-block) to the editor doc position before that node — so a render-back
  // lands where Go put it, even for a batch (a paste slice).
  // Delegates to the tested window.TipTap.docPosForBlockIndex (block-position.js).
  function docPosForBlockIndex(editor, idx) {
    return window.TipTap.docPosForBlockIndex(editor.state.doc, idx)
  }

  // noteServerBlock is set by mountWysiwyg — baselines a server-created block into
  // the sync cache so the observer treats it as already-present (never re-creates it).
  var noteServerBlock = null

  // reconcilePendingToken is set by mountWysiwyg — the insert-block token ack runs at
  // module scope and cannot see blockContentCache (mountWysiwyg-private); this seam
  // mirrors noteServerBlock.
  var reconcilePendingToken = null

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
      if (docSyncFlush) docSyncFlush()
    }
    return anchor.index
  }

  // sendCreateBlock is the ONE UI-triggered create path: a create-block block-op
  // carrying kind, attrs, and the document index from the captured insert position
  // (sieveInsertPos). There is no separate create-block message — every kind creates
  // through block-op, exactly like update/delete. Go positions it via the index and
  // renders it back (insert-block) for structured kinds.
  function sendCreateBlock(kind, attrs) {
    if (!currentUuid) return
    wsSend({
      type: 'block-op',
      uuid: currentUuid,
      op: { type: 'create-block', kind: kind, attrs: attrs || {}, index: commitInsertIndex(sieveInsertPos) },
    })
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
  // blockToNodes renders ONE block (prose or structured) to its ProseMirror
  // node(s) via the editor's live markdownit + each node's parseHTML — the single
  // place that knows how a block becomes editor nodes. Shared by the whole-document
  // load (renderBlocksIntoEditor) and the per-block render-back (insert-block), so a
  // server-created block renders identically however it arrives. Parsed in
  // ISOLATION so a block the schema rejects is logged + skipped, never aborting.
  function blockToNodes(editor, b) {
    var mdRender = function (t) { return editor.storage.markdown.parser.md.render(t) }
    var PMDP = window.TipTap.ProseMirrorDOMParser || window.TipTap.DOMParser
    var parser = PMDP.fromSchema(editor.state.schema)
    var bhtml = window.TipTap.buildBlocksHTML([b], mdRender)
    var out = []
    try {
      var tmp = document.createElement('div')
      tmp.innerHTML = (bhtml || '').trim()
      if (b.kind === 'prose') {
        // A prose block parses to its NATIVE top-level node(s); proseBlockNodes
        // stamps the block id (one node → that node; >1 → one proseGroup container).
        var produced = window.TipTap.proseBlockNodes(parser.parse(tmp).content, b.id || '', editor.state.schema)
        if (!produced.length) console.error('[editor] prose block (' + (b.id || '') + ') produced no node from:\n' + (bhtml || '').trim().slice(0, 200))
        produced.forEach(function (n) { out.push(n) })
      } else {
        // Structured: take ONLY the sieve-<kind> node, ignoring stray parse output.
        var want = 'sieve-' + b.kind
        parser.parse(tmp).content.forEach(function (n) { if (n.type.name === want) out.push(n) })
        if (!out.length) console.error('[editor] block (' + b.kind + ' ' + (b.id || '') + ') produced no ' + want + ' node from:\n' + (bhtml || '').trim().slice(0, 200))
      }
    } catch (e) {
      console.error('[editor] block (' + b.kind + ' ' + (b.id || '') + ') failed to render:', e, '\n--- HTML ---\n' + bhtml)
    }
    return out
  }

  // renderBlocksIntoEditor replaces the whole document with the block list, each
  // block rendered via blockToNodes, swapped in via one non-undoable transaction.
  // opts.allowEmpty — when true, a genuinely-empty block list clears the editor
  // to one empty paragraph instead of keeping stale content. Set only by the
  // known-good reload caller (softReloadContent); omit for all other callers.
  function renderBlocksIntoEditor(editor, blocks, opts) {
    var nodes = []
    ;(blocks || []).forEach(function (b) {
      blockToNodes(editor, b).forEach(function (n) { nodes.push(n) })
    })
    var replacement = window.TipTap.reloadReplacement(nodes, opts || {}, editor.state.schema)
    if (replacement === null) return // keep existing content (transient empty)
    var tr = editor.state.tr
    tr.replaceWith(0, editor.state.doc.content.size, replacement)
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
    // needs (node-granular, 2026-06-19). A structured sieve block's `content` is a
    // change-SIGNATURE only (never emitted as an op): the JSON of its attrs, which
    // changes iff its persistent state does — no markdown produced. EVERY OTHER
    // top-level node is a prose block: a NATIVE TipTap node (paragraph/heading/
    // list/table/…) whose identity is its `id` attr and whose content is its CLEAN
    // markdown (native nodes never embed markers — Go re-wraps on save). No node
    // returns null now, so the observer never falls back merely on node type.
    function topBlockTriple(ed, node) {
      var name = node.type.name
      if (name.indexOf('sieve-') === 0) {
        return { id: node.attrs.id || '', kind: node.attrs.kind || name, content: JSON.stringify(window.TipTap.sieveBlockAttrs(node)) }
      }
      var content = (window.TipTap.serializeNode(ed, node) || '').trim()
      return { id: node.attrs.id || '', kind: 'prose', content: content, token: node.attrs.token || '' }
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
      // Structured signature is the JSON of the rendered node's attrs (topBlockTriple's
      // derivation). The SERVER block's attrs would stringify differently (key order,
      // schema defaults) and phantom-flag a change on the first diff, so read the
      // structured baseline straight off the just-rendered editor, keyed by id.
      var structuredSig = {}
      collectTopBlocks(editor).forEach(function (t) {
        if (t.kind !== 'prose' && t.id) structuredSig[t.id] = t.content
      })
      var triples = (serverBlocks || []).map(function (b) {
        return {
          id: b.id,
          kind: b.kind,
          // Prose body rides in attrs.content (proseContent); structured signs on
          // the attrs-hash derived from its rendered node.
          content: b.kind === 'prose' ? window.TipTap.proseContent(b) : (structuredSig[b.id] || ''),
        }
      })
      // seedBaseline includes EVERY id'd server block (even an empty one) so the
      // first edit to a loaded block is an update-block, never a duplicate create.
      blockContentCache = window.TipTap.seedBaseline
        ? window.TipTap.seedBaseline(triples)
        : {}
    }

    // syncDocument is the debounced wire send: granular block-ops only. There is
    // NO whole-document fallback — every WYSIWYG edit is a block-op over the WS
    // (prose via the observer; structured via their own channels + delete-block
    // here). Markdown mode keeps its own raw doc-update path, outside here. It
    // NEVER mutates the document — pure read + send.
    function syncDocument(ed, id) {
      var curr = collectTopBlocks(ed)
      if (!curr || !window.TipTap.computeBlockSync) return
      var r = window.TipTap.computeBlockSync(curr, blockContentCache)
      blockContentCache = r.next
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
        // trailingNode:true — caret contract clause 1 (no dead-ends): a
        // paragraph is guaranteed after a final structured block. The earlier
        // Gapcursor-only bet failed for non-atom read-only containers
        // (web-clip/ai-block) — see docs/editor-interaction-contract.md.
        T.StarterKit.configure({ document: false, link: false, codeBlock: false, trailingNode: true, history: { depth: 10000, newGroupDelay: 500 } }),
        T.Placeholder.configure({ placeholder: function (p) { return p.editor.isEmpty ? 'Start writing\u2026' : '' } }),
        T.BlockChrome,
        T.AiTargetDecoration,
        T.Table.configure({ resizable: false }),
        T.TableRow,
        T.TableHeader,
        T.TableCell,
        T.Search,
        // Shared keyboard policy (priority 50 — runs AFTER native keymaps like
        // list indent and table cell-nav; docs/editor-interaction-contract.md).
        // Per-renderer key handlers are forbidden; kinds declare interactionPolicy.
        T.buildInteractionPolicyExtension(T),

        T.AiBlockLegacy,
        T.Image.configure({ inline: false, allowBase64: true, HTMLAttributes: { class: 'editor-image' } }),
        T.HighlightMark,
        T.SelectionHighlight,
        T.Extension.create({
          name: 'sieveFocusPlugin',
          addProseMirrorPlugins: function () {
            return [
              new T.Plugin({
                props: {
                  decorations: function (state) {
                    var sel = state.selection
                    if (!sel) return T.DecorationSet.empty
                    var decos = []
                    if (sel.node && String(sel.node.type.name).indexOf('sieve-') === 0) {
                      decos.push(T.Decoration.node(sel.from, sel.to, { class: 'sieve-block--focused' }))
                    } else if (sel.$from) {
                      var $from = sel.$from
                      for (var d = $from.depth; d >= 0; d--) {
                        var node = $from.node(d)
                        if (node && String(node.type.name).indexOf('sieve-') === 0) {
                          decos.push(T.Decoration.node($from.before(d), $from.after(d), { class: 'sieve-block--focused' }))
                          break
                        }
                      }
                    }
                    return T.DecorationSet.create(state.doc, decos)
                  }
                }
              })
            ]
          }
        }),
      ].concat(window.SieveNativeCodeBlock ? [window.SieveNativeCodeBlock] : [])
       .concat(window.TipTap.ProseGroup ? [window.TipTap.ProseGroup] : [])
       .concat(T.getSieveNodes()).concat([
        T.TaskList,
        T.TaskItem.configure({ nested: true }),
        T.Markdown.configure({ html: true, transformPastedText: true, link: { openOnClick: false } }),
        T.AiShortcuts.configure({
          // Fire the same events as every other surface so the editor.js handler
          // runs identical business logic (target highlight + focus + run).
          onExplain: function () { document.dispatchEvent(new CustomEvent('sieve:ai-explain')) },
          onAsk: function () { document.dispatchEvent(new CustomEvent('sieve:ai-ask')) },
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

            // Range covered by the selection (a gutter block-range, a NodeSelection,
            // or a text range) — drives which blocks the loop below visits.
            var er = (window.TipTap && window.TipTap.getBlockSelectionRange)
              ? window.TipTap.getBlockSelectionRange(view)
              : { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false }

            var blockHTML = function (dom) {
              if (!dom) return ''
              var clone = dom.cloneNode(true)
              var ch = clone.querySelector('.block-chrome-host')
              if (ch) ch.remove()
              return clone.outerHTML
            }

            // selText returns the SELECTED portion of a node's text (so a partial
            // multi-block selection copies only the highlight).
            var selText = function (nodeFrom, nodeEnd) {
              var a = Math.max(er.from, nodeFrom), b = Math.min(er.to, nodeEnd)
              return b > a ? view.state.doc.textBetween(a, b, '\n') : ''
            }
            var escHtml = function (s) {
              return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            }
            // A block is partially selected when the (non-empty) selection cuts into
            // it. sieve/slice + sieve/<kind> always carry the WHOLE block (a block is
            // only meaningful whole); text/plain + text/html follow the selection.
            var partial = function (nodeFrom, nodeEnd) {
              return er.to > er.from && (er.from > nodeFrom || er.to < nodeEnd)
            }

            // Native DOM text highlight (once). A block's custom region (the log
            // Explore table) holds text PM does not own, so a highlight there
            // leaves PM's selection a whole-block NodeSelection — without this the
            // rich copy below would grab the ENTIRE block. text/plain + text/html
            // follow this highlight per-block (via domSelectionTextInside); the
            // sieve/slice + sieve/<kind> mimes stay whole-block (only-meaningful-whole).
            var domSel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null
            var domSelHtml = ''
            if (domSel && !domSel.isCollapsed && domSel.toString().trim()) {
              try {
                var frag = document.createElement('div')
                for (var dri = 0; dri < domSel.rangeCount; dri++) frag.appendChild(domSel.getRangeAt(dri).cloneContents())
                domSelHtml = frag.innerHTML
              } catch (e) {}

              // Re-target `er` when the highlight lives in a block's READ-ONLY
              // region (the ai-block question title, the log Explore table —
              // contentEditable=false DOM PM cannot track). There PM's selection
              // stays on whatever block last held the caret, so the loop below —
              // driven by `er` — would visit and copy the WRONG (previously
              // selected) block. domSelectionBlockRange finds the block the user
              // actually highlighted and points the loop at it; when PM already
              // owns the highlighted text (er covers it) it returns null and er is
              // left untouched.
              var blockDescs = []
              view.state.doc.forEach(function (node, offset) {
                if (String(node.type.name).indexOf('sieve-') === 0) {
                  blockDescs.push({ from: offset, to: offset + node.nodeSize, dom: view.nodeDOM(offset) })
                }
              })
              var retarget = window.TipTap.domSelectionBlockRange(domSel, er, blockDescs)
              if (retarget) {
                er = { from: retarget.from, to: retarget.to, active: true, isBlockRange: false, isNodeSelection: false }
              }
            }

            var sliceItems = []
            var plainParts = []
            var htmlParts = []
            var hasSieve = false
            var singleSieveEntries = null  // the framework ContentEntry array, if exactly one sieve block

            // sieve/slice is [][]ContentEntry — an ordered list of per-block entry
            // sets (a sequence of "normal pastes"), reconstructed server-side. Each
            // block contributes its FULL view set (sieve → framework views, prose →
            // its sieve/prose + text). text/plain + text/html follow the selection.
            var proseKind = window.TipTap.getBlockKind && window.TipTap.getBlockKind('prose')
            view.state.doc.forEach(function (node, offset) {
              var nodeEnd = offset + node.nodeSize
              if (nodeEnd <= er.from || offset >= er.to) return
              var dom = view.nodeDOM(offset)
              var entries
              if (String(node.type.name).indexOf('sieve-') === 0) {
                hasSieve = true
                entries = window.TipTap.sieveBlockEntries(node, window.TipTap.rendererFor(node.attrs.kind))
                singleSieveEntries = entries
              } else {
                entries = (proseKind && proseKind.asContentEntry && proseKind.asContentEntry(node, currentEditor)) || []
              }
              sliceItems.push(entries)

              var pick = function (mime) {
                for (var vi = 0; vi < entries.length; vi++) {
                  if (entries[vi].mimeType === mime && entries[vi].content) return entries[vi].content
                }
                return null
              }
              // A native DOM highlight INSIDE this block's custom region (log
              // Explore table) → text/plain + text/html follow it, even though PM
              // sees the whole block selected. (sliceItems already holds the full
              // block above.)
              var domInBlock = window.TipTap.domSelectionTextInside(domSel, dom)
              if (domInBlock) {
                plainParts.push(domInBlock)
                htmlParts.push(domSelHtml || escHtml(domInBlock))
              } else if (partial(offset, nodeEnd)) {
                // Cut by the PM selection → just the highlighted text.
                plainParts.push(selText(offset, nodeEnd))
                htmlParts.push(escHtml(selText(offset, nodeEnd)))
              } else {
                // Whole block / bare cursor → the block's full text + html views.
                plainParts.push(pick('text/plain') || node.textContent || (dom ? dom.innerText : ''))
                htmlParts.push(pick('text/html') || blockHTML(dom))
              }
            })

            if (!hasSieve) return false   // pure prose → native PM copy

            // Every sieve-involving copy is served HERE — never deferred to native
            // PM copy. A sub-text selection used to fall through to native, but a
            // slice inside a `defining`/`code` block (code, diagram, log-raw)
            // re-wraps the WHOLE node, so native copied the entire block. Instead
            // the loop above already put the SELECTION into text/plain + text/html
            // (per-block, via the DOM highlight or the PM range) while sieve/slice +
            // sieve/<kind> carry the whole block — one uniform rule, every kind.
            event.preventDefault()
            event.clipboardData.setData('text/plain', plainParts.filter(Boolean).join('\n\n'))
            event.clipboardData.setData('text/html', htmlParts.filter(Boolean).join('\n'))
            event.clipboardData.setData('sieve/slice', JSON.stringify(sliceItems))
            // Single sieve block → also expose every mime in its framework ContentEntry
            // array (custom views like text/uri-list + the sieve/<kind> view), so a
            // cross-context paste lands on the same backend matchers as extraction.
            if (sliceItems.length === 1 && sliceItems[0]._type === 'sieve' && singleSieveEntries) {
              singleSieveEntries.forEach(function (en) { event.clipboardData.setData(en.mimeType, en.content) })
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
          // Enter family routes through the interaction policy FROM HERE
          // (pre-core: TipTap's core Keymap would otherwise consume Enter in
          // code:true blocks). Returns false in every context the policy
          // does not own, so native prose/list/table Enter is untouched.
          if (event.key === 'Enter' && window.TipTap.policyEnterKeydown &&
              window.TipTap.policyEnterKeydown(view, event)) {
            return true
          }
          // Tab/Shift+Tab are owned by the interaction-policy extension
          // (docs/editor-interaction-contract.md) — never handle them here:
          // editorProps runs BEFORE extension keymaps and would shadow
          // list indent and table cell navigation (that was defect #6).
          // Block-insertion chords (Mod+Shift+W/L/D) are owned by the native
          // menu (App-Level Chords); the editor no longer binds them.
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
        // syncDocument, which emits granular block-ops (id-less nodes are
        // skipped until minted — no whole-document fallback).
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

    // Baseline a server-created block (by id) into the sync cache so the thin
    // observer sees it as already-present and never re-creates it. Derived from the
    // rendered node so its signature matches topBlockTriple exactly.
    noteServerBlock = function (id) {
      if (!blockContentCache || !id) return
      var found = null
      editor.state.doc.forEach(function (node) {
        if (!found && node.attrs && node.attrs.id === id) found = node
      })
      if (!found) return
      var seed = window.TipTap.seedBaseline ? window.TipTap.seedBaseline([topBlockTriple(editor, found)]) : null
      if (seed) for (var k in seed) blockContentCache[k] = seed[k]
    }

    // reconcilePendingToken swaps a pending prose node's token baseline for the backend
    // id in the sync cache (a flight-edit then surfaces as update-block by the real id;
    // the token key never reads as a delete). A falsy id = the node was deleted while its
    // create was in flight → just drop the stale token key (the delete-by-real-id already
    // went over the WS; the delete loop skips tok- keys regardless, this is hygiene).
    reconcilePendingToken = function (token, id) {
      if (!blockContentCache) return
      if (!id) { delete blockContentCache[token]; return }
      if (token in blockContentCache) {
        blockContentCache[id] = blockContentCache[token]
        delete blockContentCache[token]
      } else {
        noteServerBlock(id)
      }
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
      if (msg.type === 'replace-block') {
        document.dispatchEvent(new CustomEvent('editor:replace-block', { detail: msg }))
      }
      if (msg.type === 'block-extracted') {
        // The new block renders via insert-block (tracked insert at its index). Nothing to do.
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
    if (!currentUuid || !e.detail.id) return
    wsSend({ type: 'block-op', uuid: currentUuid, op: window.TipTap.updateBlockOp(e.detail) })
  })

  document.addEventListener('editor:insert-block', function (e) {
    var msg = e.detail
    if (currentMode === 'markdown' && currentMarkdownTextarea) {
      sieveInsertPos = null
      lastSyncedBody = lastSyncedBody.trim() + '\n\n' + (msg.markdown || '') + '\n'
      currentMarkdownTextarea.value = lastSyncedBody
      wsSend({ type: 'doc-update', uuid: currentUuid, markdown: lastSyncedBody })
      return
    }
    if (!currentEditor) return
    // Backend-authoritative prose id (B-A): the create carried a transient token and no
    // durable id; Go minted the id and echoed the token. Swap the pending node's token
    // for the authoritative id (tracked, history-EXCLUDED — never a re-insert), reconcile
    // the sync cache, and DO NOT insert (the node already exists — the user typed it).
    if (msg.token) {
      var ed = currentEditor, foundPos = -1
      ed.state.doc.forEach(function (node, pos) {
        if (foundPos < 0 && node.attrs && node.attrs.token === msg.token) foundPos = pos
      })
      if (foundPos >= 0) {
        var pendingNode = ed.state.doc.nodeAt(foundPos)
        var tr = ed.state.tr.setNodeMarkup(foundPos, undefined,
          Object.assign({}, pendingNode.attrs, { id: msg.id, token: '' }))
        tr.setMeta('addToHistory', false)
        ed.view.dispatch(tr)
        if (typeof reconcilePendingToken === 'function') reconcilePendingToken(msg.token, msg.id)
      } else {
        // Deleted while the create was in flight — Go has a block we can't see. Delete it
        // by the authoritative id, then drop the stale token baseline (falsy id sentinel).
        wsSend({ type: 'block-op', uuid: currentUuid, op: { type: 'delete-block', blockId: msg.id } })
        if (typeof reconcilePendingToken === 'function') reconcilePendingToken(msg.token, null)
      }
      return
    }
    var parsed = msg.attrs || {}
    var kind = msg.kind || 'code'

    // Insert position: the op's index (echoed on the message) is the document
    // position — robust for a batch (a paste slice renders many blocks in order).
    // A numeric sieveInsertPos is still used by AI-block creates (which set a raw
    // editor position before the WS round-trip). In-place transforms now use the
    // dedicated editor:replace-block handler; replaceRange is retired.
    var numericPos = (typeof sieveInsertPos === 'number') ? sieveInsertPos : null
    sieveInsertPos = null

    // Insert-if-absent: the backend creates EVERY kind through the one lifecycle and
    // render-backs uniformly — including prose, whose node the editor already holds
    // (the user typed it). "Does the editor have this node?" is the client's concern,
    // not the backend's: if a node with this id is already in the doc, the echo is
    // redundant — baseline it so the observer never re-creates it, then skip the
    // insert (a second insert would duplicate the paragraph).
    var echoedId = msg.id || parsed.id
    if (echoedId && currentEditor.view.dom.querySelector('[data-id="' + echoedId + '"]')) {
      if (typeof noteServerBlock === 'function') noteServerBlock(echoedId)
      return
    }

    // Prose IS a block: render the server-created block (prose or structured) to its
    // editor node(s) through the SAME path the document load uses (id-stamped) —
    // never a hand-built node, never a sieve-<kind> assumption.
    var blk = { id: msg.id || parsed.id, kind: kind, attrs: Object.assign({ id: msg.id || parsed.id }, parsed) }
    var content = blockToNodes(currentEditor, blk).map(function (n) { return n.toJSON() })
    if (!content.length) return

    if (typeof msg.index === 'number') {
      currentEditor.commands.insertContentAt(docPosForBlockIndex(currentEditor, msg.index), content)
    } else {
      currentEditor.commands.insertContentAt(numericPos !== null ? numericPos : currentEditor.state.doc.content.size, content)
    }

    // A server-created block is authoritative (carries the backend id) — baseline it
    // so the observer never re-creates it (prose especially, which it otherwise owns).
    if (typeof noteServerBlock === 'function') noteServerBlock(msg.id || parsed.id)

    if (!parsed.source && (msg.kind === 'code' || msg.kind === 'diagram')) {
      setTimeout(function () {
        var el = document.querySelector('[data-id="' + (msg.id || parsed.id) + '"] .sieve-block__edit')
        if (el) el.focus()
      }, 50)
    } else if (msg.kind !== 'ai-block') {
      // Anything else the user just inserted (image, web-clip, card, …): return focus
      // to the editor with the caret AFTER the new block so they can keep typing. (A
      // file dialog / toolbar click leaves focus elsewhere; code/diagram focus their own
      // edit surface above; async AI answers intentionally never steal focus.)
      setTimeout(function () {
        if (!currentEditor) return
        var doc = currentEditor.state.doc
        var idxAfter = window.TipTap.blockIndexAfter(doc, msg.id || parsed.id)
        if (idxAfter < 0) { currentEditor.commands.focus(); return }
        var pos = window.TipTap.docPosForBlockIndex(doc, idxAfter)
        currentEditor.chain().focus().setTextSelection(Math.min(pos, currentEditor.state.doc.content.size)).run()
      }, 60)
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

  // ── Replace block (in-place TRANSFORM render-back) ──────────────────────────
  // Tracked replace-by-id: swap the node carrying oldId with the server's new node.
  // A normal insertContentAt(range, ...) is undoable (and the observer propagates an
  // undo to the backend). Markdown mode is breakglass → full reload is acceptable there.
  document.addEventListener('editor:replace-block', function (e) {
    var msg = e.detail
    if (currentMode === 'markdown') { softReloadContent(currentUuid); return }
    if (!currentEditor) return
    var oldId = msg.oldId
    var newId = msg.newId || oldId
    var kind = msg.newKind || 'prose'
    var parsed = msg.attrs || {}

    var range = null
    currentEditor.state.doc.descendants(function (node, pos) {
      if (range) return false
      if (node.attrs && node.attrs.id === oldId) { range = { from: pos, to: pos + node.nodeSize }; return false }
    })
    if (!range) return

    var blk = { id: newId, kind: kind, attrs: Object.assign({ id: newId }, parsed) }
    var content = blockToNodes(currentEditor, blk).map(function (n) { return n.toJSON() })
    if (!content.length) return

    currentEditor.commands.insertContentAt(range, content) // tracked → undoable
    if (typeof noteServerBlock === 'function') noteServerBlock(newId)

    setTimeout(function () {
      var node = document.querySelector('[data-id="' + newId + '"]')
      if (node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 60)
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

  function getMarkdown() {
    // Markdown mode is the verbatim buffer. In WYSIWYG the frontend does NOT
    // serialise the document (Go owns markdown, derived from the tree); callers
    // here (stats, prompt save) only need a plain-text view, so use the editor's
    // own text — never a frontend-built markdown document.
    if (currentMode === 'markdown') return lastSyncedBody
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
        if (currentMode === 'wysiwyg' && currentEditor) {
          // Wysiwyg renders the backend's AUTHORITATIVE block list — markdown is
          // NOT a wysiwyg render input. A flat setContent(body) re-parse ignores
          // block boundaries and invents ids, fragmenting a multi-node prose block
          // and losing its id (the embed bug). The doc structure + every id come
          // from data.blocks; renderBlocksIntoEditor + proseBlockNodes wrap a multi-
          // node block into ONE container carrying its id. (Per-block prose content
          // is still markdown, but rendered WITHIN its own block by the block list —
          // it never crosses a boundary.) No setContent fallback: there is no
          // markdown render path for wysiwyg.
          renderBlocksIntoEditor(currentEditor, data.blocks || [], { allowEmpty: true })
          lastSyncedBody = body
          aiReloadInProgress = false
          if (window.TipTap && window.TipTap.restoreFocusContext) {
            window.TipTap.restoreFocusContext(currentEditor, fctx)
          }
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
      // Flush any pending block-sync so Go's shadow is current, then let the
      // backend derive the markdown: the enter-markdown round-trip below returns
      // `markdown-content` (ContentForSave over the tree), which replaces
      // lastSyncedBody. The frontend never serialises the document itself.
      if (docSyncFlush) docSyncFlush()
      content = ''
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
      wsSend({ type: 'extract', blockId: blockId, targetKind: targetKind, operation: operation, entries: resolved, index: index })
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
